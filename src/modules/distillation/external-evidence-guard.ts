export type ExternalEvidenceRequestedAction =
  | "extract_facts"
  | "answer_with_citation"
  | "write_memory"
  | "create_procedure"
  | "create_skill";

export type ExternalEvidenceGuardInput = {
  text: string;
  html?: string;
  source: {
    kind: "web";
    trust: "untrusted";
    url: string;
    finalUrl?: string;
    contentType?: string;
  };
  requestedAction: ExternalEvidenceRequestedAction;
};

export type ExternalEvidenceGuardFinding = {
  category:
    | "HiddenInstruction"
    | "ToolInvocation"
    | "SourceSuppression"
    | "SecretExfiltration"
    | "PolicyOverride";
  severity: "medium" | "high" | "critical";
  reason: string;
};

export type ExternalEvidenceGuardDecision = {
  decision: "allow_with_warning" | "deny" | "unavailable";
  safeText: string;
  tainted: true;
  findings: ExternalEvidenceGuardFinding[];
  requiredControls: Array<"CitationRequired" | "HumanApproval">;
  reason?: string;
};

export type ExternalEvidenceGuard = {
  inspect(input: ExternalEvidenceGuardInput): Promise<ExternalEvidenceGuardDecision>;
};

const highRiskActions = new Set<ExternalEvidenceRequestedAction>([
  "write_memory",
  "create_procedure",
  "create_skill",
]);

const findingRules: Array<{
  category: ExternalEvidenceGuardFinding["category"];
  severity: ExternalEvidenceGuardFinding["severity"];
  reason: string;
  pattern: RegExp;
}> = [
  {
    category: "PolicyOverride",
    severity: "critical",
    reason: "External evidence contains policy or instruction override language.",
    pattern:
      /\b(ignore|disregard|override|bypass)\b.{0,80}\b(previous|prior|above|system|developer|policy|instruction)s?\b/i,
  },
  {
    category: "HiddenInstruction",
    severity: "critical",
    reason: "External evidence contains hidden or indirect instruction language.",
    pattern:
      /\b(system prompt|developer message|hidden instruction|secret instruction|follow these instructions|you are now)\b/i,
  },
  {
    category: "ToolInvocation",
    severity: "high",
    reason: "External evidence appears to request tool, command, file, or code execution.",
    pattern:
      /\b(call|invoke|run|execute|use)\b.{0,60}\b(tool|shell|command|terminal|bash|python|node|filesystem|write file|delete)\b/i,
  },
  {
    category: "SourceSuppression",
    severity: "high",
    reason: "External evidence appears to suppress citation or source disclosure.",
    pattern:
      /\b(do not|don't|never|avoid)\b.{0,80}\b(cite|citation|source|reference|mention this page|quote)\b/i,
  },
  {
    category: "SecretExfiltration",
    severity: "critical",
    reason: "External evidence appears to request secret or credential disclosure.",
    pattern:
      /\b(send|reveal|exfiltrate|extract|print|upload|submit|paste|share)\b.{0,80}\b(api[_ -]?key|secret|token|password|credential|env(?:ironment)? variable)\b/i,
  },
];

function collectFindings(text: string): ExternalEvidenceGuardFinding[] {
  const findings: ExternalEvidenceGuardFinding[] = [];
  for (const rule of findingRules) {
    if (!rule.pattern.test(text)) continue;
    findings.push({
      category: rule.category,
      severity: rule.severity,
      reason: rule.reason,
    });
  }
  return findings;
}

function requiresDeny(
  findings: ExternalEvidenceGuardFinding[],
  requestedAction: ExternalEvidenceRequestedAction,
): boolean {
  if (findings.some((finding) => finding.category === "SecretExfiltration")) return true;
  if (highRiskActions.has(requestedAction)) {
    return findings.some(
      (finding) =>
        finding.category === "PolicyOverride" ||
        finding.category === "HiddenInstruction" ||
        finding.category === "ToolInvocation",
    );
  }
  return findings.some(
    (finding) => finding.category === "PolicyOverride" || finding.category === "HiddenInstruction",
  );
}

export const localExternalEvidenceGuard: ExternalEvidenceGuard = {
  async inspect(input) {
    const text = input.text.trim();
    const findings = collectFindings(`${input.html ?? ""}\n${text}`);
    const denied = requiresDeny(findings, input.requestedAction);
    if (denied) {
      return {
        decision: "deny",
        safeText: "",
        tainted: true,
        findings,
        requiredControls: [],
        reason: findings[0]?.reason ?? "External evidence was denied by guard.",
      };
    }
    return {
      decision: "allow_with_warning",
      safeText: text,
      tainted: true,
      findings,
      requiredControls: highRiskActions.has(input.requestedAction)
        ? ["HumanApproval", "CitationRequired"]
        : ["CitationRequired"],
      reason:
        findings.length > 0
          ? "External evidence is tainted and contains suspicious instruction-like text."
          : "External evidence is untrusted and must remain citation-bound.",
    };
  },
};

export async function inspectExternalEvidence(
  input: ExternalEvidenceGuardInput,
  guard: ExternalEvidenceGuard = localExternalEvidenceGuard,
): Promise<ExternalEvidenceGuardDecision> {
  try {
    return await guard.inspect(input);
  } catch (error) {
    return {
      decision: "unavailable",
      safeText: input.text.trim(),
      tainted: true,
      findings: [],
      requiredControls: ["CitationRequired"],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
