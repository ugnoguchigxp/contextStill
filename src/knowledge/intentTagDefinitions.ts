export const knowledgeIntentTagDefinitions = [
  {
    slug: "guidance",
    label: "Guidance",
    description: "General reusable guidance for execution or review.",
  },
  {
    slug: "guardrail",
    label: "Guardrail",
    description: "Constraint or check that should shape execution.",
  },
  {
    slug: "prohibition",
    label: "Prohibition",
    description: "Action or pattern that must be avoided.",
  },
  {
    slug: "warning",
    label: "Warning",
    description: "Cautionary signal that should be considered before acting.",
  },
  {
    slug: "failure_pattern",
    label: "Failure Pattern",
    description: "Recurring failure mode or regression pattern.",
  },
  {
    slug: "review_finding",
    label: "Review Finding",
    description: "Finding derived from code or design review evidence.",
  },
  {
    slug: "regression",
    label: "Regression",
    description: "Previously fixed behavior that can recur.",
  },
  {
    slug: "test_gap",
    label: "Test Gap",
    description: "Missing or insufficient verification coverage.",
  },
  {
    slug: "verification",
    label: "Verification",
    description: "Evidence or procedure for confirming behavior.",
  },
  {
    slug: "preference",
    label: "Preference",
    description: "Reusable preference for implementation or communication.",
  },
  {
    slug: "boundary_violation",
    label: "Boundary Violation",
    description: "Crossing an ownership, scope, or contract boundary.",
  },
  {
    slug: "architecture_risk",
    label: "Architecture Risk",
    description: "Risk to architecture, layering, coupling, or extensibility.",
  },
  {
    slug: "security_risk",
    label: "Security Risk",
    description: "Risk affecting confidentiality, integrity, authorization, or secret handling.",
  },
  {
    slug: "performance_risk",
    label: "Performance Risk",
    description: "Risk affecting latency, throughput, resource use, or scalability.",
  },
  {
    slug: "operational_risk",
    label: "Operational Risk",
    description: "Risk affecting runtime operation, rollout, process ownership, or recovery.",
  },
  {
    slug: "data_integrity",
    label: "Data Integrity",
    description: "Risk affecting data preservation, correctness, or traceability.",
  },
] as const;

export const knowledgeIntentTagSlugs = knowledgeIntentTagDefinitions.map(
  (definition) => definition.slug,
);

export type KnowledgeIntentTagSlug = (typeof knowledgeIntentTagSlugs)[number];
