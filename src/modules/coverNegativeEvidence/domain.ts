import { resolveCoverEvidenceRouteByPolicy } from "../coverEvidence/provider-policy.js";
import { saveCoverEvidenceResult } from "../coverEvidence/repository.js";
import type { CoverEvidenceResult } from "../coverEvidence/types.js";
import {
  type DistillationChatClient,
  createDefaultChatClient,
  resolveRouteModelForProvider,
} from "../distillation/distillation-runtime.service.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
} from "../settings/settings.service.js";
import {
  applicabilityToCoverCandidateFields,
  hasRequiredApplicabilityFacets,
  mergeApplicability,
  normalizeApplicability,
} from "../knowledge/applicability.js";
import { parseNegativeEvidenceResult } from "./parser.js";
import { buildNegativeEvidencePrompt } from "./prompts.js";

function buildNegativeKnowledgeBody(distilled: {
  failure: string;
  impact?: string;
  trigger?: string;
  fix?: string;
  verification?: string;
  decisionSignal?: string;
}): string {
  return [
    `避けること: ${distilled.failure}`,
    distilled.impact ? `影響: ${distilled.impact}` : null,
    distilled.trigger ? `発生条件: ${distilled.trigger}` : null,
    distilled.fix ? `推奨対応: ${distilled.fix}` : null,
    distilled.verification ? `確認方法: ${distilled.verification}` : null,
    distilled.decisionSignal ? `判断シグナル: ${distilled.decisionSignal}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function runCoverNegativeEvidence(params: {
  id: string;
  candidate?: any;
  providerPolicy?: string;
  write?: boolean;
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
}) {
  const id = params.id;
  const row = params.candidate ?? (await getFindCandidateResultById(id));
  if (!row) {
    throw new Error(`find candidate result not found: ${id}`);
  }

  await ensureRuntimeSettingsLoaded();
  const routes = resolveCoverEvidenceRoutes();
  const providerPolicy = params.providerPolicy ?? "default";

  const mcpEvidenceRuntimeRoute = resolveCoverEvidenceRouteByPolicy({
    route: routes.mcpEvidence,
    policy: providerPolicy as any,
    routeName: "mcpEvidence",
  });
  const provider = mcpEvidenceRuntimeRoute.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: mcpEvidenceRuntimeRoute.model,
    localLlmModel: mcpEvidenceRuntimeRoute.localLlmModel,
  });

  const prompt = buildNegativeEvidencePrompt({
    title: row.title,
    content: row.content,
  });

  const chat =
    params.chatClient ??
    createDefaultChatClient(
      provider,
      "cover-negative-evidence",
      mcpEvidenceRuntimeRoute.fallback,
      mcpEvidenceRuntimeRoute.azureDeploymentSlots,
      mcpEvidenceRuntimeRoute.localLlmModel,
    );
  const response = await chat({
    messages: [
      {
        role: "system",
        content:
          "あなたは professional software engineering assistant です。JSON のキー名や固定 enum 以外の自然文は日本語で返してください。",
      },
      { role: "user", content: prompt },
    ],
    model,
    maxTokens: 2048,
    signal: params.signal,
  });

  const parsed = parseNegativeEvidenceResult(response.content ?? "");
  const appliesTo = mergeApplicability(
    normalizeApplicability(row),
    normalizeApplicability(row.metadata),
    normalizeApplicability(row.origin),
    parsed.appliesTo,
  );

  // Map to CoverEvidenceResult format to keep compatibility with existing pipeline.
  const missingRequiredApplicability =
    parsed.status === "ready" && !hasRequiredApplicabilityFacets(appliesTo);
  const mappedStatus =
    parsed.status === "ready" && !missingRequiredApplicability
      ? "knowledge_ready"
      : missingRequiredApplicability
        ? "insufficient"
        : parsed.status;

  const result: CoverEvidenceResult = {
    schemaVersion: 1,
    status: mappedStatus as any,
    stage: "final",
    candidate:
      parsed.status === "ready" && !missingRequiredApplicability
        ? {
            type: "rule",
            title: row.title,
            body: buildNegativeKnowledgeBody(parsed.distilled),
            confidence: 90,
            importance: 80,
            ...applicabilityToCoverCandidateFields(appliesTo),
          }
        : null,
    references: parsed.evidence.map((e) => ({
      kind: "source",
      uri: row.sourceUri || `agent://candidate/${row.id}`,
      note: e,
      evidenceRole: "supports_candidate",
    })),
    duplicateRefs: [],
    toolEvents: [
      {
        name: "negative_coverage",
        ok: true,
        metadata: {
          polarity: parsed.polarity,
          intentTags: parsed.intentTags,
          ...(appliesTo ? { appliesTo } : {}),
          originRefs: parsed.originRefs,
          distilled: parsed.distilled,
        },
      },
    ],
    reason: missingRequiredApplicability
      ? "applies_to_categories_required"
      : parsed.status !== "ready"
        ? parsed.status
        : null,
  };

  if (params.write) {
    await saveCoverEvidenceResult({
      id,
      result,
    });
  }

  return { id, result };
}
export type CoverEvidenceRunResult = {
  id: string;
  result: CoverEvidenceResult;
};
