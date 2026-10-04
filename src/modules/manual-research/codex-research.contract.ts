import { z } from "zod";

export const CODEX_RESEARCH_MODEL = "gpt-6-luna";
export const codexResearchOptionsSchema = z.object({
  neededInformation: z.string().trim().max(1600).default(""),
  knownInformation: z.string().trim().max(1600).default(""),
  searchScope: z.string().trim().max(1600).default(""),
  reasoningEffort: z.enum(["low", "medium"]).default("low"),
  wallMs: z.number().int().min(1000).max(300_000).default(180_000),
  tokenBudget: z.number().int().min(1000).max(100_000).default(20_000),
  maxWebSearches: z.number().int().min(1).max(25).default(12),
  maxCandidates: z.number().int().min(1).max(10).default(6),
});
export type CodexResearchOptions = z.infer<typeof codexResearchOptionsSchema>;

const publicUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  }, "HTTP(S) source URL required");
export const researchCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  knowledge: z.string().trim().min(1).max(2400),
  relevance: z.string().trim().min(1).max(800),
  sources: z
    .array(
      z
        .object({
          url: publicUrl,
          title: z.string().trim().min(1).max(300),
          verification: z.enum(["source_read", "search_summary"]),
          excerpt: z.string().max(500),
          location: z.string().max(300),
          informationDate: z.string().max(100).nullable(),
        })
        .superRefine((source, ctx) => {
          if (
            source.verification === "source_read" &&
            !source.excerpt.trim() &&
            !source.location.trim()
          )
            ctx.addIssue({ code: "custom", message: "Read source needs an excerpt or location" });
        }),
    )
    .min(1)
    .max(5),
  uncertainties: z.array(z.string().max(500)).max(6),
  contradictions: z.array(z.string().max(500)).max(6),
});
export type ResearchCandidate = z.infer<typeof researchCandidateSchema>;
export const codexResearchBundleSchema = z.object({
  candidates: z.array(researchCandidateSchema).max(10),
  limitations: z.array(z.string().max(800)).max(10),
});

// JSON Schema is also sent to the CLI; Zod remains the ingress validator.
export const codexResearchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "limitations"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "knowledge", "relevance", "sources", "uncertainties", "contradictions"],
        properties: {
          title: { type: "string" },
          knowledge: { type: "string" },
          relevance: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["url", "title", "verification", "excerpt", "location", "informationDate"],
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                verification: { type: "string", enum: ["source_read", "search_summary"] },
                excerpt: { type: "string" },
                location: { type: "string" },
                informationDate: { type: ["string", "null"] },
              },
            },
          },
          uncertainties: { type: "array", items: { type: "string" } },
          contradictions: { type: "array", items: { type: "string" } },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
};

export type ResearchTokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
};
export type CodexResearchOutcome = {
  candidates: ResearchCandidate[];
  limitations: string[];
  termination:
    | "completed"
    | "insufficient_evidence"
    | "timeout"
    | "token_budget"
    | "web_limit"
    | "cancelled"
    | "failed"
    | "invalid_result"
    | "interrupted";
  tokenUsage: ResearchTokenUsage;
  usageComplete: boolean;
  elapsedMs: number;
  observedWebSearches: number;
  threadId: string | null;
  model: typeof CODEX_RESEARCH_MODEL;
  reasoningEffort: "low" | "medium";
};
