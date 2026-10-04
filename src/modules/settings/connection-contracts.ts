import { z } from "zod";
import type {
  RuntimeSecretStatus,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "./settings.types.js";

export const connectionKinds = [
  "azure-openai",
  "openai",
  "bedrock",
  "local-llm",
  "larm-agent-connection",
  "codex",
] as const;
export type ConnectionKind = (typeof connectionKinds)[number];
export const connectionLabels: Record<ConnectionKind, string> = {
  "azure-openai": "Azure OpenAI",
  openai: "OpenAI",
  bedrock: "AWS Bedrock",
  "local-llm": "固定エンドポイント",
  "larm-agent-connection": "LARM",
  codex: "Codex SDK",
};
export const credentialUpdateSchema = z
  .object({
    action: z.enum(["keep", "set", "clear", "environment", "inherit"]).default("keep"),
    value: z.string().max(16_384).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === "set" && !v.value?.trim())
      ctx.addIssue({ code: "custom", path: ["value"], message: "認証キーを入力してください" });
    if (v.action !== "set" && v.value !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "認証変更時だけ値を送信してください",
      });
  });
export const connectionInputSchema = z
  .object({
    kind: z.enum(connectionKinds),
    fields: z.record(z.union([z.string(), z.number(), z.boolean()])),
    credential: credentialUpdateSchema.default({ action: "keep" }),
    expectedRevision: z.number().int().min(0),
    operationId: z.string().uuid(),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type CredentialUpdate = z.infer<typeof credentialUpdateSchema>;
export const sectionPatchSchema = z
  .object({
    section: z.enum([
      "general",
      "taskRouting",
      "providerPools",
      "search",
      "embedding",
      "distillationRuntime",
      "advanced",
    ]),
    changes: z.record(z.unknown()),
    expectedRevision: z.number().int().min(0),
    operationId: z.string().uuid(),
    secrets: z.record(credentialUpdateSchema).optional(),
  })
  .strict();
export type SectionPatch = z.infer<typeof sectionPatchSchema>;
export type ConnectionRow = {
  id: string;
  kind: ConnectionKind;
  name: string;
  model: string;
  endpoint: string;
  fields: Record<string, string | number | boolean>;
  enabled: boolean;
  credentialKey?: string;
  credential: RuntimeSecretStatus;
  references: string[];
};
export type ProviderTestResult = {
  id: string;
  connectionId?: string;
  revision: number;
  scope: "saved" | "draft";
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "stale";
  startedAt: string;
  finishedAt?: string;
  method: string;
  error?: string;
  model?: string;
  endpoint?: string;
  requestFingerprint: string;
};
export type ProviderRuntime = {
  observedAt: string;
  status: string;
  reason?: string;
  model?: string;
  endpoint?: string;
  canonicalProfile?: string;
  connectionId?: string;
  capacity?: number;
  activeRequests?: number;
  contextWindow?: { maxTokens: number; outputReserveTokens: number; safetyMarginTokens: number };
  effectiveWindow?: { maxTokens: number; outputReserveTokens: number; safetyMarginTokens: number };
  inputEstimateCeiling?: number;
  providers?: Array<{ name: string; model?: string; protocol?: string; status: string }>;
  expiresAt?: string;
};

export function routeEntries(
  settings: RuntimeSettingsEditable,
): Array<[string, RuntimeSettingsRoute]> {
  const r = settings.taskRouting;
  return [
    ["findCandidate.source", r.findCandidate.source],
    ["findCandidate.vibe", r.findCandidate.vibe],
    ["coverEvidence.sourceSupport", r.coverEvidence.sourceSupport],
    ["coverEvidence.externalEvidence", r.coverEvidence.externalEvidence],
    ["coverEvidence.mcpEvidence", r.coverEvidence.mcpEvidence],
    ["webSourceResearch", r.webSourceResearch],
    ["deepStillManual", r.deepStillManual],
    ["episodeDistiller", r.episodeDistiller],
    ["deadZoneMergeReview", r.deadZoneMergeReview],
    ["landscapeCuration", r.landscapeCuration],
    ["finalizeDistille", r.finalizeDistille],
    ["mergeActivationFinalize", r.mergeActivationFinalize],
    ["agenticCompile", r.agenticCompile],
  ];
}
export function getRoute(settings: RuntimeSettingsEditable, path: string): RuntimeSettingsRoute {
  const entry = routeEntries(settings).find(([name]) => name === path);
  if (!entry) throw new Error("route_not_found");
  return entry[1];
}
export function setRoute(
  settings: RuntimeSettingsEditable,
  path: string,
  route: RuntimeSettingsRoute,
): void {
  getRoute(settings, path);
  const keys = path.split(".");
  const target = settings.taskRouting as unknown as Record<string, unknown>;
  if (keys.length === 1)
    target[path] = path === "agenticCompile" ? { ...(target[path] as object), ...route } : route;
  else (target[keys[0]] as Record<string, unknown>)[keys[1]] = route;
}
export function azureSecretKey(index: number): string {
  return index === 0 ? "azureOpenAiApiKey" : `azureOpenAiApiKey${index + 1}`;
}
export function localSecretKey(index: number): string {
  return index === 0 ? "localLlmApiKey" : `localLlmApiKey${index + 1}`;
}

export function localConnectionModel(
  row: Pick<ConnectionRow, "endpoint" | "model" | "fields">,
): string {
  return JSON.stringify({
    apiBaseUrl: row.endpoint.replace(/\/+$/, ""),
    apiPath: row.fields.apiPath,
    model: row.model,
  });
}
