import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { recordAuditLogSafe, auditEventTypes } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  runDistillationCompletion,
  resolveDistillationModel,
  type DistillationProviderSetting,
  type DistillationRuntimeToolDefinition,
  type DistillationToolExecutor,
} from "../distillation/distillation-runtime.service.js";
import { readVibeMemoryByTokenWindow } from "../memoryReader/reader.service.js";
import { readFileDomain } from "../readFile/domain.js";
import { getDistillationTargetStateById } from "../selectDistillationTarget/repository.js";
import { parseStorageCandidatesFromLlmOutput } from "./parser.js";
import {
  insertFindCandidateResult,
  type CandidateOrigin,
  type CandidateRecord,
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

function parseToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
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
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

function systemPrompt(): string {
  return [
    "あなたの仕事は文章 content だけを見て、有用な知識候補を選ぶことです。",
    "候補選出以外のことはしないでください。",
    "厳守ルール:",
    "- 1候補 = 1知識（1ルール または 1手続き）",
    "- 複数のルール/手続きを1候補に混ぜない",
    "- 文書全体をそのまま1候補にしない",
    "- 複数の有用知識がある場合は候補を分割して複数出す",
    "- 候補件数は内容に応じて決める。件数合わせはしない",
    "最終出力は JSON のみで、次の形だけを返してください:",
    '{"candidates":[{"title":"...","content":"..."}]}',
    "候補がない場合は必ず次を返してください:",
    '{"candidates":[]}',
    "title/content 以外の field を返さないでください。",
  ].join("\n");
}

function userPrompt(): string {
  return [
    "まず tool で本文を読んでください。",
    "必要なら複数回読み、最終的に JSON だけを返してください。",
    "候補は必ず知識単位で分割してください（1候補=1ルール or 1手続き）。",
  ].join("\n");
}

export function formatCliTextCandidates(candidates: CandidateRecord[]): string {
  if (candidates.length === 0) return "NO_CANDIDATE";
  return candidates
    .map((candidate) => `TITLE: ${candidate.title}\nCONTENT:\n${candidate.content}`)
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

    const completion = await runDistillationCompletion(
      {
        model,
        maxTokens: candidateOutputMaxTokens(),
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt() },
        ],
      },
      {
        providerSetting: provider,
        toolDefinitions: [toolDefinition],
        toolExecutor,
        enableTools: true,
        maxToolRounds: readLimit,
        requireToolCall: true,
        requireToolCallReminder: [
          "まだ本文を読んでいません。",
          "まず提供された reader tool を呼び出して本文 content を読んでください。",
          "その後に候補のみを返してください。",
        ],
        blankResponseReminder: [
          '空の応答です。{"candidates":[]} または {"candidates":[{"title":"...","content":"..."}]} を返してください。',
        ],
        signal: input.signal,
      },
    );

    if (readLog.length === 0) {
      throw new Error("findCandidate reader tool was not used");
    }
    llmOutput = completion.content.trim();
    candidates = parseStorageCandidatesFromLlmOutput(llmOutput);

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateReaderUsed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        readCount: readLog.length,
        readRanges: readLog,
      },
    });

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
