import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalJsonValue } from "../utils/canonical-json.js";
import { canonicalJsonSha256, canonicalJsonStringify } from "../utils/canonical-json.js";

export const RESEARCH_PLUGIN_PROTOCOL_NAME = "contextstill-research-plugin" as const;
export const RESEARCH_PLUGIN_PROTOCOL_VERSION = "1.0" as const;
export const RESEARCH_PLUGIN_JSON_SCHEMA_SHA256 =
  "sha256:bfb3c41eef54f44504712e04365d8916a63d0d09b93577ff02d39ce993e1e29e" as const;
export const RESEARCH_RESULT_SCHEMA_VERSION = "contextstill-research-result-v1" as const;
export const RESEARCH_REQUEST_MAX_BYTES = 64 * 1024;
export const RESEARCH_RESULT_MAX_BYTES = 8 * 1024 * 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bareDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const capabilityTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/);
const versionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/);
const finiteNumberSchema = z
  .number()
  .refine(Number.isFinite, "research_plugin:number_must_be_finite");
const jsonValueSchema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumberSchema,
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = nonnegativeSafeIntegerSchema.min(1);
const boundedTextSchema = (max: number, min = 0) =>
  z.string().superRefine((value, ctx) => {
    let length = 0;
    for (const _character of value) {
      length += 1;
      if (length > max) {
        ctx.addIssue({ code: "custom", message: "research_plugin:text_too_long" });
        return;
      }
    }
    if (length < min) ctx.addIssue({ code: "custom", message: "research_plugin:text_too_short" });
  });
const safeTextSchema = (max: number) =>
  boundedTextSchema(max, 1)
    .refine((value) => value.normalize("NFC") === value, "research_plugin:non_canonical_unicode")
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
        }),
      "research_plugin:control_character_forbidden",
    );

function unique(values: readonly string[], ctx: z.RefinementCtx, path: (string | number)[]) {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path, message: "research_plugin:duplicate_value" });
  }
}

function duplicateIds(values: readonly { id: string }[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return duplicates;
}

function isCanonicalHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJsonStringify(value)).byteLength;
}

function omitKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function validateCanonicalHash(
  value: Record<string, unknown>,
  actual: string,
  path: (string | number)[],
  compute: (input: Record<string, unknown>) => string,
  ctx: z.RefinementCtx,
) {
  try {
    if (actual !== compute(value)) {
      ctx.addIssue({ code: "custom", path, message: "research_plugin:hash_mismatch" });
    }
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `research_plugin:non_canonical_json:${error instanceof Error ? error.message : "unknown"}`,
    });
  }
}

function validateCanonicalByteLimit(value: unknown, maxBytes: number, ctx: z.RefinementCtx) {
  try {
    if (utf8Bytes(value) > maxBytes) {
      ctx.addIssue({ code: "custom", message: "research_plugin:byte_limit_exceeded" });
    }
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: `research_plugin:non_canonical_json:${error instanceof Error ? error.message : "unknown"}`,
    });
  }
}

function validateStatusReason(
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled",
  reason: string | null,
  ctx: z.RefinementCtx,
) {
  if (["queued", "running", "completed"].includes(status) && reason !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "research_plugin:reason_for_unsuccessful_terminal_only",
    });
  }
  if (["partial", "failed", "cancelled"].includes(status) && reason === null) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "research_plugin:terminal_reason_required",
    });
  }
}

const protocolVersionRangeSchema = z
  .object({
    min: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    max: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
  })
  .strict();

const operationSchema = z.enum(["submit", "status", "result", "cancel", "acknowledge"]);
const outputKindSchema = z.enum([
  "report",
  "claims",
  "evidence",
  "knowledge_candidates",
  "episode_source",
]);
const optionalHostCapabilitySchema = z.enum([
  "llm_gateway",
  "knowledge_read",
  "source_connector",
  "usage_audit_sink",
]);

const budgetSchema = z
  .object({
    inputTokens: nonnegativeSafeIntegerSchema.optional(),
    outputTokens: nonnegativeSafeIntegerSchema.optional(),
    wallMs: positiveSafeIntegerSchema.optional(),
    searchRequests: nonnegativeSafeIntegerSchema.optional(),
    fetchRequests: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "research_plugin:budget_must_not_be_empty");

const repositoryIdentitySchema = z
  .object({
    scope: z.enum(["global", "repository"]),
    projectRef: identifierSchema.optional(),
    repoKey: safeTextSchema(512).optional(),
    repoPath: safeTextSchema(4096).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "repository" && !value.projectRef) {
      ctx.addIssue({
        code: "custom",
        path: ["projectRef"],
        message: "research_plugin:project_ref_required",
      });
    }
    if (
      value.repoPath &&
      !value.repoPath.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value.repoPath)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repoPath"],
        message: "research_plugin:repo_path_must_be_absolute",
      });
    }
  });

const principalSchema = z
  .object({
    principalRef: identifierSchema,
    principalClass: z.enum(["service", "user", "automation"]),
    authorizationScopeRefs: z.array(identifierSchema).max(50),
  })
  .strict()
  .superRefine((value, ctx) =>
    unique(value.authorizationScopeRefs, ctx, ["authorizationScopeRefs"]),
  );

export const resourceIdentitySchema = z
  .object({
    connectorKind: identifierSchema,
    connectorInstanceId: identifierSchema,
    resourceId: safeTextSchema(4096),
    revision: safeTextSchema(512).optional(),
    scopeRefs: z.array(identifierSchema).max(20).optional(),
    displayUrl: z.string().url().max(4096).optional(),
    visibility: z.enum(["public", "tenant", "container", "restricted", "private", "unknown"]),
    visibilityRef: identifierSchema,
    accessPolicyVersion: versionSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.scopeRefs) unique(value.scopeRefs, ctx, ["scopeRefs"]);
    if (value.connectorKind === "web") {
      if (!isCanonicalHttpUrl(value.resourceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["resourceId"],
          message: "research_plugin:invalid_web_resource",
        });
      }
      if (value.displayUrl && !isCanonicalHttpUrl(value.displayUrl)) {
        ctx.addIssue({
          code: "custom",
          path: ["displayUrl"],
          message: "research_plugin:invalid_web_display_url",
        });
      }
    }
  });

export const fragmentLocatorSchema = z
  .object({
    kind: identifierSchema,
    value: z.record(z.string(), z.union([z.string(), finiteNumberSchema, z.boolean()])),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.kind !== "utf8_bytes") return;
    const start = value.value.start;
    const end = value.value.end;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "research_plugin:invalid_utf8_byte_range",
      });
    }
  });

export const evidenceLocatorSchema = z
  .object({
    resource: resourceIdentitySchema,
    fragment: fragmentLocatorSchema,
    snapshotHash: bareDigestSchema,
    quoteHash: bareDigestSchema,
  })
  .passthrough();

const capabilityBodySchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(RESEARCH_PLUGIN_PROTOCOL_NAME),
        versions: protocolVersionRangeSchema,
      })
      .strict(),
    plugin: z.object({ id: identifierSchema, version: versionSchema }).strict(),
    engine: z.object({ id: identifierSchema, version: versionSchema }).strict(),
    operations: z.array(operationSchema).max(5),
    sourceKinds: z.array(identifierSchema).max(50),
    outputKinds: z.array(outputKindSchema).max(5),
    locatorKinds: z.array(capabilityTokenSchema).max(50),
    optionalHostCapabilities: z.array(optionalHostCapabilitySchema).max(4),
    limits: z
      .object({
        requestBytes: positiveSafeIntegerSchema.max(RESEARCH_REQUEST_MAX_BYTES),
        resultBytes: positiveSafeIntegerSchema.max(RESEARCH_RESULT_MAX_BYTES),
      })
      .strict(),
    lifecycle: z
      .object({
        retentionMode: z.enum(["manual_delete", "retained_until_ack", "time_bound"]),
        resultRetentionMinSeconds: positiveSafeIntegerSchema.nullable(),
        ackGraceMinSeconds: nonnegativeSafeIntegerSchema.nullable(),
      })
      .strict(),
  })
  .passthrough();

export function researchCapabilityHash(value: Record<string, unknown>): `sha256:${string}` {
  return canonicalJsonSha256(omitKeys(value, ["capabilityHash"]));
}

export const researchEngineCapabilitiesSchema = capabilityBodySchema
  .extend({ capabilityHash: digestSchema })
  .passthrough()
  .superRefine((value, ctx) => {
    unique(value.operations, ctx, ["operations"]);
    unique(value.sourceKinds, ctx, ["sourceKinds"]);
    unique(value.outputKinds, ctx, ["outputKinds"]);
    unique(value.locatorKinds, ctx, ["locatorKinds"]);
    unique(value.optionalHostCapabilities, ctx, ["optionalHostCapabilities"]);
    validateCanonicalHash(
      value,
      value.capabilityHash,
      ["capabilityHash"],
      researchCapabilityHash,
      ctx,
    );
    const acknowledges = value.operations.includes("acknowledge");
    if (value.lifecycle.retentionMode === "manual_delete") {
      if (
        value.lifecycle.resultRetentionMinSeconds !== null ||
        value.lifecycle.ackGraceMinSeconds !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["lifecycle"],
          message: "research_plugin:manual_retention_has_no_duration",
        });
      }
      if (acknowledges) {
        ctx.addIssue({
          code: "custom",
          path: ["operations"],
          message: "research_plugin:ack_requires_retention_support",
        });
      }
    } else {
      if (value.lifecycle.resultRetentionMinSeconds === null) {
        ctx.addIssue({
          code: "custom",
          path: ["lifecycle", "resultRetentionMinSeconds"],
          message: "research_plugin:retention_duration_required",
        });
      }
      if (value.lifecycle.retentionMode === "retained_until_ack") {
        if (!acknowledges) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "research_plugin:retained_until_ack_requires_ack_operation",
          });
        }
        if (value.lifecycle.ackGraceMinSeconds === null) {
          ctx.addIssue({
            code: "custom",
            path: ["lifecycle", "ackGraceMinSeconds"],
            message: "research_plugin:ack_grace_required",
          });
        }
      } else {
        if (acknowledges) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "research_plugin:time_bound_retention_does_not_acknowledge",
          });
        }
        if (value.lifecycle.ackGraceMinSeconds !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["lifecycle", "ackGraceMinSeconds"],
            message: "research_plugin:time_bound_retention_has_no_ack_grace",
          });
        }
      }
    }
  });

const submitSemanticSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    question: safeTextSchema(8 * 1024),
    purpose: identifierSchema,
    knownClaims: z
      .array(z.object({ id: identifierSchema, text: safeTextSchema(8 * 1024) }).strict())
      .max(50),
    requiredEvidence: z.array(safeTextSchema(2 * 1024)).max(50),
    forbiddenScopes: z.array(safeTextSchema(1024)).max(50),
    strategy: z.enum(["balanced", "diverse"]).optional(),
    targetBudget: budgetSchema.optional(),
    hardSafetyCeiling: budgetSchema,
    expectedOutputs: z.array(outputKindSchema).min(1).max(5),
    parentRef: z.object({ kind: identifierSchema, id: identifierSchema }).strict().optional(),
    repositoryIdentity: repositoryIdentitySchema.optional(),
    principal: principalSchema,
    sourceConstraints: z
      .array(
        z
          .object({
            connectorKind: identifierSchema,
            connectorInstanceId: identifierSchema.optional(),
            scopeRefs: z.array(identifierSchema).max(20),
          })
          .strict(),
      )
      .max(20),
  })
  .passthrough();

export function researchRequestHash(value: Record<string, unknown>): `sha256:${string}` {
  return canonicalJsonSha256(omitKeys(value, ["idempotencyKey", "requestHash"]));
}

export const researchSubmitRequestSchema = submitSemanticSchema
  .extend({ idempotencyKey: identifierSchema, requestHash: digestSchema })
  .passthrough()
  .superRefine((value, ctx) => {
    unique(value.expectedOutputs, ctx, ["expectedOutputs"]);
    unique(value.forbiddenScopes, ctx, ["forbiddenScopes"]);
    unique(value.requiredEvidence, ctx, ["requiredEvidence"]);
    unique(
      value.knownClaims.map((claim) => claim.id),
      ctx,
      ["knownClaims"],
    );
    unique(
      value.sourceConstraints.map(
        (constraint) =>
          `${constraint.connectorKind}\u0000${constraint.connectorInstanceId ?? ""}\u0000${constraint.scopeRefs.join("\u0000")}`,
      ),
      ctx,
      ["sourceConstraints"],
    );
    for (const [index, constraint] of value.sourceConstraints.entries()) {
      unique(constraint.scopeRefs, ctx, ["sourceConstraints", index, "scopeRefs"]);
    }
    if (value.targetBudget) {
      for (const key of [
        "inputTokens",
        "outputTokens",
        "wallMs",
        "searchRequests",
        "fetchRequests",
      ] as const) {
        const target = value.targetBudget[key];
        const hard = value.hardSafetyCeiling[key];
        if (target !== undefined && hard === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["hardSafetyCeiling", key],
            message: "research_plugin:hard_ceiling_required_for_target_dimension",
          });
        } else if (target !== undefined && hard !== undefined && target > hard) {
          ctx.addIssue({
            code: "custom",
            path: ["targetBudget", key],
            message: "research_plugin:target_budget_exceeds_hard_ceiling",
          });
        }
      }
    }
    validateCanonicalHash(value, value.requestHash, ["requestHash"], researchRequestHash, ctx);
    validateCanonicalByteLimit(value, RESEARCH_REQUEST_MAX_BYTES, ctx);
  });

export const researchJobRefSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    pluginJobId: identifierSchema,
    requestHash: digestSchema,
    created: z.boolean(),
  })
  .passthrough();

export const researchJobStatusSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    pluginJobId: identifierSchema,
    status: z.enum(["queued", "running", "completed", "partial", "failed", "cancelled"]),
    reason: identifierSchema.nullable(),
    resultAvailable: z.boolean(),
    annotations: z
      .array(z.object({ kind: identifierSchema, detail: safeTextSchema(2048) }).strict())
      .max(50),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    validateStatusReason(value.status, value.reason, ctx);
    if (["queued", "running"].includes(value.status) && value.resultAvailable) {
      ctx.addIssue({
        code: "custom",
        path: ["resultAvailable"],
        message: "research_plugin:non_terminal_result_unavailable",
      });
    }
    if (value.status === "completed" && !value.resultAvailable) {
      ctx.addIssue({
        code: "custom",
        path: ["resultAvailable"],
        message: "research_plugin:completed_result_required",
      });
    }
    if (value.status === "failed" && value.resultAvailable) {
      ctx.addIssue({
        code: "custom",
        path: ["resultAvailable"],
        message: "research_plugin:failed_result_unavailable",
      });
    }
  });

export const researchAcknowledgeRequestSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    pluginJobId: identifierSchema,
    resultHash: digestSchema,
  })
  .passthrough();

export const researchAcknowledgeResponseSchema = researchAcknowledgeRequestSchema
  .extend({ acknowledged: z.boolean() })
  .passthrough();

const claimSchema = z
  .object({
    id: identifierSchema,
    text: safeTextSchema(16 * 1024),
    kind: identifierSchema,
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(identifierSchema).min(1).max(200),
    relatedClaimIds: z.array(identifierSchema).max(200),
  })
  .passthrough();

const evidenceSchema = z
  .object({
    id: identifierSchema,
    claimIds: z.array(identifierSchema).min(1).max(200),
    quote: boundedTextSchema(4_000, 1),
    context: boundedTextSchema(12_000),
    locator: evidenceLocatorSchema,
  })
  .passthrough();

const reportSchema = z
  .object({
    artifactId: identifierSchema,
    version: positiveSafeIntegerSchema,
    title: safeTextSchema(1024),
    body: boundedTextSchema(2 * 1024 * 1024),
    claimIds: z.array(identifierSchema).max(200),
    limitations: z.array(safeTextSchema(8 * 1024)).max(100),
    openQuestions: z.array(safeTextSchema(8 * 1024)).max(100),
  })
  .passthrough();

const knowledgeCandidateSchema = z
  .object({
    id: identifierSchema,
    type: z.enum(["rule", "procedure"]),
    polarity: z.enum(["positive", "negative"]),
    title: safeTextSchema(1024),
    body: safeTextSchema(32 * 1024),
    claimIds: z.array(identifierSchema).min(1).max(200),
    appliesTo: z.record(z.string(), z.array(safeTextSchema(512))).optional(),
    verification: z
      .array(safeTextSchema(4 * 1024))
      .min(1)
      .max(50),
  })
  .passthrough();

const episodeSourceSchema = z
  .object({
    sourceId: identifierSchema,
    title: safeTextSchema(1024),
    situation: safeTextSchema(16 * 1024),
    actions: z
      .array(safeTextSchema(8 * 1024))
      .min(1)
      .max(100),
    outcome: safeTextSchema(16 * 1024),
    lessons: z.array(safeTextSchema(8 * 1024)).max(100),
    openLoops: z.array(safeTextSchema(8 * 1024)).max(100),
    claimIds: z.array(identifierSchema).max(200),
    eventRefs: z.array(identifierSchema).max(500),
  })
  .passthrough();

const resultBodySchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_RESULT_SCHEMA_VERSION),
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    requestHash: digestSchema,
    execution: z
      .object({
        pluginJobId: identifierSchema,
        status: z.enum(["completed", "partial", "failed", "cancelled"]),
        reason: identifierSchema.nullable(),
        resultAvailable: z.boolean(),
        engine: z
          .object({
            id: identifierSchema,
            version: versionSchema,
            recipeVersion: safeTextSchema(256),
          })
          .strict(),
        usage: z
          .object({
            totalTokens: nonnegativeSafeIntegerSchema,
            inputTokens: nonnegativeSafeIntegerSchema.optional(),
            outputTokens: nonnegativeSafeIntegerSchema.optional(),
            llmRequests: nonnegativeSafeIntegerSchema,
            searchRequests: nonnegativeSafeIntegerSchema.optional(),
            fetchRequests: nonnegativeSafeIntegerSchema.optional(),
            wallMs: nonnegativeSafeIntegerSchema.optional(),
          })
          .strict(),
        targetBudgetExceeded: z.boolean(),
      })
      .passthrough(),
    report: reportSchema.nullable(),
    claims: z.array(claimSchema).max(200),
    evidencePackages: z.array(evidenceSchema).max(200),
    knowledgeCandidates: z.array(knowledgeCandidateSchema).max(10),
    episodeSource: episodeSourceSchema.nullable(),
    omissions: z
      .array(
        z
          .object({
            kind: identifierSchema,
            count: positiveSafeIntegerSchema,
            reason: identifierSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .passthrough();

export function researchResultHash(value: Record<string, unknown>): `sha256:${string}` {
  return canonicalJsonSha256(omitKeys(value, ["resultHash"]));
}

export const researchResultSchema = resultBodySchema
  .extend({ resultHash: digestSchema })
  .passthrough()
  .superRefine((value, ctx) => {
    validateCanonicalHash(value, value.resultHash, ["resultHash"], researchResultHash, ctx);
    validateCanonicalByteLimit(value, RESEARCH_RESULT_MAX_BYTES, ctx);
    validateStatusReason(value.execution.status, value.execution.reason, ctx);
    const claimIds = new Set(value.claims.map((claim) => claim.id));
    const evidenceIds = new Set(value.evidencePackages.map((evidence) => evidence.id));
    for (const [field, items] of [
      ["claims", value.claims],
      ["evidencePackages", value.evidencePackages],
      ["knowledgeCandidates", value.knowledgeCandidates],
    ] as const) {
      if (duplicateIds(items).size > 0)
        ctx.addIssue({ code: "custom", path: [field], message: "research_plugin:duplicate_id" });
    }
    for (const [index, claim] of value.claims.entries()) {
      unique(claim.evidenceIds, ctx, ["claims", index, "evidenceIds"]);
      unique(claim.relatedClaimIds, ctx, ["claims", index, "relatedClaimIds"]);
      if (claim.evidenceIds.some((id) => !evidenceIds.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["claims", index, "evidenceIds"],
          message: "research_plugin:dangling_evidence_ref",
        });
      if (claim.relatedClaimIds.some((id) => !claimIds.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["claims", index, "relatedClaimIds"],
          message: "research_plugin:dangling_claim_ref",
        });
      for (const evidenceId of claim.evidenceIds) {
        const evidence = value.evidencePackages.find((candidate) => candidate.id === evidenceId);
        if (evidence && !evidence.claimIds.includes(claim.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["claims", index, "evidenceIds"],
            message: "research_plugin:asymmetric_claim_evidence_ref",
          });
        }
      }
    }
    for (const [index, evidence] of value.evidencePackages.entries()) {
      unique(evidence.claimIds, ctx, ["evidencePackages", index, "claimIds"]);
      if (evidence.claimIds.some((id) => !claimIds.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["evidencePackages", index, "claimIds"],
          message: "research_plugin:dangling_claim_ref",
        });
      const quoteHash = createHash("sha256").update(evidence.quote).digest("hex");
      if (quoteHash !== evidence.locator.quoteHash)
        ctx.addIssue({
          code: "custom",
          path: ["evidencePackages", index, "locator", "quoteHash"],
          message: "research_plugin:quote_hash_mismatch",
        });
      if (!evidence.context.includes(evidence.quote)) {
        ctx.addIssue({
          code: "custom",
          path: ["evidencePackages", index, "context"],
          message: "research_plugin:context_missing_quote",
        });
      }
      if (evidence.locator.fragment.kind === "utf8_bytes") {
        const start = evidence.locator.fragment.value.start;
        const end = evidence.locator.fragment.value.end;
        if (
          typeof start === "number" &&
          typeof end === "number" &&
          end - start !== Buffer.byteLength(evidence.quote)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["evidencePackages", index, "locator", "fragment"],
            message: "research_plugin:utf8_range_quote_length_mismatch",
          });
        }
      }
      for (const claimId of evidence.claimIds) {
        const claim = value.claims.find((candidate) => candidate.id === claimId);
        if (claim && !claim.evidenceIds.includes(evidence.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["evidencePackages", index, "claimIds"],
            message: "research_plugin:asymmetric_claim_evidence_ref",
          });
        }
      }
    }
    if (value.report) unique(value.report.claimIds, ctx, ["report", "claimIds"]);
    if (value.report?.claimIds.some((id) => !claimIds.has(id)))
      ctx.addIssue({
        code: "custom",
        path: ["report", "claimIds"],
        message: "research_plugin:dangling_claim_ref",
      });
    for (const [index, candidate] of value.knowledgeCandidates.entries()) {
      unique(candidate.claimIds, ctx, ["knowledgeCandidates", index, "claimIds"]);
      unique(candidate.verification, ctx, ["knowledgeCandidates", index, "verification"]);
      for (const [key, items] of Object.entries(candidate.appliesTo ?? {})) {
        unique(items, ctx, ["knowledgeCandidates", index, "appliesTo", key]);
      }
      if (candidate.claimIds.some((id) => !claimIds.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["knowledgeCandidates", index, "claimIds"],
          message: "research_plugin:dangling_claim_ref",
        });
    }
    if (value.episodeSource) {
      unique(value.episodeSource.claimIds, ctx, ["episodeSource", "claimIds"]);
      unique(value.episodeSource.eventRefs, ctx, ["episodeSource", "eventRefs"]);
    }
    if (value.episodeSource?.claimIds.some((id) => !claimIds.has(id)))
      ctx.addIssue({
        code: "custom",
        path: ["episodeSource", "claimIds"],
        message: "research_plugin:dangling_claim_ref",
      });
    const hasArtifact = Boolean(
      value.report ||
        value.claims.length > 0 ||
        value.evidencePackages.length > 0 ||
        value.knowledgeCandidates.length > 0 ||
        value.episodeSource,
    );
    if (value.execution.resultAvailable && !hasArtifact)
      ctx.addIssue({
        code: "custom",
        path: ["execution", "resultAvailable"],
        message: "research_plugin:available_result_requires_artifact",
      });
    if (!value.execution.resultAvailable && hasArtifact)
      ctx.addIssue({
        code: "custom",
        path: ["execution", "resultAvailable"],
        message: "research_plugin:artifact_requires_available_result",
      });
    if (value.execution.status === "completed" && !value.execution.resultAvailable)
      ctx.addIssue({
        code: "custom",
        path: ["execution", "resultAvailable"],
        message: "research_plugin:completed_result_required",
      });
    if (value.execution.status === "failed" && value.execution.resultAvailable)
      ctx.addIssue({
        code: "custom",
        path: ["execution", "resultAvailable"],
        message: "research_plugin:failed_result_unavailable",
      });
    const { inputTokens, outputTokens, totalTokens } = value.execution.usage;
    if (
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      inputTokens + outputTokens !== totalTokens
    )
      ctx.addIssue({
        code: "custom",
        path: ["execution", "usage", "totalTokens"],
        message: "research_plugin:token_total_mismatch",
      });
  });

const sourceConnectorCapabilityBodySchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    connectorKind: identifierSchema,
    connectorInstanceId: identifierSchema,
    operations: z
      .array(z.enum(["search", "fetch"]))
      .min(1)
      .max(2),
    locatorKinds: z.array(capabilityTokenSchema).min(1).max(50),
    maxSearchResults: positiveSafeIntegerSchema.max(200),
    maxFetchBytes: positiveSafeIntegerSchema.max(RESEARCH_RESULT_MAX_BYTES),
  })
  .passthrough();

export function sourceConnectorCapabilityHash(value: Record<string, unknown>): `sha256:${string}` {
  return canonicalJsonSha256(omitKeys(value, ["capabilityHash"]));
}

export const sourceConnectorCapabilitiesSchema = sourceConnectorCapabilityBodySchema
  .extend({ capabilityHash: digestSchema })
  .passthrough()
  .superRefine((value, ctx) => {
    unique(value.operations, ctx, ["operations"]);
    unique(value.locatorKinds, ctx, ["locatorKinds"]);
    validateCanonicalHash(
      value,
      value.capabilityHash,
      ["capabilityHash"],
      sourceConnectorCapabilityHash,
      ctx,
    );
  });

export const sourceSearchRequestSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    query: safeTextSchema(8 * 1024),
    limit: positiveSafeIntegerSchema.max(200),
    principal: principalSchema,
    scopeRefs: z.array(identifierSchema).max(50),
  })
  .passthrough()
  .superRefine((value, ctx) => unique(value.scopeRefs, ctx, ["scopeRefs"]));

export const sourceSearchHitSchema = z
  .object({
    resource: resourceIdentitySchema,
    title: safeTextSchema(1024),
    snippet: boundedTextSchema(16 * 1024),
    rank: nonnegativeSafeIntegerSchema,
  })
  .passthrough();

export const sourceSearchResponseSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    connectorInstanceId: identifierSchema,
    hits: z.array(sourceSearchHitSchema).max(200),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const identities = value.hits.map(
      (hit) =>
        `${hit.resource.connectorKind}\u0000${hit.resource.connectorInstanceId}\u0000${hit.resource.resourceId}\u0000${hit.resource.revision ?? ""}`,
    );
    unique(identities, ctx, ["hits"]);
    if (value.hits.some((hit) => hit.resource.connectorInstanceId !== value.connectorInstanceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["hits"],
        message: "research_plugin:connector_instance_mismatch",
      });
    }
  });

export const sourceFetchRequestSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    resource: resourceIdentitySchema,
    fragment: fragmentLocatorSchema.optional(),
    principal: principalSchema,
  })
  .passthrough();

export const sourceSnapshotSchema = z
  .object({
    protocolVersion: z.literal(RESEARCH_PLUGIN_PROTOCOL_VERSION),
    resource: resourceIdentitySchema,
    title: safeTextSchema(1024),
    text: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= RESEARCH_RESULT_MAX_BYTES,
        "research_plugin:snapshot_byte_limit_exceeded",
      ),
    snapshotHash: bareDigestSchema,
    fetchedAt: z.string().datetime({ offset: true }),
    truncated: z.boolean(),
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const snapshotHash = createHash("sha256").update(value.text).digest("hex");
    if (snapshotHash !== value.snapshotHash) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshotHash"],
        message: "research_plugin:snapshot_hash_mismatch",
      });
    }
  });

export type ResearchEngineCapabilities = z.infer<typeof researchEngineCapabilitiesSchema>;
export type ResearchSubmitRequest = z.infer<typeof researchSubmitRequestSchema>;
export type ResearchJobRef = z.infer<typeof researchJobRefSchema>;
export type ResearchJobStatus = z.infer<typeof researchJobStatusSchema>;
export type ResearchAcknowledgeRequest = z.infer<typeof researchAcknowledgeRequestSchema>;
export type ResearchAcknowledgeResponse = z.infer<typeof researchAcknowledgeResponseSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;
export type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
export type SourceConnectorCapabilities = z.infer<typeof sourceConnectorCapabilitiesSchema>;
export type SourceSearchRequest = z.infer<typeof sourceSearchRequestSchema>;
export type SourceSearchHit = z.infer<typeof sourceSearchHitSchema>;
export type SourceSearchResponse = z.infer<typeof sourceSearchResponseSchema>;
export type SourceFetchRequest = z.infer<typeof sourceFetchRequestSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
