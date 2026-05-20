import { groupedConfig } from "../../config.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  distillationToolEventsFromError,
  resolveDistillationModel,
  runDistillationCompletion,
  type DistillationChatClient,
  type DistillationProviderSetting,
  type DistillationToolExecutor,
} from "../distillation/distillation-runtime.service.js";
import { dedupeCoverEvidenceCandidate } from "./dedupe.service.js";
import {
  configuredMcpEvidenceToolNames,
  referencesFromMcpToolEvents,
  type McpEvidenceToolName,
} from "./mcp-evidence.service.js";
import { parseCoverEvidenceResult } from "./parser.js";
import {
  coverEvidenceResultFromRow,
  saveCoverEvidenceResult,
  selectCoverEvidenceResultById,
} from "./repository.js";
import { buildCoverEvidenceSearchQuery } from "./search-query.service.js";
import { evaluateSourceSupport, readSourceEvidenceForCandidate } from "./source-support.service.js";
import type {
  CoverEvidenceCandidate,
  CoverEvidenceInput,
  CoverEvidenceReference,
  CoverEvidenceResult,
  CoverEvidenceStage,
  CoverEvidenceStatus,
  CoverEvidenceToolEvent,
} from "./types.js";

export type CoverEvidenceRunInput = CoverEvidenceInput & {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
};

export type CoverEvidenceRunResult = {
  id: string;
  result: CoverEvidenceResult;
};

const MAX_REASON_LENGTH = 160;

function compactReason(value: string | null | undefined): string | null {
  const reason = value?.replace(/\s+/g, " ").trim();
  return reason ? reason.slice(0, MAX_REASON_LENGTH) : null;
}

function inferCandidateType(title: string, body: string): CoverEvidenceCandidate["type"] {
  const text = `${title}\n${body}`.toLowerCase();
  if (
    /(\bstep\b|\bsteps\b|\brun\b|\bcommand\b|\bcli\b|\bprocedure\b|手順|実行|コマンド|まず|次に|最後に)/i.test(
      text,
    )
  ) {
    return "procedure";
  }
  return "rule";
}

function inferImportance(title: string, body: string): number {
  const text = `${title}\n${body}`.toLowerCase();
  if (
    /(must|never|required|failure|error|security|verify|必ず|禁止|失敗|エラー|検証|安全)/i.test(
      text,
    )
  ) {
    return 82;
  }
  if (/(should|prefer|avoid|推奨|避ける|注意)/i.test(text)) {
    return 74;
  }
  return 68;
}

function baseCandidate(params: {
  title: string;
  body: string;
  confidence: number;
}): CoverEvidenceCandidate {
  return {
    type: inferCandidateType(params.title, params.body),
    title: params.title,
    body: params.body,
    importance: inferImportance(params.title, params.body),
    confidence: Math.max(0, Math.min(100, Math.round(params.confidence))),
  };
}

function toolEventsForResult(events: unknown[]): CoverEvidenceToolEvent[] {
  return events
    .map((event) => {
      if (!event || typeof event !== "object") return null;
      const record = event as {
        name?: unknown;
        ok?: unknown;
        metadata?: unknown;
        error?: unknown;
      };
      if (typeof record.name !== "string" || typeof record.ok !== "boolean") return null;
      const metadata =
        record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : undefined;
      return {
        name: record.name,
        ok: record.ok,
        ...(metadata ? { metadata } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      };
    })
    .filter((event): event is CoverEvidenceToolEvent => Boolean(event));
}

function referenceKey(reference: CoverEvidenceReference): string {
  return [reference.kind, reference.uri, reference.locator ?? "", reference.evidenceRole].join(
    "\0",
  );
}

function mergeReferences(...groups: CoverEvidenceReference[][]): CoverEvidenceReference[] {
  const byKey = new Map<string, CoverEvidenceReference>();
  for (const reference of groups.flat()) {
    byKey.set(referenceKey(reference), reference);
  }
  return [...byKey.values()];
}

function referencesFromDuplicateRefs(
  duplicateRefs: CoverEvidenceResult["duplicateRefs"],
): CoverEvidenceReference[] {
  return duplicateRefs.map((ref) => ({
    kind: "knowledge",
    uri: `knowledge://${ref.knowledgeId}`,
    title: ref.title,
    note: ref.reason,
    evidenceRole: "dedupe_match",
  }));
}

function referencesFromToolEvents(toolEvents: CoverEvidenceToolEvent[]): CoverEvidenceReference[] {
  const webReferences = toolEvents
    .filter((event) => event.ok)
    .map((event): CoverEvidenceReference | null => {
      const metadata = event.metadata ?? {};
      if (event.name === "fetch_content") {
        const uri =
          typeof metadata.finalUrl === "string"
            ? metadata.finalUrl
            : typeof metadata.url === "string"
              ? metadata.url
              : "";
        if (!uri) return null;
        return {
          kind: "web",
          uri,
          note: "fetch_content verified external evidence",
          evidenceRole: "external_verification",
        };
      }
      if (event.name === "search_web" && typeof metadata.query === "string") {
        return {
          kind: "web",
          uri: `search:${metadata.query}`,
          note: "search_web located external evidence candidates",
          evidenceRole: "external_verification",
        };
      }
      return null;
    })
    .filter((reference): reference is CoverEvidenceReference => Boolean(reference));
  return [...webReferences, ...referencesFromMcpToolEvents(toolEvents)];
}

function makeResult(params: {
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  candidate: CoverEvidenceCandidate | null;
  references?: CoverEvidenceReference[];
  duplicateRefs?: CoverEvidenceResult["duplicateRefs"];
  toolEvents?: CoverEvidenceToolEvent[];
  reason?: string | null;
}): CoverEvidenceResult {
  return {
    schemaVersion: 1,
    status: params.status,
    stage: params.stage,
    candidate: params.candidate,
    references: params.references ?? [],
    duplicateRefs: params.duplicateRefs ?? [],
    toolEvents: params.toolEvents ?? [],
    reason: compactReason(params.reason),
  };
}

function rejectLowImportance(result: CoverEvidenceResult): CoverEvidenceResult {
  if (
    result.status !== "knowledge_ready" ||
    !result.candidate ||
    result.candidate.importance > groupedConfig.distillation.lowImportanceRejectThreshold
  ) {
    return result;
  }
  return makeResult({
    status: "insufficient",
    stage: result.stage,
    candidate: null,
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: result.toolEvents,
    reason: "low_importance",
  });
}

const retryableCoverEvidenceStatuses = new Set<CoverEvidenceStatus>([
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

function isRetryableCoverEvidenceStatus(status: CoverEvidenceStatus): boolean {
  return retryableCoverEvidenceStatuses.has(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requiresExternalEvidence(candidate: CoverEvidenceCandidate): boolean {
  const text = `${candidate.title}\n${candidate.body}`;
  return (
    /\bhttps?:\/\//i.test(text) ||
    /\b(latest|current|pricing|rate limit|version|api|cli|provider|model)\b/i.test(text) ||
    /(現在|最新|料金|制限|モデル名|公開仕様|API|CLI)/i.test(text)
  );
}

function externalEvidenceSystemPrompt(): string {
  return [
    "あなたは coverEvidence の外部 evidence 検証器です。",
    "必ず search_web または fetch_content を使ってから、JSON だけを返してください。",
    "search_web は URL 発見用です。検索結果 snippet だけを最終根拠にしてはいけません。",
    "search_web の結果を受け取ったら、採用候補の一次ソース URL を 1 から 3 件選び、最終 JSON の前に fetch_content を呼んでください。",
    "fetch_content は同じ検証 session で複数回呼んで構いません。失敗した URL があれば、別の有望な URL を fetch_content してください。",
    "候補や source references に URL が含まれる場合は、search_web より先にその URL を fetch_content してください。",
    "search_web を同義の言い換え query で繰り返さないでください。query は短く安定した公式名・API名・概念名を優先してください。",
    "外部主張を採用するなら fetch_content の成功結果に基づけてください。",
    "JSON は次の形だけにしてください:",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient|duplicate|near_duplicate","stage":"web","candidate":{"type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80},"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
    "candidate.importance と candidate.confidence は 0 から 100 の整数です。",
  ].join("\n");
}

function externalEvidenceUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
}): string {
  const query = buildCoverEvidenceSearchQuery(`${params.candidate.title} ${params.candidate.body}`);
  return [
    "候補を外部 evidence で検証してください。",
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    `推奨検索 query: ${query.query}`,
  ].join("\n\n");
}

function valueAssessmentSystemPrompt(): string {
  return [
    "あなたは coverEvidence の knowledge value 判定器です。",
    "候補が次回以降の coding agent に再利用可能な rule/procedure かを判定してください。",
    "候補は元 source で支えられている前提ですが、重要度と自己完結性を改めて評価してください。",
    "importance と confidence は 0 から 100 の整数です。",
    `importance が ${groupedConfig.distillation.lowImportanceRejectThreshold} 以下なら status は insufficient、reason は low_importance にしてください。`,
    "JSON は次の形だけにしてください:",
    '{"schemaVersion":1,"status":"knowledge_ready|insufficient","stage":"final","candidate":{"type":"rule|procedure","title":"...","body":"...","importance":80,"confidence":80},"references":[],"duplicateRefs":[],"toolEvents":[],"reason":null}',
    "insufficient の場合は candidate を null にしてよいです。",
  ].join("\n");
}

function valueAssessmentUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
}): string {
  return [
    "候補の value を判定してください。",
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    "source excerpt:",
    params.sourceContentExcerpt.slice(0, 6000),
  ].join("\n\n");
}

async function runValueAssessment(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  provider: DistillationProviderSetting;
  model: string;
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: Math.max(1024, groupedConfig.vibeDistillation.maxOutputTokens),
        messages: [
          { role: "system", content: valueAssessmentSystemPrompt() },
          {
            role: "user",
            content: valueAssessmentUserPrompt({
              candidate: params.candidate,
              sourceReferences: params.sourceReferences,
              sourceContentExcerpt: params.sourceContentExcerpt,
            }),
          },
        ],
      },
      {
        providerSetting: params.provider,
        chatClient: params.chatClient,
        enableTools: false,
        signal: params.signal,
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          assessment: "value",
        },
      },
    );
    const parsed = parseCoverEvidenceResult(completion.content);
    return rejectLowImportance({
      ...parsed,
      references: mergeReferences(params.sourceReferences, parsed.references),
      toolEvents: toolEventsForResult(completion.toolEvents),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status: CoverEvidenceStatus = toolEvents.length > 0 ? "tool_failed" : "provider_failed";
    return makeResult({
      status,
      stage: "final",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: status === "tool_failed" ? "value_tool_failed" : "value_provider_failed",
    });
  }
}

async function runExternalEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  provider: DistillationProviderSetting;
  model: string;
  forceRefreshEvidence?: boolean;
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: Math.max(2048, groupedConfig.vibeDistillation.maxOutputTokens),
        messages: [
          { role: "system", content: externalEvidenceSystemPrompt() },
          {
            role: "user",
            content: externalEvidenceUserPrompt({
              candidate: params.candidate,
              sourceReferences: params.sourceReferences,
            }),
          },
        ],
      },
      {
        providerSetting: params.provider,
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        enableTools: true,
        maxToolRounds: groupedConfig.distillationTools.maxRounds,
        requireToolCall: true,
        toolNames: ["search_web", "fetch_content"],
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          forceRefreshEvidence: Boolean(params.forceRefreshEvidence),
        },
        signal: params.signal,
      },
    );
    let parsed: CoverEvidenceResult;
    try {
      parsed = parseCoverEvidenceResult(completion.content);
    } catch (error) {
      const toolEvents = toolEventsForResult(completion.toolEvents);
      return makeResult({
        status: "parse_failed",
        stage: "web",
        candidate: null,
        references: params.sourceReferences,
        toolEvents,
        reason: "external_parse_failed",
      });
    }
    const toolEvents = toolEventsForResult(completion.toolEvents);
    const references = mergeReferences(
      params.sourceReferences,
      parsed.references,
      referencesFromToolEvents(toolEvents),
    );
    const hasFetchEvidence = toolEvents.some((event) => event.name === "fetch_content" && event.ok);
    if (parsed.status === "knowledge_ready" && !hasFetchEvidence) {
      return makeResult({
        status: "insufficient",
        stage: "web",
        candidate: null,
        references,
        duplicateRefs: parsed.duplicateRefs,
        toolEvents,
        reason: "external_fetch_evidence_missing",
      });
    }

    return rejectLowImportance({
      ...parsed,
      references,
      toolEvents,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    const status: CoverEvidenceStatus = toolEvents.length > 0 ? "tool_failed" : "provider_failed";
    return makeResult({
      status,
      stage: "web",
      candidate: null,
      references: params.sourceReferences,
      toolEvents,
      reason: status === "tool_failed" ? "external_tool_failed" : "external_provider_failed",
    });
  }
}

function mcpEvidenceSystemPrompt(toolNames: readonly McpEvidenceToolName[]): string {
  return [
    "あなたは coverEvidence の任意 MCP evidence 収集器です。",
    `利用可能な補助 tool は ${toolNames.join(", ")} です。`,
    "候補の公開ライブラリ、フレームワーク、API、リポジトリ仕様に関係する補助 evidence がある場合だけ tool を使ってください。",
    "MCP evidence は補助情報です。web fetch evidence の代替として扱ってはいけません。",
    '最後は {"status":"checked"} の JSON だけを返してください。',
  ].join("\n");
}

function mcpEvidenceUserPrompt(candidate: CoverEvidenceCandidate): string {
  return [
    "候補に関連する補助 MCP evidence を収集してください。",
    "候補:",
    JSON.stringify(candidate, null, 2),
  ].join("\n\n");
}

async function runOptionalMcpEvidence(params: {
  id: string;
  candidate: CoverEvidenceCandidate;
  provider: DistillationProviderSetting;
  model: string;
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<{ references: CoverEvidenceReference[]; toolEvents: CoverEvidenceToolEvent[] }> {
  const toolNames = configuredMcpEvidenceToolNames();
  if (toolNames.length === 0) {
    return { references: [], toolEvents: [] };
  }

  try {
    const completion = await runDistillationCompletion(
      {
        model: params.model,
        maxTokens: 1024,
        messages: [
          { role: "system", content: mcpEvidenceSystemPrompt(toolNames) },
          { role: "user", content: mcpEvidenceUserPrompt(params.candidate) },
        ],
      },
      {
        providerSetting: params.provider,
        chatClient: params.chatClient,
        toolExecutor: params.toolExecutor,
        enableTools: true,
        maxToolRounds: 2,
        requireToolCall: true,
        toolNames,
        requireToolCallReminder: [
          "直前の応答はまだ採用できません。",
          `補助 MCP evidence が設定されているため、最終 JSON の前に ${toolNames.join(
            " または ",
          )} を 1 回だけ呼び出してください。`,
        ],
        auditContext: {
          domain: "coverEvidence",
          id: params.id,
          optionalEvidence: "mcp",
        },
        signal: params.signal,
      },
    );
    const toolEvents = toolEventsForResult(completion.toolEvents);
    return {
      references: referencesFromMcpToolEvents(toolEvents),
      toolEvents,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const toolEvents = toolEventsForResult(distillationToolEventsFromError(error));
    return {
      references: referencesFromMcpToolEvents(toolEvents),
      toolEvents,
    };
  }
}

async function appendOptionalMcpEvidence(params: {
  id: string;
  result: CoverEvidenceResult;
  provider: DistillationProviderSetting;
  model: string;
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  signal?: AbortSignal;
}): Promise<CoverEvidenceResult> {
  if (params.result.status !== "knowledge_ready" || !params.result.candidate) {
    return params.result;
  }

  const mcpEvidence = await runOptionalMcpEvidence({
    id: params.id,
    candidate: params.result.candidate,
    provider: params.provider,
    model: params.model,
    chatClient: params.chatClient,
    toolExecutor: params.toolExecutor,
    signal: params.signal,
  });
  if (mcpEvidence.references.length === 0 && mcpEvidence.toolEvents.length === 0) {
    return params.result;
  }

  return {
    ...params.result,
    references: mergeReferences(params.result.references, mcpEvidence.references),
    toolEvents: [...params.result.toolEvents, ...mcpEvidence.toolEvents],
  };
}

export async function runCoverEvidence(
  input: CoverEvidenceRunInput,
): Promise<CoverEvidenceRunResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id is required");
  }
  const provider = input.provider ?? groupedConfig.distillation.provider;
  const model = resolveDistillationModel(provider);

  if (input.write) {
    const existing = await selectCoverEvidenceResultById(id);
    if (existing) {
      const existingResult = coverEvidenceResultFromRow(existing);
      if (input.forceRefreshEvidence || isRetryableCoverEvidenceStatus(existingResult.status)) {
        // Retryable rows are checkpoints, not terminal cache hits.
      } else {
        return {
          id: existing.id,
          result: existingResult,
        };
      }
    }
  }

  const row = await getFindCandidateResultById(id);
  if (!row) {
    throw new Error(`find candidate result not found: ${id}`);
  }
  await recordAuditLogSafe({
    eventType: auditEventTypes.coverEvidenceStarted,
    actor: "system",
    payload: {
      id,
      targetKind: row.targetKind,
      targetKey: row.targetKey,
      provider,
    },
  });

  let result: CoverEvidenceResult | undefined;

  try {
    if (row.status !== "selected") {
      result = makeResult({
        status: "parse_failed",
        stage: "load",
        candidate: null,
        reason: "find_candidate_not_selected",
      });
    } else {
      let sourceRead: Awaited<ReturnType<typeof readSourceEvidenceForCandidate>>;
      try {
        sourceRead = await readSourceEvidenceForCandidate(row);
      } catch (error) {
        result = makeResult({
          status: "tool_failed",
          stage: "source_support",
          candidate: null,
          reason: "source_read_failed",
        });
        sourceRead = {
          content: "",
          references: [],
          readRanges: [],
        };
      }

      if (result === undefined) {
        const support = evaluateSourceSupport({
          title: row.title,
          body: row.content,
          sourceContent: sourceRead.content,
        });
        if (!support.ok) {
          result = makeResult({
            status: "insufficient",
            stage: "source_support",
            candidate: null,
            references: sourceRead.references,
            reason: support.reason,
          });
        } else {
          const candidate = baseCandidate({
            title: row.title,
            body: row.content,
            confidence: support.confidence,
          });
          const dedupe = await dedupeCoverEvidenceCandidate(candidate);
          if (dedupe.status !== "unique") {
            result = makeResult({
              status: dedupe.status,
              stage: "dedupe",
              candidate: null,
              references: mergeReferences(
                sourceRead.references,
                referencesFromDuplicateRefs(dedupe.duplicateRefs),
              ),
              duplicateRefs: dedupe.duplicateRefs,
              reason: dedupe.status,
            });
          } else if (requiresExternalEvidence(candidate)) {
            result = await runExternalEvidence({
              id,
              candidate,
              sourceReferences: sourceRead.references,
              provider,
              model,
              forceRefreshEvidence: input.forceRefreshEvidence,
              chatClient: input.chatClient,
              toolExecutor: input.toolExecutor,
              signal: input.signal,
            });
            result = await appendOptionalMcpEvidence({
              id,
              result,
              provider,
              model,
              chatClient: input.chatClient,
              toolExecutor: input.toolExecutor,
              signal: input.signal,
            });
          } else {
            result = await runValueAssessment({
              id,
              candidate,
              sourceReferences: sourceRead.references,
              sourceContentExcerpt: sourceRead.content,
              provider,
              model,
              chatClient: input.chatClient,
              signal: input.signal,
            });
          }
        }
      }
    }

    if (!result) {
      throw new Error("coverEvidence did not produce a result");
    }

    if (input.write) {
      await saveCoverEvidenceResult({
        id,
        result,
      });
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceCompleted,
      actor: "system",
      payload: {
        id,
        status: result.status,
        stage: result.stage,
        saved: Boolean(input.write),
      },
    });

    return { id, result };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceFailed,
      actor: "system",
      payload: {
        id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runCoverEvidenceSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  const parsed = parseCoverEvidenceResult(
    JSON.stringify({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "final",
      candidate: {
        type: "rule",
        title: "coverEvidence smoke keeps evidence refs",
        body: "coverEvidence must preserve source references before finalizeDistille creates drafts.",
        importance: 70,
        confidence: 80,
      },
      references: [
        {
          kind: "source",
          uri: "smoke://cover-evidence",
          note: "smoke source reference",
          evidenceRole: "supports_candidate",
        },
      ],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    }),
  );
  return {
    domain: "coverEvidence",
    implemented: true,
    status: "ok",
    checkedAt: new Date().toISOString(),
    message: "coverEvidence parser and runtime are available.",
    receivedInput: input,
    nextContracts: [
      "coverEvidence preserves source references",
      "coverEvidence write=true stores cover_evidence_results",
      "finalizeDistille consumes knowledge_ready cover evidence results",
    ],
  };
}
