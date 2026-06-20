import { redactSecrets } from "../../shared/utils/secret-redaction.js";
import type {
  CoverEvidenceCandidate,
  CoverEvidenceDuplicateRef,
  CoverEvidenceReference,
  CoverEvidenceToolEvent,
} from "../coverEvidence/types.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";

export type FinalizeCandidateContext = {
  foundCandidateId: string;
  targetStateId?: string | null;
  findCandidateResultId?: string | null;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  targetKey: string;
  sourceUri: string;
};

export type FinalizeReplacementKind =
  | "secret"
  | "absolute_path"
  | "project_identifier"
  | "internal_url"
  | "branch_or_ticket"
  | "repo_scope";

export type FinalizeAnonymizationSummary = {
  applied: boolean;
  version: 1;
  replacementKinds: FinalizeReplacementKind[];
  replacementCounts: Partial<Record<FinalizeReplacementKind, number>>;
  removedApplicabilityScopes: string[];
};

export type FinalizeSummary = {
  decision: "stored" | "dry_run" | "rejected";
  reason: string;
  anonymization: FinalizeAnonymizationSummary;
  qualityGates: string[];
  llmAssist: {
    enabled: false;
    applied: false;
  };
};

export type FinalizePreparedCandidate = {
  candidate: CoverEvidenceCandidate;
  references: CoverEvidenceReference[];
  duplicateRefs: CoverEvidenceDuplicateRef[];
  toolEvents: CoverEvidenceToolEvent[];
  anonymization: FinalizeAnonymizationSummary;
};

type ReplacementRule = {
  kind: FinalizeReplacementKind;
  pattern: RegExp;
  replacement: string;
};

const EMPTY_ANONYMIZATION: FinalizeAnonymizationSummary = {
  applied: false,
  version: 1,
  replacementKinds: [],
  replacementCounts: {},
  removedApplicabilityScopes: [],
};

const ABSOLUTE_PATH_PATTERN =
  /(?:\/Users\/[^\s`'"(),;]+|\/home\/[^\s`'"(),;]+|\/var\/[^\s`'"(),;]+|\/opt\/[^\s`'"(),;]+)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s`'"(),;]+/g;
const INTERNAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Za-z0-9.-]+\.internal|[A-Za-z0-9.-]+\.local)(?::\d+)?[^\s`'"()]*/gi;
const BRANCH_OR_TICKET_PATTERN =
  /\b(?:feature|bugfix|hotfix|release|codex|task|ticket|issue|jira|gh)[/_-][A-Za-z0-9._/-]{3,}\b/gi;

function normalizeBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIdentifierToken(value: string): string {
  return value
    .replace(/\.[A-Za-z0-9]+$/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, " ")
    .trim();
}

function identifierCandidatesFromValue(value: string | null | undefined): string[] {
  if (!value) return [];
  const tokens = new Set<string>();
  for (const part of value.split(/[\\/]/g)) {
    const normalized = normalizeIdentifierToken(part);
    if (isProjectIdentifierCandidate(normalized)) tokens.add(normalized);
  }
  return [...tokens];
}

function isProjectIdentifierCandidate(value: string): boolean {
  if (value.length < 4 || value.length > 48) return false;
  const lowered = value.toLowerCase();
  if (
    [
      "src",
      "test",
      "tests",
      "docs",
      "pages",
      "wiki",
      "index",
      "module",
      "modules",
      "service",
      "domain",
      "repository",
      "typescript",
      "javascript",
      "postgres",
      "sqlite",
      "vitest",
    ].includes(lowered)
  ) {
    return false;
  }
  return /[A-Z]/.test(value) || /[-_]/.test(value);
}

function replacementRules(params: {
  candidate: CoverEvidenceCandidate;
  context: FinalizeCandidateContext;
  references: CoverEvidenceReference[];
}): ReplacementRule[] {
  const identifiers = new Set<string>();
  for (const value of [
    params.candidate.repoPath,
    params.candidate.repoKey,
    params.context.targetKey,
    params.context.sourceUri,
    ...params.references.map((reference) => reference.uri),
  ]) {
    for (const token of identifierCandidatesFromValue(value)) {
      identifiers.add(token);
    }
  }

  const identifierRules: ReplacementRule[] = [...identifiers]
    .sort((a, b) => b.length - a.length)
    .map((identifier) => ({
      kind: "project_identifier" as const,
      pattern: new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "g"),
      replacement: "the project",
    }));

  return [
    { kind: "internal_url", pattern: INTERNAL_URL_PATTERN, replacement: "the private endpoint" },
    { kind: "absolute_path", pattern: ABSOLUTE_PATH_PATTERN, replacement: "the workspace path" },
    { kind: "absolute_path", pattern: WINDOWS_PATH_PATTERN, replacement: "the workspace path" },
    {
      kind: "branch_or_ticket",
      pattern: BRANCH_OR_TICKET_PATTERN,
      replacement: "the change request",
    },
    ...identifierRules,
  ];
}

function increment(
  counts: Partial<Record<FinalizeReplacementKind, number>>,
  kind: FinalizeReplacementKind,
  amount: number,
): void {
  if (amount <= 0) return;
  counts[kind] = (counts[kind] ?? 0) + amount;
}

function applyRules(
  value: string,
  rules: ReplacementRule[],
  counts: Partial<Record<FinalizeReplacementKind, number>>,
): string {
  const secretRedacted = redactSecrets(value);
  if (secretRedacted !== value) increment(counts, "secret", 1);

  let output = secretRedacted;
  for (const rule of rules) {
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0] ?? "");
      if (!match) return match;
      increment(counts, rule.kind, 1);
      return rule.replacement;
    });
  }
  return output;
}

function anonymizeReference(
  reference: CoverEvidenceReference,
  rules: ReplacementRule[],
  counts: Partial<Record<FinalizeReplacementKind, number>>,
): CoverEvidenceReference {
  if (reference.kind === "source") {
    return {
      ...reference,
      uri: "the source document",
      ...(reference.locator ? { locator: "the source locator" } : {}),
      ...(reference.title ? { title: applyRules(reference.title, rules, counts) } : {}),
      note: applyRules(reference.note, rules, counts),
    };
  }
  return {
    ...reference,
    uri: applyRules(reference.uri, rules, counts),
    ...(reference.locator ? { locator: applyRules(reference.locator, rules, counts) } : {}),
    ...(reference.title ? { title: applyRules(reference.title, rules, counts) } : {}),
    note: applyRules(reference.note, rules, counts),
  };
}

function anonymizeDuplicateRef(
  ref: CoverEvidenceDuplicateRef,
  rules: ReplacementRule[],
  counts: Partial<Record<FinalizeReplacementKind, number>>,
): CoverEvidenceDuplicateRef {
  return {
    ...ref,
    title: applyRules(ref.title, rules, counts),
    reason: applyRules(ref.reason, rules, counts),
  };
}

function withoutRepoScopes(candidate: CoverEvidenceCandidate): {
  candidate: CoverEvidenceCandidate;
  removedApplicabilityScopes: string[];
} {
  const removedApplicabilityScopes: string[] = [];
  if (candidate.repoPath) removedApplicabilityScopes.push("repoPath");
  if (candidate.repoKey) removedApplicabilityScopes.push("repoKey");
  const { repoPath: _repoPath, repoKey: _repoKey, ...rest } = candidate;
  return { candidate: rest, removedApplicabilityScopes };
}

function summaryFromCounts(params: {
  counts: Partial<Record<FinalizeReplacementKind, number>>;
  removedApplicabilityScopes: string[];
}): FinalizeAnonymizationSummary {
  const replacementKinds = Object.entries(params.counts)
    .filter((entry): entry is [FinalizeReplacementKind, number] => entry[1] > 0)
    .map(([kind]) => kind);
  if (params.removedApplicabilityScopes.length > 0) replacementKinds.push("repo_scope");
  return {
    applied: replacementKinds.length > 0,
    version: 1,
    replacementKinds: [...new Set(replacementKinds)],
    replacementCounts: params.counts,
    removedApplicabilityScopes: params.removedApplicabilityScopes,
  };
}

function extractListItems(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line))
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim())
    .filter(Boolean);
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?。])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function supportedAvoidLine(value: string): string {
  return (
    splitSentences(value).find((line) =>
      /(\bavoid\b|\bdo not\b|\bnever\b|\bskip\b|避ける|禁止|しない|してはいけない)/i.test(line),
    ) ?? ""
  );
}

function supportedVerificationLine(value: string): string {
  return (
    splitSentences(value).find((line) =>
      /(\bverify\b|\btest\b|\bcheck\b|\bconfirm\b|\bsmoke\b|検証|確認|テスト)/i.test(line),
    ) ?? ""
  );
}

export function restructureProcedureCandidate(
  candidate: CoverEvidenceCandidate,
): { candidate: CoverEvidenceCandidate; event: CoverEvidenceToolEvent } | null {
  if (candidate.type !== "procedure" || hasSkillLikeProcedureBody(candidate.body)) return null;

  const items = extractListItems(candidate.body);
  if (items.length < 2) return null;

  const verification = supportedVerificationLine(candidate.body);
  const avoid = supportedAvoidLine(candidate.body);
  if (!verification || !avoid) return null;

  const body = [
    "Use when:",
    candidate.title,
    "",
    "Workflow:",
    ...items.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Verification:",
    verification,
    "",
    "Avoid:",
    avoid,
  ].join("\n");

  if (!hasSkillLikeProcedureBody(body)) return null;

  return {
    candidate: {
      ...candidate,
      title: normalizeBody(candidate.title),
      body,
    },
    event: {
      name: "procedure_restructured_for_finalize",
      ok: true,
      metadata: {
        source: "finalizeDistille",
        mode: "deterministic",
      },
    },
  };
}

export function prepareFinalizeCandidate(params: {
  candidate: CoverEvidenceCandidate;
  context: FinalizeCandidateContext;
  references: CoverEvidenceReference[];
  duplicateRefs: CoverEvidenceDuplicateRef[];
  toolEvents: CoverEvidenceToolEvent[];
}): FinalizePreparedCandidate {
  const rules = replacementRules(params);
  const counts: Partial<Record<FinalizeReplacementKind, number>> = {};
  const repoScoped = withoutRepoScopes(params.candidate);
  if (repoScoped.removedApplicabilityScopes.length > 0) {
    increment(counts, "repo_scope", repoScoped.removedApplicabilityScopes.length);
  }

  const candidate: CoverEvidenceCandidate = {
    ...repoScoped.candidate,
    title: normalizeBody(applyRules(repoScoped.candidate.title, rules, counts)),
    body: normalizeBody(applyRules(repoScoped.candidate.body, rules, counts)),
  };

  return {
    candidate,
    references: params.references.map((reference) => anonymizeReference(reference, rules, counts)),
    duplicateRefs: params.duplicateRefs.map((ref) => anonymizeDuplicateRef(ref, rules, counts)),
    toolEvents: params.toolEvents,
    anonymization: summaryFromCounts({
      counts,
      removedApplicabilityScopes: repoScoped.removedApplicabilityScopes,
    }),
  };
}

export function emptyFinalizeAnonymizationSummary(): FinalizeAnonymizationSummary {
  return {
    ...EMPTY_ANONYMIZATION,
    replacementKinds: [],
    replacementCounts: {},
    removedApplicabilityScopes: [],
  };
}

export function buildFinalizeSummary(params: {
  decision: FinalizeSummary["decision"];
  reason?: string | null;
  anonymization?: FinalizeAnonymizationSummary;
  qualityGates?: string[];
}): FinalizeSummary {
  return {
    decision: params.decision,
    reason:
      params.reason ??
      (params.decision === "stored"
        ? "source-supported reusable knowledge passed finalize quality gates"
        : params.decision === "dry_run"
          ? "finalize dry run completed before draft storage"
          : "candidate did not pass finalize quality gates"),
    anonymization: params.anonymization ?? emptyFinalizeAnonymizationSummary(),
    qualityGates: params.qualityGates ?? [],
    llmAssist: {
      enabled: false,
      applied: false,
    },
  };
}
