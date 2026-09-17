import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  researchAcknowledgeRequestSchema,
  researchAcknowledgeResponseSchema,
  researchCapabilityHash,
  researchEngineCapabilitiesSchema,
  researchJobRefSchema,
  researchJobStatusSchema,
  researchRequestHash,
  researchResultHash,
  researchResultSchema,
  researchSubmitRequestSchema,
  RESEARCH_PLUGIN_JSON_SCHEMA_SHA256,
  sourceConnectorCapabilityHash,
  sourceConnectorCapabilitiesSchema,
  sourceSearchResponseSchema,
  sourceSnapshotSchema,
} from "../src/shared/schemas/research-plugin-v1.schema.js";
import { canonicalJsonSha256, canonicalJsonStringify } from "../src/shared/utils/canonical-json.js";

type Fixture = {
  host: {
    capabilities: Record<string, unknown>;
    request: Record<string, unknown>;
    results: Record<string, Record<string, unknown>>;
  };
  deepStill: {
    commit: string;
    capabilities: {
      pluginId: string;
      pluginVersion: string;
      engine: { id: string; version: string };
      operations: string[];
      sourceKinds: string[];
      outputKinds: string[];
      locatorKinds: string[];
      optionalHostCapabilities: string[];
    };
    projection: {
      projectionVersion: string;
      resultHash: string;
      execution: {
        jobId: string;
        status: "completed" | "partial" | "failed" | "cancelled";
        reason: string | null;
        resultAvailable: boolean;
        engineVersion: number;
        recipeVersion: string;
        usage: { tokens: number; requests: number; queries: number; urls: number };
      };
      report: null | {
        id: string;
        version: number;
        title: string;
        body: string;
        claimIds: string[];
        limitations?: string[];
        openQuestions?: string[];
      };
      claims: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown> & { locator: { resource: Record<string, unknown> } }>;
    };
  };
};

function fixture(): Fixture {
  return JSON.parse(
    readFileSync(new URL("../shared/fixtures/research-plugin-v1.json", import.meta.url), "utf8"),
  ) as Fixture;
}

function hostCapabilitiesFromDeepStill(input: Fixture["deepStill"]["capabilities"]) {
  const body = {
    protocol: {
      name: "contextstill-research-plugin" as const,
      versions: { min: "1.0" as const, max: "1.0" as const },
    },
    plugin: { id: input.pluginId, version: input.pluginVersion },
    engine: input.engine,
    operations: input.operations,
    sourceKinds: input.sourceKinds,
    outputKinds: input.outputKinds.filter((kind) =>
      ["report", "claims", "evidence"].includes(kind),
    ),
    locatorKinds: input.locatorKinds,
    optionalHostCapabilities: input.optionalHostCapabilities,
    limits: { requestBytes: 65_536, resultBytes: 8_388_608 },
    lifecycle: {
      retentionMode: "manual_delete" as const,
      resultRetentionMinSeconds: null,
      ackGraceMinSeconds: null,
    },
  };
  return { ...body, capabilityHash: researchCapabilityHash(body) };
}

function hostResultFromDeepStill(input: Fixture["deepStill"]["projection"], requestHash: string) {
  const body = {
    schemaVersion: "contextstill-research-result-v1" as const,
    protocolVersion: "1.0" as const,
    requestHash,
    execution: {
      pluginJobId: input.execution.jobId,
      status: input.execution.status,
      reason: input.execution.reason,
      resultAvailable: input.execution.resultAvailable,
      engine: {
        id: "deepstill-round",
        version: String(input.execution.engineVersion),
        recipeVersion: input.execution.recipeVersion,
      },
      usage: {
        totalTokens: input.execution.usage.tokens,
        llmRequests: input.execution.usage.requests,
        searchRequests: input.execution.usage.queries,
        fetchRequests: input.execution.usage.urls,
      },
      targetBudgetExceeded: false,
    },
    report: input.report
      ? {
          artifactId: input.report.id,
          version: input.report.version,
          title: input.report.title,
          body: input.report.body,
          claimIds: input.report.claimIds,
          limitations: input.report.limitations ?? [],
          openQuestions: input.report.openQuestions ?? [],
        }
      : null,
    claims: input.claims.map((claim) => ({ ...claim, kind: String(claim.kind).toLowerCase() })),
    evidencePackages: input.evidence.map((evidence) => ({
      ...evidence,
      locator: {
        ...evidence.locator,
        resource: { ...evidence.locator.resource, visibility: "unknown" },
      },
    })),
    knowledgeCandidates: [],
    episodeSource: null,
    omissions: [],
  };
  return { ...body, resultHash: researchResultHash(body) };
}

describe("research plugin v1 host contract", () => {
  it("publishes a standalone JSON Schema that accepts the golden corpus", () => {
    const schemaBytes = readFileSync(
      new URL("../shared/contracts/research-plugin-v1.schema.json", import.meta.url),
    );
    expect(`sha256:${createHash("sha256").update(schemaBytes).digest("hex")}`).toBe(
      RESEARCH_PLUGIN_JSON_SCHEMA_SHA256,
    );
    const schema = JSON.parse(schemaBytes.toString("utf8")) as Record<string, unknown>;
    const schemaId = "https://contextstill.local/contracts/research-plugin-v1.schema.json";
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    ajv.addSchema(schema, schemaId);
    const validate = (definition: string, value: unknown) => {
      const validator = ajv.compile({ $ref: `${schemaId}#/$defs/${definition}` });
      expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
    };
    const input = fixture().host;
    validate("researchEngineCapabilities", input.capabilities);
    validate("researchSubmitRequest", input.request);
    for (const result of Object.values(input.results)) validate("researchResult", result);

    const unsafeIntegerRequest = structuredClone(input.request) as {
      hardSafetyCeiling: { wallMs: number };
    };
    unsafeIntegerRequest.hardSafetyCeiling.wallMs = Number.MAX_SAFE_INTEGER + 1;
    const requestValidator = ajv.compile({
      $ref: `${schemaId}#/$defs/researchSubmitRequest`,
    });
    expect(requestValidator(unsafeIntegerRequest)).toBe(false);
  });

  it("freezes canonical JSON independently of object key order", () => {
    const first = { z: [3, { b: true, a: "値" }], a: null };
    const second = { a: null, z: [3, { a: "値", b: true }] };
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
    expect(() => canonicalJsonStringify({ value: Number.POSITIVE_INFINITY })).toThrow(
      "canonical_json:number_must_be_finite",
    );
    expect(() => canonicalJsonStringify({ value: "e\u0301" })).toThrow(
      "canonical_json:unicode_must_be_nfc",
    );
    expect(() => canonicalJsonStringify({ [Symbol("hidden")]: true })).toThrow(
      "canonical_json:symbol_keys_not_supported",
    );
  });

  it("validates the frozen capability and submit fixtures", () => {
    const input = fixture().host;
    const capabilities = researchEngineCapabilitiesSchema.parse(input.capabilities);
    const request = researchSubmitRequestSchema.parse(input.request);
    expect(capabilities.capabilityHash).toBe(
      "sha256:6275450e02b6344231be1c5d6debf4fc3e19810d6656940766724b8035b79c4c",
    );
    expect(capabilities.capabilityHash).toBe(researchCapabilityHash(input.capabilities));
    expect(request.requestHash).toBe(
      "sha256:78cb9add394773f96c32159fa92bcfff00a87a91330dd3e666cea3b636b1415d",
    );
    expect(request.requestHash).toBe(researchRequestHash(input.request));
    expect(request.repositoryIdentity?.projectRef).toBe("project:fixture");
  });

  it("maps the DeepStill boundary fixture without treating it as the host contract", () => {
    const input = fixture();
    expect(input.deepStill.commit).toBe("c970f64170ee5254726bb9a9ac0fb083386c1a13");
    const { resultHash: deepStillResultHash, ...deepStillProjectionBody } =
      input.deepStill.projection;
    expect(canonicalJsonSha256(deepStillProjectionBody).slice("sha256:".length)).toBe(
      deepStillResultHash,
    );
    expect(researchEngineCapabilitiesSchema.safeParse(input.deepStill.capabilities).success).toBe(
      false,
    );
    const mapped = researchEngineCapabilitiesSchema.parse(
      hostCapabilitiesFromDeepStill(input.deepStill.capabilities),
    );
    expect(mapped.plugin.id).toBe("deepstill");
    expect(mapped.operations).toEqual([]);
    expect(mapped.outputKinds).toEqual(["report", "claims", "evidence"]);
    expect(mapped.lifecycle.retentionMode).toBe("manual_delete");
    const mappedResult = researchResultSchema.parse(
      hostResultFromDeepStill(input.deepStill.projection, String(input.host.request.requestHash)),
    );
    expect(mappedResult.execution.pluginJobId).toBe("deepstill-job-fixture");
    expect(mappedResult.evidencePackages[0]?.locator.resource.visibility).toBe("unknown");
  });

  it("accepts deterministic completed, partial, failed, and cancelled results", () => {
    const results = fixture().host.results;
    const expectedHashes: Record<string, string> = {
      completed: "sha256:2c39c3a3adce251a3a24278a1e28e684dfc1cfa9b5bfcc119d31eb5bf05e018c",
      partial: "sha256:05c54f3fddb6d05df5f302da5d6138f09873cfe14f8251e6b38f69e0b0eb62f5",
      failed: "sha256:5574c4180912ba0506bb3f7f6b37cd4bc14aabe40108844d9140822ae7655731",
      cancelled: "sha256:9da3d6a5e5e33a3ac4780eb1f8f02f3d0a54be40682f6b0a453d0d9bb75844be",
    };
    expect(Object.keys(results)).toEqual(["completed", "partial", "failed", "cancelled"]);
    for (const [status, raw] of Object.entries(results)) {
      const parsed = researchResultSchema.parse(raw);
      expect(parsed.execution.status).toBe(status);
      expect(parsed.resultHash).toBe(expectedHashes[status]);
      expect(parsed.resultHash).toBe(researchResultHash(raw));
    }
  });

  it("binds unknown minor fields into hashes while excluding idempotency keys", () => {
    const request = structuredClone(fixture().host.request);
    const originalHash = researchRequestHash(request);
    request.idempotencyKey = "coveringEvidence:fixture:retry";
    expect(researchRequestHash(request)).toBe(originalHash);
    request.futureMinorField = { enabled: true };
    expect(researchRequestHash(request)).not.toBe(originalHash);
    request.futureMinorField = undefined;
    expect(() => researchSubmitRequestSchema.safeParse(request)).not.toThrow();
    expect(researchSubmitRequestSchema.safeParse(request).success).toBe(true);
    request.futureMinorField = new Date("2026-09-18T00:00:00.000Z");
    expect(() => researchSubmitRequestSchema.safeParse(request)).not.toThrow();
    expect(researchSubmitRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects inconsistent budgets, lifecycle declarations, and terminal states", () => {
    const request = structuredClone(fixture().host.request) as {
      targetBudget: { wallMs: number };
      requestHash: string;
    };
    request.targetBudget.wallMs = 100_000;
    request.requestHash = researchRequestHash(request);
    expect(researchSubmitRequestSchema.safeParse(request).success).toBe(false);

    const unsafeIntegerRequest = structuredClone(fixture().host.request) as {
      hardSafetyCeiling: { wallMs: number };
      requestHash: string;
    };
    unsafeIntegerRequest.hardSafetyCeiling.wallMs = Number.MAX_SAFE_INTEGER + 1;
    unsafeIntegerRequest.requestHash = researchRequestHash(unsafeIntegerRequest);
    expect(researchSubmitRequestSchema.safeParse(unsafeIntegerRequest).success).toBe(false);

    const emptyRepoPathRequest = structuredClone(fixture().host.request) as {
      repositoryIdentity: { repoPath: string };
      requestHash: string;
    };
    emptyRepoPathRequest.repositoryIdentity.repoPath = "";
    emptyRepoPathRequest.requestHash = researchRequestHash(emptyRepoPathRequest);
    expect(researchSubmitRequestSchema.safeParse(emptyRepoPathRequest).success).toBe(false);

    const capabilities = structuredClone(fixture().host.capabilities) as {
      operations: string[];
      lifecycle: {
        retentionMode: string;
        resultRetentionMinSeconds: number | null;
        ackGraceMinSeconds: number | null;
      };
      capabilityHash: string;
    };
    capabilities.operations = ["acknowledge"];
    capabilities.lifecycle = {
      retentionMode: "retained_until_ack",
      resultRetentionMinSeconds: 3600,
      ackGraceMinSeconds: null,
    };
    capabilities.capabilityHash = researchCapabilityHash(capabilities);
    expect(researchEngineCapabilitiesSchema.safeParse(capabilities).success).toBe(false);

    expect(
      researchJobStatusSchema.safeParse({
        protocolVersion: "1.0",
        pluginJobId: "job",
        status: "completed",
        reason: null,
        resultAvailable: false,
        annotations: [],
      }).success,
    ).toBe(false);
    expect(
      researchJobStatusSchema.safeParse({
        protocolVersion: "1.0",
        pluginJobId: "job",
        status: "failed",
        reason: null,
        resultAvailable: false,
        annotations: [],
      }).success,
    ).toBe(false);

    const failedWithArtifact = structuredClone(fixture().host.results.completed) as {
      execution: { status: string; resultAvailable: boolean; reason: string | null };
      resultHash: string;
    };
    failedWithArtifact.execution.status = "failed";
    failedWithArtifact.execution.reason = "provider_error";
    failedWithArtifact.resultHash = researchResultHash(failedWithArtifact);
    expect(researchResultSchema.safeParse(failedWithArtifact).success).toBe(false);
  });

  it("rejects hash conflicts, dangling refs, changed quotes, and invalid web resources", () => {
    const input = fixture().host;
    const wrongRequest = structuredClone(input.request);
    wrongRequest.question = "A changed question";
    expect(researchSubmitRequestSchema.safeParse(wrongRequest).success).toBe(false);

    const dangling = structuredClone(input.results.completed) as {
      claims: Array<{ evidenceIds: string[] }>;
      resultHash: string;
    };
    const firstClaim = dangling.claims[0];
    if (!firstClaim) throw new Error("fixture must contain a claim");
    firstClaim.evidenceIds = ["missing-evidence"];
    dangling.resultHash = researchResultHash(dangling);
    expect(researchResultSchema.safeParse(dangling).success).toBe(false);

    const changedQuote = structuredClone(input.results.completed) as {
      evidencePackages: Array<{ quote: string }>;
      resultHash: string;
    };
    const firstEvidence = changedQuote.evidencePackages[0];
    if (!firstEvidence) throw new Error("fixture must contain evidence");
    firstEvidence.quote = "Changed quote.";
    changedQuote.resultHash = researchResultHash(changedQuote);
    expect(researchResultSchema.safeParse(changedQuote).success).toBe(false);

    const invalidWeb = structuredClone(input.results.completed) as {
      evidencePackages: Array<{ locator: { resource: { resourceId: string } } }>;
      resultHash: string;
    };
    const webEvidence = invalidWeb.evidencePackages[0];
    if (!webEvidence) throw new Error("fixture must contain web evidence");
    webEvidence.locator.resource.resourceId = "file:///private/source";
    invalidWeb.resultHash = researchResultHash(invalidWeb);
    expect(researchResultSchema.safeParse(invalidWeb).success).toBe(false);

    const asymmetric = structuredClone(input.results.completed) as {
      evidencePackages: Array<{ claimIds: string[] }>;
      resultHash: string;
    };
    const linkedEvidence = asymmetric.evidencePackages[0];
    if (!linkedEvidence) throw new Error("fixture must contain linked evidence");
    linkedEvidence.claimIds = [];
    asymmetric.resultHash = researchResultHash(asymmetric);
    expect(researchResultSchema.safeParse(asymmetric).success).toBe(false);
  });

  it("keeps SourceConnector capabilities transport-independent", () => {
    const body = {
      protocolVersion: "1.0" as const,
      connectorKind: "slack",
      connectorInstanceId: "workspace-fixture",
      operations: ["search", "fetch"] as const,
      locatorKinds: ["message", "thread"],
      maxSearchResults: 100,
      maxFetchBytes: 262_144,
    };
    expect(
      sourceConnectorCapabilitiesSchema.parse({
        ...body,
        operations: [...body.operations],
        capabilityHash: sourceConnectorCapabilityHash(body),
      }),
    ).toMatchObject({ connectorKind: "slack", operations: ["search", "fetch"] });
  });

  it("validates SourceConnector responses and operation receipts", () => {
    const resource = {
      connectorKind: "slack",
      connectorInstanceId: "workspace-fixture",
      resourceId: "message-1",
      revision: "1700000000.000001",
      scopeRefs: ["channel:fixture"],
      visibility: "restricted",
      visibilityRef: "policy:fixture",
    };
    expect(
      sourceSearchResponseSchema.parse({
        protocolVersion: "1.0",
        connectorInstanceId: "workspace-fixture",
        hits: [{ resource, title: "Fixture message", snippet: "A result", rank: 0 }],
      }).hits,
    ).toHaveLength(1);

    const text = "Immutable connector snapshot.";
    const snapshotHash = createHash("sha256").update(text).digest("hex");
    expect(
      sourceSnapshotSchema.parse({
        protocolVersion: "1.0",
        resource,
        title: "Fixture message",
        text,
        snapshotHash,
        fetchedAt: "2026-09-18T00:00:00.000Z",
        truncated: false,
        metadata: { page: 1, labels: ["fixture", null] },
      }).snapshotHash,
    ).toBe(snapshotHash);
    expect(
      sourceSnapshotSchema.safeParse({
        protocolVersion: "1.0",
        resource,
        title: "Fixture message",
        text,
        snapshotHash: "0".repeat(64),
        fetchedAt: "2026-09-18T00:00:00.000Z",
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      sourceSnapshotSchema.safeParse({
        protocolVersion: "1.0",
        resource,
        title: "Fixture message",
        text,
        snapshotHash,
        fetchedAt: "2026-09-18T00:00:00.000Z",
        truncated: false,
        metadata: {
          fetchedBy: new Date("2026-09-18T00:00:00.000Z"),
          invalidNumber: Number.POSITIVE_INFINITY,
        },
      }).success,
    ).toBe(false);

    const requestHash = String(fixture().host.request.requestHash);
    expect(
      researchJobRefSchema.parse({
        protocolVersion: "1.0",
        pluginJobId: "job",
        requestHash,
        created: true,
      }).created,
    ).toBe(true);
    const acknowledgement = {
      protocolVersion: "1.0" as const,
      pluginJobId: "job",
      resultHash: String(fixture().host.results.completed.resultHash),
    };
    expect(researchAcknowledgeRequestSchema.parse(acknowledgement)).toBeDefined();
    expect(
      researchAcknowledgeResponseSchema.parse({ ...acknowledgement, acknowledged: true })
        .acknowledged,
    ).toBe(true);
  });
});
