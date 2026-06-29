export type VibeFindingEligibilityInput = {
  id: string;
  sessionId: string;
  content: string;
  metadata?: unknown;
  agentDiffCount?: number;
  minScore?: number;
  minContentChars?: number;
};

export type VibeFindingEligibilityResult = {
  eligible: boolean;
  score: number;
  signals: string[];
  rejectReasons: string[];
};

const defaultMinScore = 50;
const defaultMinContentChars = 120;

const verificationTerms =
  /検証|確認|通りました|失敗|原因|修正|完了|問題|エラー|レビュー|復旧|再発|test|build|lint|verify|failed|failure|error|timeout|panic|assertion|review|fixed|root cause/iu;
const runtimeTerms =
  /queue|db|database|sqlite|daemon|provider|runtime|worker|launchagent|process|heartbeat|requeue|retry|finding|candidate|distillation/iu;
const commandTerms =
  /bunx?|npm|pnpm|cargo|sqlite3|git|rg|curl|lsof|ps aux|test|build|lint|verify/iu;
const preferenceTerms =
  /必ず|禁止|避け|しない|してください|方針|境界|優先|好み|prefer|avoid|must|never|do not|should/iu;
const boilerplateTerms =
  /AGENTS\.md instructions|<INSTRUCTIONS>|<\/INSTRUCTIONS>|<environment_context>|<\/environment_context>|<filesystem>|<\/filesystem>|initial_instructions|project-doc|workspace_roots/iu;
const progressOnlyTerms =
  /^(?:ASSISTANT:\s*)?(?:確認します|調べます|読みます|実行します|進めます|次に|最後に|了解しました)[。.!！\s]*$/u;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function rolesFromInput(input: VibeFindingEligibilityInput): Set<string> {
  const metadata = asRecord(input.metadata);
  const roles = new Set<string>();
  const rawRoles = metadata.roles;
  if (Array.isArray(rawRoles)) {
    for (const role of rawRoles) {
      if (typeof role === "string" && role.trim()) roles.add(role.trim().toLowerCase());
    }
  }
  if (/\bUSER:/u.test(input.content)) roles.add("user");
  if (/\bASSISTANT:/u.test(input.content)) roles.add("assistant");
  return roles;
}

function boilerplateRatio(content: string): number {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 1;
  const boilerplateLines = lines.filter((line) => boilerplateTerms.test(line)).length;
  return boilerplateLines / lines.length;
}

function isProgressOnly(content: string): boolean {
  const blocks = content
    .split(/\n{2,}/u)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (blocks.length === 0) return true;
  return blocks.every((block) => progressOnlyTerms.test(block));
}

export function evaluateVibeFindingEligibility(
  input: VibeFindingEligibilityInput,
): VibeFindingEligibilityResult {
  const minScore = Math.max(0, Math.floor(input.minScore ?? defaultMinScore));
  const minContentChars = Math.max(0, Math.floor(input.minContentChars ?? defaultMinContentChars));
  const content = input.content.trim();
  const metadata = asRecord(input.metadata);
  const signals: string[] = [];
  const rejectReasons: string[] = [];
  let score = 0;

  if (content.length < minContentChars) {
    score -= 30;
    rejectReasons.push("content_too_short");
  }

  if (verificationTerms.test(content)) {
    score += 40;
    signals.push("verification_or_failure_terms");
  }

  const agentDiffCount = numberOrZero(input.agentDiffCount ?? metadata.agentDiffCount);
  if (agentDiffCount > 0) {
    score += 30;
    signals.push("has_agent_diff");
  }

  const roles = rolesFromInput(input);
  if (roles.has("user") && roles.has("assistant")) {
    score += 20;
    signals.push("mixed_roles");
  }

  if (runtimeTerms.test(content)) {
    score += 15;
    signals.push("runtime_or_queue_terms");
  }

  if (commandTerms.test(content)) {
    score += 10;
    signals.push("command_terms");
  }

  if (preferenceTerms.test(content)) {
    score += 20;
    signals.push("preference_terms");
  }

  const ratio = boilerplateRatio(content);
  if (ratio >= 0.6) {
    score -= 40;
    rejectReasons.push("boilerplate_heavy");
  }

  if (isProgressOnly(content)) {
    score -= 40;
    rejectReasons.push("progress_only");
  }

  if (signals.length === 0) {
    rejectReasons.push("no_reusable_signal");
  }

  if (score < minScore) {
    rejectReasons.push("below_min_score");
  }

  return {
    eligible: rejectReasons.length === 0,
    score,
    signals,
    rejectReasons: Array.from(new Set(rejectReasons)),
  };
}
