export type KnowledgeApplicability = {
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
};

export type CoverCandidateApplicability = {
  applicabilityGeneral?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
};

const EMPTY_LABEL_PATTERN = /^(?:n\/a|na|null|none|-|なし|\[\])$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  const rawValues: string[] = [];
  if (Array.isArray(value)) {
    rawValues.push(...value.map(String));
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || EMPTY_LABEL_PATTERN.test(trimmed)) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          rawValues.push(...parsed.map(String));
        } else {
          rawValues.push(trimmed.slice(1, -1));
        }
      } catch {
        rawValues.push(trimmed.slice(1, -1));
      }
    } else {
      rawValues.push(trimmed);
    }
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of rawValues) {
    for (const part of raw.split(/[,、，]/)) {
      const value = part.trim();
      if (!value || EMPTY_LABEL_PATTERN.test(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

export function normalizeApplicability(value: unknown): KnowledgeApplicability | undefined {
  const record = asRecord(value);
  const nested = asRecord(
    recordValue(record, [
      "appliesTo",
      "applies_to",
      "APPLIES_TO",
      "applicability",
      "APPLICABILITY",
    ]),
  );
  const technologies = normalizeStringList(
    recordValue(record, ["technologies", "TECHNOLOGIES"]) ??
      recordValue(nested, ["technologies", "TECHNOLOGIES"]),
  );
  const changeTypes = normalizeStringList(
    recordValue(record, ["changeTypes", "change_types", "CHANGE_TYPES", "CHANGETYPES"]) ??
      recordValue(nested, ["changeTypes", "change_types", "CHANGE_TYPES", "CHANGETYPES"]),
  );
  const domains = normalizeStringList(
    recordValue(record, ["domains", "domain", "DOMAINS", "DOMAIN"]) ??
      recordValue(nested, ["domains", "domain", "DOMAINS", "DOMAIN"]),
  );
  const general = optionalBoolean(
    recordValue(record, [
      "applicabilityGeneral",
      "applicability_general",
      "APPLICABILITY_GENERAL",
      "general",
      "GENERAL",
    ]) ??
      recordValue(nested, [
        "applicabilityGeneral",
        "applicability_general",
        "APPLICABILITY_GENERAL",
        "general",
        "GENERAL",
      ]),
  );
  const repoPath = optionalString(
    recordValue(record, ["repoPath", "repo_path", "REPO_PATH"]) ??
      recordValue(nested, ["repoPath", "repo_path", "REPO_PATH"]),
  );
  const repoKey = optionalString(
    recordValue(record, ["repoKey", "repo_key", "REPO_KEY"]) ??
      recordValue(nested, ["repoKey", "repo_key", "REPO_KEY"]),
  );

  const applicability: KnowledgeApplicability = {};
  if (typeof general === "boolean") applicability.general = general;
  if (technologies.length > 0) applicability.technologies = technologies;
  if (changeTypes.length > 0) applicability.changeTypes = changeTypes;
  if (domains.length > 0) applicability.domains = domains;
  if (repoPath) applicability.repoPath = repoPath;
  if (repoKey) applicability.repoKey = repoKey;
  return Object.keys(applicability).length > 0 ? applicability : undefined;
}

export function mergeApplicability(
  ...values: Array<KnowledgeApplicability | CoverCandidateApplicability | undefined>
): KnowledgeApplicability | undefined {
  const merged: KnowledgeApplicability = {};
  for (const value of values) {
    const normalized = normalizeApplicability(value);
    if (!normalized) continue;
    if (typeof normalized.general === "boolean") merged.general = normalized.general;
    if (normalized.technologies?.length) merged.technologies = normalized.technologies;
    if (normalized.changeTypes?.length) merged.changeTypes = normalized.changeTypes;
    if (normalized.domains?.length) merged.domains = normalized.domains;
    if (normalized.repoPath) merged.repoPath = normalized.repoPath;
    if (normalized.repoKey) merged.repoKey = normalized.repoKey;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function applicabilityToCoverCandidateFields(
  value: KnowledgeApplicability | undefined,
): CoverCandidateApplicability {
  if (!value) return {};
  return {
    ...(typeof value.general === "boolean" ? { applicabilityGeneral: value.general } : {}),
    ...(value.technologies?.length ? { technologies: value.technologies } : {}),
    ...(value.changeTypes?.length ? { changeTypes: value.changeTypes } : {}),
    ...(value.domains?.length ? { domains: value.domains } : {}),
    ...(value.repoPath ? { repoPath: value.repoPath } : {}),
    ...(value.repoKey ? { repoKey: value.repoKey } : {}),
  };
}

export function applicabilityFromCoverCandidate(
  candidate: (CoverCandidateApplicability & Record<string, unknown>) | null | undefined,
): KnowledgeApplicability {
  return normalizeApplicability(candidate) ?? {};
}

export function applyApplicabilityToCoverCandidate<T extends Record<string, unknown>>(
  candidate: T,
  applicability: KnowledgeApplicability | undefined,
): T & CoverCandidateApplicability {
  return {
    ...candidate,
    ...applicabilityToCoverCandidateFields(applicability),
  };
}

export function missingRequiredApplicabilityFacets(
  value: KnowledgeApplicability | CoverCandidateApplicability | null | undefined,
): string[] {
  const applicability = normalizeApplicability(value);
  const missing: string[] = [];
  if (!applicability?.technologies?.some((item) => item.trim().length > 0)) {
    missing.push("technologies");
  }
  if (!applicability?.changeTypes?.some((item) => item.trim().length > 0)) {
    missing.push("changeTypes");
  }
  if (!applicability?.domains?.some((item) => item.trim().length > 0)) {
    missing.push("domains");
  }
  return missing;
}

export function hasRequiredApplicabilityFacets(
  value: KnowledgeApplicability | CoverCandidateApplicability | null | undefined,
): boolean {
  return missingRequiredApplicabilityFacets(value).length === 0;
}
