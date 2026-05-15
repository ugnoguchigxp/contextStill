import { createHash } from "node:crypto";
import { rankAndDedupe } from "../../modules/context-compiler/ranking.service.js";
import { embedOne } from "../../modules/embedding/embedding.service.js";
import { vectorSearchKnowledge } from "../../modules/knowledge/knowledge.repository.js";
import {
  registerKnowledgeFromMarkdown,
  searchKnowledgeCandidates,
} from "../../modules/knowledge/knowledge.service.js";
import {
  knowledgeSearchInputSchema,
  registerKnowledgeInputSchema,
} from "../../shared/schemas/knowledge.schema.js";
import type { ToolEntry } from "../registry.js";

export const searchKnowledgeTool: ToolEntry = {
  name: "search_knowledge",
  description:
    "Inspect raw knowledge candidates with scores and source refs. Prefer context_compile for normal workflows.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      repoPath: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      changeTypes: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      statuses: {
        type: "array",
        items: { type: "string", enum: ["draft", "active", "deprecated"] },
      },
      types: {
        type: "array",
        items: { type: "string", enum: ["rule", "procedure"] },
      },
      limit: { type: "number", default: 10 },
      includeDraft: { type: "boolean", default: false },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const parsed = knowledgeSearchInputSchema.parse(args ?? {});
    const result = await searchKnowledgeCandidates(parsed);
    const ranked = rankAndDedupe(
      result.items.map((item) => ({
        ...item,
        content: item.body,
        sourceRefCount: item.sourceRefs.length,
        stale: item.status === "deprecated",
      })),
      parsed.limit,
    ).map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      scope: item.scope,
      title: item.title,
      body: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      sourceRefs: item.sourceRefs,
      metadata: item.metadata,
    }));

    if (ranked.length === 0) {
      return {
        content: [{ type: "text", text: "no content" }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: parsed.query,
              normalizedQuery: result.stats.queryText,
              items: ranked,
              diagnostics: {
                degradedReasons: result.degradedReasons,
                stats: result.stats,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

function calculateContentSimilarity(text1: string, text2: string): number {
  const s1 = text1.replace(/\s+/g, "").toLowerCase();
  const s2 = text2.replace(/\s+/g, "").toLowerCase();

  if (s1.length < 2 || s2.length < 2) {
    return s1 === s2 ? 1 : 0;
  }

  const getBigrams = (str: string) => {
    const bigrams = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  };

  const set1 = getBigrams(s1);
  const set2 = getBigrams(s2);

  let intersection = 0;
  for (const bg of set1) {
    if (set2.has(bg)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return intersection / union;
}

export const registerKnowledgeTool: ToolEntry = {
  name: "register_knowledge",
  description:
    "Directly register new rules or procedures (agent skills). Embedding is generated automatically.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Clear, concise title of the knowledge." },
      body: { type: "string", description: "The content of the rule or procedure." },
      type: { type: "string", enum: ["rule", "procedure"], default: "rule" },
      status: { type: "string", enum: ["draft", "active", "deprecated"], default: "draft" },
      scope: { type: "string", enum: ["repo", "global"], default: "repo" },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      importance: { type: "number", minimum: 0, maximum: 100 },
      metadata: { type: "object" },
    },
    required: ["title", "body"],
  },
  handler: async (args) => {
    const parsed = registerKnowledgeInputSchema.parse(args ?? {});
    const contentHash = createHash("sha256").update(parsed.body).digest("hex");

    let embedding: number[] | undefined;
    try {
      embedding = await embedOne(`${parsed.title}\n${parsed.body}`, "passage");
      if (embedding && embedding.length > 0) {
        const similar = await vectorSearchKnowledge(embedding, 3, [
          "active",
          "draft",
          "deprecated",
        ]);
        for (const candidate of similar) {
          const bodySimilarity = calculateContentSimilarity(parsed.body, candidate.body);
          if (bodySimilarity > 0.95) {
            return {
              content: [
                {
                  type: "text",
                  text: `Registration skipped: Knowledge with identical content already exists (ID: ${candidate.id}, Match: ${(bodySimilarity * 100).toFixed(1)}%).`,
                },
              ],
            };
          }
        }
      }
    } catch {
      // Ignore embedding errors here; let registerKnowledgeFromMarkdown handle or skip it
    }

    const id = await registerKnowledgeFromMarkdown({
      ...parsed,
      sourceUri: "agent://register",
      contentHash,
      embedding,
    });
    return {
      content: [{ type: "text", text: `Knowledge registered successfully with ID: ${id}` }],
    };
  },
};
