export function buildNegativeEvidencePrompt(params: {
  title: string;
  content: string;
}) {
  return `You are analyzing a review correction candidate representing a failure pattern, regression, or architecture/security risk (Negative Knowledge).
Please assess whether this correction is a valid reusable rule/guardrail (status='ready') or if it is insufficient, a false positive, or too specific to be reusable.

Candidate Title: ${params.title}
Candidate Body:
${params.content}

Analyze the candidate and output a JSON response in the following schema:
{
  "status": "ready" | "insufficient" | "false_positive" | "not_reusable",
  "polarity": "negative" | "neutral",
  "intentTags": string[], // normalized tags like "guardrail", "failure_pattern", "regression", "security_risk" etc.
  "appliesTo": {
    "technologies": string[], // concrete stacks, runtimes, libraries, or languages where this rule applies
    "changeTypes": string[], // concrete change categories like "implementation", "configuration", "testing", "diagnosis"
    "domains": string[], // concrete product or engineering domains like "queue", "security", "database"
    "repoPath": string | null, // optional repository path if explicitly known
    "repoKey": string | null, // optional repository key if explicitly known
    "general": boolean | null // true only when the rule is intentionally cross-repository
  },
  "distilled": {
    "failure": string, // description of the failure/risk to avoid
    "impact": string | null, // optional impact
    "trigger": string | null, // optional trigger/context where this risk applies
    "fix": string | null, // optional recommended fix/avoidance guidance
    "verification": string | null, // optional verification method to check for this failure
    "decisionSignal": string | null // optional decision signal
  },
  "evidence": string[], // key snippets from the candidate supporting this
  "originRefs": string[] // references from origin
}

For status='ready', appliesTo.technologies, appliesTo.changeTypes, and appliesTo.domains must be non-empty and grounded in the candidate text or origin context. If the candidate does not provide enough evidence to determine these applicability categories, use status='insufficient' instead of inventing broad categories.
Format the response strictly as a single JSON object. Do not include markdown code block syntax around the JSON.`;
}
