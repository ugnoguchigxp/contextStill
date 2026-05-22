import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  type DistillationMessage,
  type DistillationProviderSetting,
  type DistillationRuntimeToolDefinition,
  type DistillationToolExecutor,
  resolveDistillationModel,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationToolCall } from "../distillation/distillation-tools.service.js";
import { readVibeMemoryByTokenWindow } from "../memoryReader/reader.service.js";
import { readFileDomain } from "../readFile/domain.js";
import { getDistillationTargetStateById } from "../selectDistillationTarget/repository.js";
import { parseStorageCandidatesFromLlmOutput } from "./parser.js";
import {
  type CandidateOrigin,
  type CandidateRecord,
  insertFindCandidateResult,
} from "./repository.js";

export type FindCandidateCallerMode = "cli_text" | "storage";

export type FindCandidateInput = {
  targetStateId: string;
  provider?: DistillationProviderSetting;
  callerMode?: FindCandidateCallerMode;
  fromToken?: number;
  readTokens?: number;
  wikiMinify?: boolean;
  memoryReaderMode?: "compressed" | "original";
  maxReads?: number;
  signal?: AbortSignal;
};

export type FindCandidateResult = {
  targetStateId: string;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  callerMode: FindCandidateCallerMode;
  candidates: CandidateRecord[];
  insertedIds?: string[];
  readRanges: Array<{ from: number; toExclusive: number }>;
};

type FindCandidateTargetKind = FindCandidateResult["targetKind"];

function parseToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function maxReads(input: FindCandidateInput): number {
  return Math.max(
    1,
    Math.min(20, Math.floor(input.maxReads ?? groupedConfig.distillationTools.readerMaxReads)),
  );
}

function readTokens(input: FindCandidateInput): number {
  return Math.max(1, Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens));
}

function candidateOutputMaxTokens(): number {
  return Math.max(4096, groupedConfig.vibeDistillation.maxOutputTokens);
}

function defaultFindCandidateProvider(
  targetKind: "wiki_file" | "vibe_memory",
): DistillationProviderSetting {
  if (targetKind === "wiki_file") {
    return "azure-openai";
  }
  return "local-llm";
}

function buildToolDefinitionForTarget(
  targetKind: "wiki_file" | "vibe_memory",
): DistillationRuntimeToolDefinition {
  if (targetKind === "wiki_file") {
    return {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read more content from the current document by token window. Use only when additional content is required.",
        parameters: {
          type: "object",
          properties: {
            fromToken: { type: "number", description: "Start token offset (0-based)." },
            readTokens: { type: "number", description: "Token length to read." },
            minify: { type: "boolean", description: "Whether to use compressed text." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    };
  }

  return {
    type: "function",
    function: {
      name: "memory_reader",
      description:
        "Read more content from the current vibe memory by token window. Use only when additional content is required.",
      parameters: {
        type: "object",
        properties: {
          fromToken: { type: "number", description: "Start token offset (0-based)." },
          readTokens: { type: "number", description: "Token length to read." },
          mode: {
            type: "string",
            description: "Reader mode: compressed or original.",
            enum: ["compressed", "original"],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

function commonCandidateRules(): string[] {
  return [
    "厳守ルール:",
    "- 1候補 = 1知識（1ルール または 1手続き）",
    "- 複数のルール/手続きを1候補に混ぜない",
    "- ただし 1 つの再利用可能な手順・運用フロー・レビュー手順は、細切れの rule に分けず 1 つの procedure 候補にまとめる",
    "- 文書全体をそのまま1候補にしない",
    "- 複数の有用知識がある場合は候補を分割して複数出す",
    "- type は必ず rule または procedure にする",
    "- rule は持続的な制約・方針・不変条件・意思決定",
    "- procedure は順序付き作業、コマンドフロー、検証/復旧/レビューの再利用可能な手順",
    "- 単独の判断、制約、使うべき API/コマンド、避けるべき実装方針は procedure ではなく rule",
    "- procedure は 2 step 以上の workflow と成功確認まで書ける候補だけにする",
    "- procedure の content には、最終工程で SKILL.md 風に展開できるよう、使う場面・順序・確認方法・避けることの根拠を含める",
    "- 候補件数は内容に応じて決める。件数合わせはしない",
    "最終出力は JSON のみで返してください。",
    "候補がある場合は単体オブジェクトまたは配列のどちらでも構いません。",
    '{"type":"rule|procedure","title":"...","content":"..."}',
    '[{"type":"rule|procedure","title":"...","content":"..."}]',
    "候補がない場合は [] を返してください。",
    "必須 field を増やさず、type/title/content 以外は省略してください。",
  ];
}

function wikiSystemPrompt(): string {
  return [
    "あなたの仕事は文章 content だけを見て、有用な知識候補を選ぶことです。",
    "候補選出以外のことはしないでください。",
    ...commonCandidateRules(),
  ].join("\n");
}

function vibeMemorySystemPrompt(): string {
  return [
    "あなたの仕事は vibe memory の content と agent diff だけを見て、再利用可能な知識候補を選ぶことです。",
    "system/user prompt、tool 名、JSON schema、進行報告だけの会話文は知識候補にしないでください。",
    "vibe memory は作業ログなので、永続的なルール、再利用できる手順、レビュー観点、復旧手順、リポジトリ固有の運用知だけを候補にしてください。",
    "単なる一回限りの実行結果、途中経過、感想、明らかに古い仮説、未確認の推測は候補にしないでください。",
    "agent diff がある場合は、diff から読み取れる実装上の不変条件や手順だけを候補にしてください。",
    "追加情報が必要な場合だけ memory_reader tool を使って次の token window を読んでください。",
    ...commonCandidateRules(),
  ].join("\n");
}

function systemPromptForTarget(targetKind: FindCandidateTargetKind): string {
  return targetKind === "vibe_memory" ? vibeMemorySystemPrompt() : wikiSystemPrompt();
}

function wikiUserPrompt(): string {
  return [
    "まず tool で本文を読んでください。",
    "必要なら複数回読み、最終的に JSON だけを返してください。",
    "候補は必ず知識単位で分割してください（1候補=1ルール or 1手続き）。",
    "手順・運用フロー・レビュー手順・コマンド列は procedure として返してください。",
  ].join("\n");
}

function vibeMemoryInitialUserPrompt(): string {
  return [
    "これから memory_reader tool で最初の vibe memory window を読みます。",
    "tool result に含まれる memory content と diff だけを source として扱ってください。",
    "この user prompt や system prompt の文言を候補化しないでください。",
  ].join("\n");
}

function vibeMemoryAfterInitialReadPrompt(): string {
  return [
    "上の memory_reader tool result を評価してください。",
    "追加の window が必要なら memory_reader を呼び出してください。",
    "十分なら、候補 JSON だけを返してください。",
    "候補がなければ [] を返してください。",
  ].join("\n");
}

function buildInitialUserMessages(targetKind: FindCandidateTargetKind): DistillationMessage[] {
  return [
    {
      role: "user",
      content: targetKind === "vibe_memory" ? vibeMemoryInitialUserPrompt() : wikiUserPrompt(),
    },
  ];
}

function buildInitialVibeMemoryToolCall(input: FindCandidateInput): DistillationToolCall {
  const mode = input.memoryReaderMode ?? "compressed";
  return {
    id: "initial-memory-reader",
    type: "function",
    function: {
      name: "memory_reader",
      arguments: JSON.stringify({
        fromToken: Math.max(0, Math.floor(input.fromToken ?? 0)),
        readTokens: readTokens(input),
        mode,
      }),
    },
  };
}

export function formatCliTextCandidates(candidates: CandidateRecord[]): string {
  if (candidates.length === 0) return "NO_CANDIDATE";
  return candidates
    .map((candidate) =>
      [
        ...(candidate.type ? [`TYPE: ${candidate.type}`] : []),
        `TITLE: ${candidate.title}`,
        `CONTENT:\n${candidate.content}`,
      ].join("\n"),
    )
    .join("\n---\n");
}

export async function runFindCandidate(input: FindCandidateInput): Promise<FindCandidateResult> {
  const targetStateId = input.targetStateId.trim();
  if (!targetStateId) {
    throw new Error("targetStateId is required");
  }

  const target = await getDistillationTargetStateById(targetStateId);
  if (!target) {
    throw new Error(`distillation target state not found: ${targetStateId}`);
  }

  if (target.targetKind !== "wiki_file" && target.targetKind !== "vibe_memory") {
    throw new Error(`unsupported target kind for findCandidate: ${target.targetKind}`);
  }

  const callerMode = input.callerMode ?? "cli_text";
  const provider = input.provider ?? defaultFindCandidateProvider(target.targetKind);
  const model = resolveDistillationModel(provider);
  const toolDefinition = buildToolDefinitionForTarget(target.targetKind);
  const readLog: Array<{ from: number; toExclusive: number }> = [];
  const readLimit = maxReads(input);
  let reads = 0;

  const toolExecutor: DistillationToolExecutor = async (toolCall) => {
    const args = parseToolArgs(toolCall.function.arguments);
    if (reads >= readLimit) {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: `read limit exceeded (${readLimit})`,
      };
    }

    if (target.targetKind === "wiki_file") {
      if (toolCall.function.name !== "read_file") {
        return {
          callId: toolCall.id,
          name: toolCall.function.name,
          ok: false,
          content: "",
          error: "unknown tool",
        };
      }

      const result = await readFileDomain({
        path: target.targetKey,
        fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
        readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
        minify: asBool(args.minify, input.wikiMinify ?? true),
      });
      reads += 1;
      readLog.push({ from: result.from, toExclusive: result.toExclusive });
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: result.content,
      };
    }

    if (toolCall.function.name !== "memory_reader") {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: "unknown tool",
      };
    }

    const modeRaw = typeof args.mode === "string" ? args.mode.trim() : "";
    const mode =
      modeRaw === "original" || modeRaw === "compressed"
        ? modeRaw
        : (input.memoryReaderMode ?? "compressed");
    const result = await readVibeMemoryByTokenWindow({
      vibeMemoryId: target.targetKey,
      fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
      readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
      mode,
    });
    reads += 1;
    readLog.push({ from: result.from, toExclusive: result.toExclusive });
    return {
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: result.content,
    };
  };

  await recordAuditLogSafe({
    eventType: auditEventTypes.findCandidateStarted,
    actor: "system",
    payload: {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      provider,
      callerMode,
    },
  });

  try {
    let llmOutput = "";
    let candidates: CandidateRecord[] = [];
    let readerUsedRecorded = false;

    const recordReaderUsed = async (metadata: Record<string, unknown> = {}) => {
      if (readerUsedRecorded || readLog.length === 0) return;
      readerUsedRecorded = true;
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateReaderUsed,
        actor: "system",
        payload: {
          targetStateId: target.id,
          readCount: readLog.length,
          readRanges: readLog,
          ...metadata,
        },
      });
    };

    const messages: DistillationMessage[] = [
      { role: "system", content: systemPromptForTarget(target.targetKind) },
      ...buildInitialUserMessages(target.targetKind),
    ];

    if (target.targetKind === "vibe_memory") {
      const initialToolCall = buildInitialVibeMemoryToolCall(input);
      const initialToolResult = await toolExecutor(initialToolCall);
      if (!initialToolResult.ok) {
        throw new Error(initialToolResult.error ?? "initial memory_reader failed");
      }
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [initialToolCall],
        },
        {
          role: "tool",
          tool_call_id: initialToolCall.id,
          name: initialToolResult.name,
          content: initialToolResult.content,
        },
        {
          role: "user",
          content: vibeMemoryAfterInitialReadPrompt(),
        },
      );
      await recordReaderUsed({ initialRead: true, reader: "memory_reader" });
    }

    const completion = await runDistillationCompletion(
      {
        model,
        maxTokens: candidateOutputMaxTokens(),
        messages,
      },
      {
        providerSetting: provider,
        toolDefinitions: [toolDefinition],
        toolExecutor,
        usageSource: "find-candidate",
        enableTools: reads < readLimit,
        maxToolRounds: Math.max(0, readLimit - reads),
        requireToolCall: target.targetKind === "wiki_file",
        requireToolCallReminder: [
          "まだ本文を読んでいません。",
          "まず提供された reader tool を呼び出して本文 content を読んでください。",
          "その後に候補のみを返してください。",
        ],
        blankResponseReminder: [
          '空の応答です。[] または {"type":"rule|procedure","title":"...","content":"..."} を返してください。',
        ],
        signal: input.signal,
      },
    );

    if (readLog.length === 0) {
      throw new Error("findCandidate reader tool was not used");
    }
    llmOutput = completion.content.trim();
    candidates = parseStorageCandidatesFromLlmOutput(llmOutput);

    await recordReaderUsed();

    if (callerMode === "cli_text") {
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateCompleted,
        actor: "system",
        payload: {
          targetStateId: target.id,
          candidateCount: candidates.length,
          readCount: readLog.length,
        },
      });

      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        callerMode,
        candidates,
        readRanges: readLog,
      };
    }

    const origin: CandidateOrigin = {
      readRanges: readLog,
    };

    const insertedIds: string[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const saved = await insertFindCandidateResult({
        targetStateId: target.id,
        candidateIndex: index,
        candidate,
        origin,
      });
      insertedIds.push(saved.id);
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateCompleted,
      actor: "system",
      payload: {
        targetStateId: target.id,
        candidateCount: candidates.length,
        insertedCount: insertedIds.length,
      },
    });

    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      callerMode,
      candidates,
      insertedIds,
      readRanges: readLog,
    };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateFailed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runFindCandidateSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  return {
    domain: "findCandidate",
    implemented: false,
    status: "prepared",
    checkedAt: new Date().toISOString(),
    message:
      "findCandidate domain smoke remains scaffold-only. Use find-candidate CLI for runtime.",
    receivedInput: input,
    nextContracts: [
      "findCandidate runtime is implemented via runFindCandidate",
      "coverEvidence and finalizeDistille runtimes are available as downstream stages",
      "distill-domain smoke will be replaced after all domains migrate",
    ],
  };
}
