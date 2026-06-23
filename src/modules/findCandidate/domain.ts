import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  type DistillationMessage,
  type DistillationProviderSetting,
  type DistillationRuntimeToolDefinition,
  type DistillationToolExecutor,
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationToolCall } from "../distillation/distillation-tools.service.js";
import {
  buildBoundedSourceWindows,
  deterministicSemanticChunksFromWindows,
  type BoundedSourceWindow,
  type SemanticChunk,
  validateSemanticChunks,
} from "../distillation/source-window.js";
import { getDistillationTargetStateById } from "../distillationTarget/repository.js";
import { readVibeMemoryByTokenWindow } from "../memoryReader/reader.service.js";
import { readFileDomain } from "../readFile/domain.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveFindCandidateRoute,
} from "../settings/settings.service.js";
import {
  type StorageCandidateParseDiagnostics,
  parseStorageCandidatesWithDiagnostics,
} from "./parser.js";
import {
  type CandidateOrigin,
  type CandidateRecord,
  insertFindCandidateResult,
} from "./repository.js";

export type FindCandidateCallerMode = "cli_text" | "storage";

export type FindCandidateSourceInput = {
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  metadata?: Record<string, unknown>;
};

export type FindCandidateInput = {
  targetStateId?: string;
  sourceInput?: FindCandidateSourceInput;
  provider?: DistillationProviderSetting;
  callerMode?: FindCandidateCallerMode;
  fromToken?: number;
  readTokens?: number;
  wikiMinify?: boolean;
  memoryReaderMode?: "compressed" | "original";
  maxReads?: number;
  writeEpisode?: boolean;
  signal?: AbortSignal;
};

export type FindCandidateResult = {
  targetStateId: string | null;
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest";
  targetKey: string;
  callerMode: FindCandidateCallerMode;
  candidates: CandidateRecord[];
  insertedIds?: string[];
  readRanges: Array<{ from: number; toExclusive: number }>;
  parseDiagnostics?: StorageCandidateParseDiagnostics;
};

type FindCandidateTargetKind = FindCandidateResult["targetKind"];
type FindCandidateTarget = {
  id: string | null;
  targetKind: FindCandidateTargetKind;
  targetKey: string;
  sourceUri: string;
  metadata: Record<string, unknown>;
};

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
    Math.min(
      64,
      Math.floor(input.maxReads ?? groupedConfig.distillationTools.findCandidateMaxToolCalls),
    ),
  );
}

function readTokens(input: FindCandidateInput): number {
  return Math.max(1, Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens));
}

function candidateOutputMaxTokens(): number {
  return Math.max(4096, groupedConfig.vibeDistillation.maxOutputTokens);
}

function isToolLoopMaxRoundsError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("distillation tool loop exceeded max rounds")
  );
}

function normalizeFindCandidateFailure(params: {
  error: unknown;
  readCount: number;
  readLimit: number;
}): Error {
  if (isToolLoopMaxRoundsError(params.error) && params.readCount > 0) {
    return new Error(
      `findCandidate evidence_not_found: exhausted ${params.readCount}/${params.readLimit} reader tool calls without producing a final candidate response`,
      { cause: params.error },
    );
  }
  return params.error instanceof Error ? params.error : new Error(String(params.error));
}

async function defaultFindCandidateRoute(targetKind: FindCandidateTargetKind): Promise<{
  provider: DistillationProviderSetting;
  model: string;
  fallback: Array<Exclude<DistillationProviderSetting, "auto">>;
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
}> {
  await ensureRuntimeSettingsLoaded();
  const route = resolveFindCandidateRoute(targetKind);
  return {
    provider: route.provider as DistillationProviderSetting,
    model: route.model ?? "",
    fallback: [...route.fallback] as Array<Exclude<DistillationProviderSetting, "auto">>,
    azureDeploymentSlots: route.azureDeploymentSlots ? [...route.azureDeploymentSlots] : undefined,
    localLlmModel: route.localLlmModel,
  };
}

function buildToolDefinitionForTarget(
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest",
): DistillationRuntimeToolDefinition {
  if (targetKind === "wiki_file" || targetKind === "web_ingest") {
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
    "- polarity は必ず positive または negative のどちらかにする",
    "- type または polarity を判断できない場合、その候補は出さない",
    "- positive は「行うべき・有効だった・採用しやすい知識」、negative は「避けるべき・失敗した・採用すると危険な知識」として使う",
    "- 失敗事例、レビュー指摘、禁止事項、誤った実装方針、再発防止の判断基準は、内容が再利用可能なら negative の rule 候補として出す",
    "- negative 候補は procedure にせず、必ず rule として「何を避けるか / どの条件で危険か / どう確認するか」を書く",
    "- rule は持続的な制約・方針・不変条件・意思決定",
    "- procedure は順序付き作業、コマンドフロー、検証/復旧/レビューの再利用可能な手順",
    "- 単独の判断、制約、使うべき API/コマンド、避けるべき実装方針は procedure ではなく rule",
    "- procedure は 2 step 以上の workflow と成功確認まで書ける候補だけにする",
    "- procedure の content は SKILL.md 風の手順本文として、Use when: / Workflow: / Verification: / Avoid: の見出しをこの順に必ず含める",
    "- Workflow: には 2 step 以上の具体的な手順を書き、Verification: には成功確認、Avoid: には避けることを書く",
    "- source content からこの skill 形式を構成できない場合は、procedure ではなく rule にするか候補にしない",
    "- 候補の title/content は、汎用的に使える知識として体裁を整える",
    "- 候補件数は内容に応じて決める。件数合わせはしない",
    "最終出力は JSON のみで返してください。",
    "候補がある場合は単体オブジェクトまたは配列のどちらでも構いません。",
    '{"type":"rule|procedure","polarity":"positive|negative","title":"...","content":"..."}',
    '[{"type":"rule|procedure","polarity":"positive|negative","title":"...","content":"..."}]',
    "候補がない場合は [] を返してください。",
    "type/polarity/title/content 以外の field は省略してください。",
  ];
}

function reusableKnowledgeSignals(): string[] {
  return [
    "候補化してよい signal:",
    "- ユーザーが明示した継続的な好み、作業境界、禁止事項、優先順位",
    "- 失敗原因、修正方法、検証方法が source から読み取れる再利用可能なトラブルシュート",
    "- 特定の repo/module/tool で繰り返し使える調査順序、コマンド順序、復旧手順",
    "- diff や tool output から確認できる実装上の不変条件、API 契約、設定上の注意",
    "- レビューで見つかった再発しやすい落とし穴と、それを避けるための具体的な判断基準",
    "- source が完成済み rule/procedure 形式でなくても、作業ログから適用条件・操作順序・検証・回避条件が読み取れるもの",
    "- source に negative と明示されていなくても、ユーザーが否定した方針、レビューで退けられた実装、再発防止の禁止条件",
    "候補化しないもの:",
    "- 単なる進捗報告、作業中の感想、未検証の仮説、1回限りの成功/失敗",
    "- source に根拠がない一般論、source content をそのまま要約しただけの文書断片",
    "- tool 名、JSON schema、system/user prompt の文言そのもの",
    "会話ログでも、上の signal が source に含まれる場合は [] にせず候補化してください。",
    "ただし source にない事実は補完せず、形式が未整形な場合でも evidence から読み取れる範囲だけを候補化してください。",
  ];
}

function wikiSystemPrompt(): string {
  return [
    "あなたの仕事は文章 content だけを見て、有用な知識候補を選ぶことです。",
    "候補選出以外のことはしないでください。",
    ...reusableKnowledgeSignals(),
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
    "ただし、会話が進捗報告中心でも、最終的に原因・修正・検証・ユーザーの継続的な preference が確認できる場合は候補化してください。",
    "追加情報が必要な場合だけ memory_reader tool を使って次の token window を読んでください。",
    ...reusableKnowledgeSignals(),
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
    "原因・修正・検証・ユーザーの継続的 preference・repo 固有の運用手順が含まれる場合は、進捗会話をそのまま捨てずに再利用可能な candidate にしてください。",
    "追加の window が必要なら memory_reader を呼び出してください。",
    "十分なら、候補 JSON だけを返してください。",
    "明確な再利用可能 signal がない場合だけ [] を返してください。",
  ].join("\n");
}

function readerAfterInitialReadPrompt(toolName: string): string {
  return [
    `上の ${toolName} tool result を source content として評価してください。`,
    "原因・修正・検証・ユーザーの継続的 preference・repo 固有の運用手順が含まれる場合は、再利用可能な candidate にしてください。",
    "追加の window が必要なら reader tool を呼び出してください。",
    "十分なら、候補 JSON だけを返してください。",
    "明確な再利用可能 signal がない場合だけ [] を返してください。",
  ].join("\n");
}

function routeMayUseCodex(params: {
  provider: DistillationProviderSetting;
  fallbackOrder: Array<Exclude<DistillationProviderSetting, "auto">>;
}): boolean {
  return params.provider === "codex" || params.fallbackOrder.includes("codex");
}

function modelForFindCandidateRoute(params: {
  routeProvider: DistillationProviderSetting;
  routeModel: string;
  routeLocalLlmModel?: string;
  provider: DistillationProviderSetting;
}): string {
  return resolveRouteModelForProvider({
    provider: params.provider,
    routeModel: params.routeProvider === params.provider ? params.routeModel : undefined,
    localLlmModel: params.routeProvider === params.provider ? params.routeLocalLlmModel : undefined,
  });
}

function buildInitialUserMessages(targetKind: FindCandidateTargetKind): DistillationMessage[] {
  return [
    {
      role: "user",
      content: targetKind === "vibe_memory" ? vibeMemoryInitialUserPrompt() : wikiUserPrompt(),
    },
  ];
}

function normalizeCandidateForPipeline(candidate: CandidateRecord): CandidateRecord {
  return {
    ...candidate,
  };
}

function llmOutputPreview(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 1000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textForByteRange(content: string, startOffset: number, endOffset: number): string {
  return Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");
}

function emptyCandidateDiagnostics(): StorageCandidateParseDiagnostics {
  return {
    rawWasEmptyArray: false,
    rawCandidateLikeCount: 0,
    droppedMissingType: 0,
    droppedMissingPolarity: 0,
    droppedNeutral: 0,
    droppedNegativeProcedure: 0,
    droppedInvalidProcedureShape: 0,
    plainTextFallbackUsed: false,
  };
}

function mergeCandidateDiagnostics(
  target: StorageCandidateParseDiagnostics,
  next: StorageCandidateParseDiagnostics,
): StorageCandidateParseDiagnostics {
  return {
    rawWasEmptyArray: target.rawWasEmptyArray && next.rawWasEmptyArray,
    rawCandidateLikeCount: target.rawCandidateLikeCount + next.rawCandidateLikeCount,
    droppedMissingType: target.droppedMissingType + next.droppedMissingType,
    droppedMissingPolarity: target.droppedMissingPolarity + next.droppedMissingPolarity,
    droppedNeutral: target.droppedNeutral + next.droppedNeutral,
    droppedNegativeProcedure: target.droppedNegativeProcedure + next.droppedNegativeProcedure,
    droppedInvalidProcedureShape:
      target.droppedInvalidProcedureShape + next.droppedInvalidProcedureShape,
    plainTextFallbackUsed: target.plainTextFallbackUsed || next.plainTextFallbackUsed,
  };
}

function dedupeCandidates(candidates: CandidateRecord[]): CandidateRecord[] {
  const seen = new Set<string>();
  const deduped: CandidateRecord[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.type,
      candidate.polarity,
      candidate.title.trim().toLowerCase(),
      candidate.content.trim().toLowerCase(),
    ].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function buildCandidateSemanticChunkMessages(params: {
  target: FindCandidateTarget;
  windows: BoundedSourceWindow[];
}): DistillationMessage[] {
  return [
    {
      role: "system",
      content: [
        "あなたは ContextStill の findCandidate chunk planner です。",
        "vibe memory の source window を、再利用可能な knowledge candidate を見つけやすい semantic chunk に分割します。",
        "CandidateRecord は作らず、境界情報だけを JSON array で返してください。",
        "固定長分割ではなく、依頼から結果、調査、実装、検証、失敗解消、判断転換のまとまりを優先してください。",
        "chunk は必ず提示された source window の byte range 内に収めてください。",
        "JSON 以外の説明文や Markdown は返さないでください。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Target key: ${params.target.targetKey}`,
        `Source URI: ${params.target.sourceUri}`,
        "",
        "次の shape の JSON array を返してください:",
        "{",
        '  "chunkIndex": 0,',
        '  "sourceStartOffset": 0,',
        '  "sourceEndOffset": 100,',
        '  "eventIds": ["..."],',
        '  "taskBoundaryKind": "request_to_result|investigation|implementation|verification|failure_resolution|decision_turn|misc",',
        '  "title": "...",',
        '  "boundaryReason": "...",',
        '  "expectedOutputs": ["candidate"],',
        '  "openBoundary": false',
        "}",
        "",
        "Source windows:",
        JSON.stringify(
          params.windows.map((window) => ({
            windowIndex: window.windowIndex,
            sourceStartOffset: window.sourceStartOffset,
            sourceEndOffset: window.sourceEndOffset,
            eventIds: window.eventIds,
            text: window.text,
          })),
        ),
      ].join("\n"),
    },
  ];
}

function buildCandidateGenerationMessages(params: {
  target: FindCandidateTarget;
  chunk: SemanticChunk;
  chunkText: string;
}): DistillationMessage[] {
  return [
    { role: "system", content: systemPromptForTarget(params.target.targetKind) },
    {
      role: "user",
      content: [
        "次の semantic chunk だけを source として、再利用可能な knowledge candidate を抽出してください。",
        "source にない事実は補完しないでください。",
        "追加 reader tool は使えません。候補 JSON だけを返してください。",
        "",
        `Chunk title: ${params.chunk.title}`,
        `Boundary kind: ${params.chunk.taskBoundaryKind}`,
        `Boundary reason: ${params.chunk.boundaryReason}`,
        `Source byte range: ${params.chunk.sourceStartOffset}-${params.chunk.sourceEndOffset}`,
        "",
        "Source chunk:",
        params.chunkText,
      ].join("\n"),
    },
  ];
}

async function createFindCandidateSemanticChunks(params: {
  target: FindCandidateTarget;
  windows: BoundedSourceWindow[];
  model: string;
  provider: DistillationProviderSetting;
  fallbackOrder: Array<Exclude<DistillationProviderSetting, "auto">>;
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
  signal?: AbortSignal;
}): Promise<SemanticChunk[]> {
  if (params.windows.length === 0) return [];
  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: 2000,
        messages: buildCandidateSemanticChunkMessages({
          target: params.target,
          windows: params.windows,
        }),
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        localLlmModel: params.localLlmModel,
        enableTools: false,
        maxToolRounds: 0,
        usageSource: "find-candidate:semantic-chunk",
        timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
        blankResponseReminder: [
          "空の応答です。semantic chunk の JSON array だけを返してください。",
        ],
        signal: params.signal,
      },
    );
    const parsed = parseLlmJsonLike(completion.content)?.value;
    const validated = validateSemanticChunks({ windows: params.windows, chunks: parsed });
    return validated.length > 0
      ? validated
      : deterministicSemanticChunksFromWindows(params.windows);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return deterministicSemanticChunksFromWindows(params.windows);
  }
}

async function runChunkedVibeMemoryFindCandidate(params: {
  target: FindCandidateTarget;
  content: string;
  model: string;
  provider: DistillationProviderSetting;
  fallbackOrder: Array<Exclude<DistillationProviderSetting, "auto">>;
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
  signal?: AbortSignal;
}): Promise<{
  candidates: CandidateRecord[];
  parseDiagnostics: StorageCandidateParseDiagnostics;
  llmOutput: string;
  metadata: Record<string, unknown>;
}> {
  const sourceBytes = Buffer.byteLength(params.content, "utf8");
  const windows = buildBoundedSourceWindows({
    content: params.content,
    events:
      sourceBytes > 0
        ? [
            {
              id: "memory_reader:initial",
              startOffset: 0,
              endOffset: sourceBytes,
              createdAt: new Date(0).toISOString(),
            },
          ]
        : [],
  });
  const chunks = await createFindCandidateSemanticChunks({
    target: params.target,
    windows,
    model: params.model,
    provider: params.provider,
    fallbackOrder: params.fallbackOrder,
    azureDeploymentSlots: params.azureDeploymentSlots,
    localLlmModel: params.localLlmModel,
    signal: params.signal,
  });
  let diagnostics: StorageCandidateParseDiagnostics | null = null;
  const outputs: string[] = [];
  const candidates: CandidateRecord[] = [];
  for (const chunk of chunks) {
    if (!chunk.expectedOutputs.some((output) => output === "candidate" || output === "both")) {
      continue;
    }
    const chunkText = textForByteRange(
      params.content,
      chunk.sourceStartOffset,
      chunk.sourceEndOffset,
    );
    if (chunkText.trim().length === 0) continue;
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: candidateOutputMaxTokens(),
        messages: buildCandidateGenerationMessages({
          target: params.target,
          chunk,
          chunkText,
        }),
      },
      {
        providerSetting: params.provider,
        fallbackOrder: params.fallbackOrder,
        azureDeploymentSlots: params.azureDeploymentSlots,
        localLlmModel: params.localLlmModel,
        enableTools: false,
        maxToolRounds: 0,
        usageSource: "find-candidate:chunk-generation",
        timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
        blankResponseReminder: [
          '空の応答です。[] または {"type":"rule|procedure","polarity":"positive|negative","title":"...","content":"..."} を返してください。',
        ],
        signal: params.signal,
      },
    );
    const output = completion.content.trim();
    outputs.push(output);
    const parsed = parseStorageCandidatesWithDiagnostics(output);
    diagnostics = diagnostics
      ? mergeCandidateDiagnostics(diagnostics, parsed.diagnostics)
      : parsed.diagnostics;
    candidates.push(...parsed.candidates.map(normalizeCandidateForPipeline));
  }
  const deduped = dedupeCandidates(candidates);
  return {
    candidates: deduped,
    parseDiagnostics: diagnostics ?? emptyCandidateDiagnostics(),
    llmOutput: outputs.join("\n"),
    metadata: {
      pipelineVersion: "internal-chunked-v1",
      sourceWindowCount: windows.length,
      semanticChunkCount: chunks.length,
      generatedCandidateCount: candidates.length,
      dedupedCandidateCount: deduped.length,
    },
  };
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

function buildInitialReadFileToolCall(input: FindCandidateInput): DistillationToolCall {
  return {
    id: "initial-read-file",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        fromToken: Math.max(0, Math.floor(input.fromToken ?? 0)),
        readTokens: readTokens(input),
        minify: input.wikiMinify ?? true,
      }),
    },
  };
}

export function formatCliTextCandidates(candidates: CandidateRecord[]): string {
  if (candidates.length === 0) return "NO_CANDIDATE";
  return candidates
    .map((candidate) =>
      [
        `TYPE: ${candidate.type}`,
        `POLARITY: ${candidate.polarity}`,
        `TITLE: ${candidate.title}`,
        `CONTENT:\n${candidate.content}`,
      ].join("\n"),
    )
    .join("\n---\n");
}

export async function runFindCandidate(input: FindCandidateInput): Promise<FindCandidateResult> {
  const targetStateId = input.targetStateId?.trim() ?? "";
  const rawTarget =
    targetStateId.length > 0
      ? await getDistillationTargetStateById(targetStateId)
      : input.sourceInput
        ? {
            id: null,
            targetKind: input.sourceInput.targetKind,
            targetKey: input.sourceInput.targetKey.trim(),
            sourceUri: input.sourceInput.sourceUri.trim(),
            metadata: input.sourceInput.metadata ?? {},
          }
        : null;
  if (!rawTarget) {
    throw new Error("targetStateId or sourceInput is required");
  }

  const target: FindCandidateTarget = {
    id: rawTarget.id,
    targetKind: rawTarget.targetKind as FindCandidateTargetKind,
    targetKey: rawTarget.targetKey,
    sourceUri: rawTarget.sourceUri ?? rawTarget.targetKey,
    metadata: asRecord("metadata" in rawTarget ? rawTarget.metadata : undefined),
  };

  if (
    target.targetKind !== "wiki_file" &&
    target.targetKind !== "vibe_memory" &&
    target.targetKind !== "web_ingest"
  ) {
    throw new Error(`unsupported target kind for findCandidate: ${target.targetKind}`);
  }
  if (!target.targetKey.trim()) {
    throw new Error("targetKey is required");
  }

  const callerMode = input.callerMode ?? "cli_text";
  const defaultRoute = await defaultFindCandidateRoute(target.targetKind);
  const provider = input.provider ?? defaultRoute.provider;
  const fallbackOrder = input.provider ? [] : defaultRoute.fallback;
  const azureDeploymentSlots = input.provider ? undefined : defaultRoute.azureDeploymentSlots;
  const localLlmModel = input.provider ? undefined : defaultRoute.localLlmModel;
  const model = modelForFindCandidateRoute({
    routeProvider: defaultRoute.provider,
    routeModel: defaultRoute.model,
    routeLocalLlmModel: defaultRoute.localLlmModel,
    provider,
  });
  const toolDefinition = buildToolDefinitionForTarget(target.targetKind);
  const readLog: Array<{ from: number; toExclusive: number }> = [];
  const readLimit = maxReads(input);
  let reads = 0;
  const targetReadPath =
    target.targetKind === "web_ingest" ? target.sourceUri.trim() : target.targetKey;
  if (
    (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
    !targetReadPath
  ) {
    throw new Error(`missing readable source path for target: ${target.id ?? target.targetKey}`);
  }

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

    if (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") {
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
        path: targetReadPath,
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
    let parseDiagnostics: StorageCandidateParseDiagnostics | undefined;
    let readerUsedRecorded = false;
    let chunkedPipelineMetadata: Record<string, unknown> | undefined;

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
    let deterministicInitialRead = false;

    if (
      (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
      routeMayUseCodex({ provider, fallbackOrder })
    ) {
      const initialToolCall = buildInitialReadFileToolCall(input);
      const initialToolResult = await toolExecutor(initialToolCall);
      if (!initialToolResult.ok) {
        throw new Error(initialToolResult.error ?? "initial read_file failed");
      }
      deterministicInitialRead = true;
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
          content: readerAfterInitialReadPrompt(initialToolResult.name),
        },
      );
      await recordReaderUsed({ initialRead: true, reader: initialToolResult.name });
    }

    if (target.targetKind === "vibe_memory") {
      const initialToolCall = buildInitialVibeMemoryToolCall(input);
      const initialToolResult = await toolExecutor(initialToolCall);
      if (!initialToolResult.ok) {
        throw new Error(initialToolResult.error ?? "initial memory_reader failed");
      }
      if (groupedConfig.distillation.internalChunkedDistillationEnabled) {
        const chunked = await runChunkedVibeMemoryFindCandidate({
          target,
          content: initialToolResult.content,
          model,
          provider,
          fallbackOrder,
          azureDeploymentSlots,
          localLlmModel,
          signal: input.signal,
        });
        llmOutput = chunked.llmOutput;
        candidates = chunked.candidates;
        parseDiagnostics = chunked.parseDiagnostics;
        chunkedPipelineMetadata = chunked.metadata;
        await recordReaderUsed({
          initialRead: true,
          reader: "memory_reader",
          findCandidate: chunkedPipelineMetadata,
        });
      } else {
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
    }

    if (!chunkedPipelineMetadata) {
      const completion = await runDistillationCompletion(
        {
          model,
          maxTokens: candidateOutputMaxTokens(),
          messages,
        },
        {
          providerSetting: provider,
          fallbackOrder,
          azureDeploymentSlots,
          localLlmModel,
          toolDefinitions: [toolDefinition],
          toolExecutor,
          usageSource: "find-candidate",
          enableTools: reads < readLimit,
          maxToolRounds: Math.max(0, readLimit - reads),
          timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
          requireToolCall:
            (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
            !deterministicInitialRead,
          requireToolCallReminder: [
            "まだ本文を読んでいません。",
            "まず提供された reader tool を呼び出して本文 content を読んでください。",
            "その後に候補のみを返してください。",
          ],
          blankResponseReminder: [
            '空の応答です。[] または {"type":"rule|procedure","polarity":"positive|negative","title":"...","content":"..."} を返してください。',
          ],
          signal: input.signal,
        },
      );

      llmOutput = completion.content.trim();
      const parsed = parseStorageCandidatesWithDiagnostics(llmOutput);
      parseDiagnostics = parsed.diagnostics;
      candidates = parsed.candidates.map(normalizeCandidateForPipeline);
    }

    if (readLog.length === 0) {
      throw new Error("findCandidate reader tool was not used");
    }

    await recordReaderUsed();
    const noCandidateDiagnostics =
      candidates.length === 0
        ? { parseDiagnostics, llmOutputPreview: llmOutputPreview(llmOutput) }
        : undefined;

    if (callerMode === "cli_text") {
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateCompleted,
        actor: "system",
        payload: {
          targetStateId: target.id,
          candidateCount: candidates.length,
          readCount: readLog.length,
          ...(chunkedPipelineMetadata ? { findCandidate: chunkedPipelineMetadata } : {}),
          ...(noCandidateDiagnostics ? { noCandidateDiagnostics } : {}),
        },
      });

      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        callerMode,
        candidates,
        readRanges: readLog,
        parseDiagnostics,
      };
    }

    const origin: CandidateOrigin = {
      readRanges: readLog,
    };

    const insertedIds: string[] = [];

    if (target.id) {
      for (const [index, candidate] of candidates.entries()) {
        const saved = await insertFindCandidateResult({
          targetStateId: target.id,
          candidateIndex: index,
          candidate,
          origin,
        });
        insertedIds.push(saved.id);
      }
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateCompleted,
      actor: "system",
      payload: {
        targetStateId: target.id,
        candidateCount: candidates.length,
        insertedCount: insertedIds.length,
        ...(chunkedPipelineMetadata ? { findCandidate: chunkedPipelineMetadata } : {}),
        ...(noCandidateDiagnostics ? { noCandidateDiagnostics } : {}),
      },
    });

    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      callerMode,
      candidates,
      insertedIds: target.id ? insertedIds : undefined,
      readRanges: readLog,
      parseDiagnostics,
    };
  } catch (error) {
    const normalizedError = normalizeFindCandidateFailure({
      error,
      readCount: readLog.length,
      readLimit,
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateFailed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        error: normalizedError.message,
      },
    });
    throw normalizedError;
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
