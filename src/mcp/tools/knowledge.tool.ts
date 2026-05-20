import { eq } from "drizzle-orm";
import {
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../../../api/modules/knowledge/knowledge.repository.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import { checkKnowledgeDuplicate } from "../../lib/knowledge-dedup.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import { rankAndDedupe } from "../../modules/context-compiler/ranking.service.js";
import {
  registerKnowledgeFromMarkdown,
  searchKnowledgeCandidates,
} from "../../modules/knowledge/knowledge.service.js";
import { canTransitionKnowledgeStatus } from "../../modules/lifecycle/lifecycle.service.js";
import {
  knowledgeSearchInputSchema,
  listKnowledgeInputSchema,
  registerKnowledgeInputSchema,
  updateKnowledgeInputSchema,
} from "../../shared/schemas/knowledge.schema.js";
import type { ToolEntry } from "../registry.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      compileSelectCount: item.compileSelectCount,
      agenticAcceptCount: item.agenticAcceptCount,
      explicitUpvoteCount: item.explicitUpvoteCount,
      explicitDownvoteCount: item.explicitDownvoteCount,
      lastCompiledAt: item.lastCompiledAt,
      lastVerifiedAt: item.lastVerifiedAt,
      updatedAt: item.updatedAt,
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

    // 共通重複チェック（MCP 登録時は厳しめ: 0.95）
    const dedupResult = await checkKnowledgeDuplicate(parsed.title, parsed.body, {
      bodySimilarityThreshold: 0.95,
      topK: 3,
    });
    if (dedupResult.isDuplicate) {
      return {
        content: [
          {
            type: "text",
            text: `Registration skipped: Knowledge with identical content already exists (ID: ${dedupResult.existingId}, Match: ${(dedupResult.matchScore * 100).toFixed(1)}%, reason: ${dedupResult.reason}).`,
          },
        ],
      };
    }

    const id = await registerKnowledgeFromMarkdown({
      ...parsed,
      sourceUri: "agent://register",
    });
    return {
      content: [{ type: "text", text: `Knowledge registered successfully with ID: ${id}` }],
    };
  },
};

export const listKnowledgeTool: ToolEntry = {
  name: "list_knowledge",
  description:
    "List knowledge backlog/items for review. Useful for draft triage or active knowledge inspection.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 50, minimum: 1, maximum: 200 },
      status: { type: "string", enum: ["draft", "active", "deprecated"] },
      type: { type: "string", enum: ["rule", "procedure"] },
      query: { type: "string" },
    },
  },
  handler: async (args) => {
    const parsed = listKnowledgeInputSchema.parse(args ?? {});
    const items = await listKnowledgeItems(parsed);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              filters: parsed,
              count: items.length,
              items,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const updateKnowledgeTool: ToolEntry = {
  name: "update_knowledge",
  description:
    "Update knowledge content/status directly (for example draft -> active or active -> deprecated).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Knowledge UUID" },
      type: { type: "string", enum: ["rule", "procedure"] },
      status: { type: "string", enum: ["draft", "active", "deprecated"] },
      scope: { type: "string", enum: ["repo", "global"] },
      title: { type: "string" },
      body: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      importance: { type: "number", minimum: 0, maximum: 100 },
      metadata: { type: "object" },
    },
    required: ["id"],
  },
  handler: async (args) => {
    const parsed = updateKnowledgeInputSchema.parse(args ?? {});
    const [existing] = await db
      .select({
        id: knowledgeItems.id,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        scope: knowledgeItems.scope,
        title: knowledgeItems.title,
        body: knowledgeItems.body,
        confidence: knowledgeItems.confidence,
        importance: knowledgeItems.importance,
        metadata: knowledgeItems.metadata,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, parsed.id))
      .limit(1);

    if (!existing) {
      return {
        content: [{ type: "text", text: `Knowledge not found: ${parsed.id}` }],
        isError: true,
      };
    }

    const currentStatus = existing.status as "draft" | "active" | "deprecated";
    const nextStatus = (parsed.status ?? currentStatus) as "draft" | "active" | "deprecated";
    if (nextStatus !== currentStatus && !canTransitionKnowledgeStatus(currentStatus, nextStatus)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid status transition: ${currentStatus} -> ${nextStatus}`,
          },
        ],
        isError: true,
      };
    }

    const existingMetadata = asRecord(existing.metadata);
    const merged = {
      type: parsed.type ?? existing.type,
      status: nextStatus,
      scope: parsed.scope ?? existing.scope,
      title: parsed.title ?? existing.title,
      body: parsed.body ?? existing.body,
      confidence: parsed.confidence ?? normalizeKnowledgeScore(existing.confidence, 70),
      importance: parsed.importance ?? normalizeKnowledgeScore(existing.importance, 70),
      metadata: parsed.metadata
        ? {
            ...existingMetadata,
            ...parsed.metadata,
          }
        : existingMetadata,
    };

    const updated = await updateKnowledgeItem(parsed.id, merged);
    if (!updated) {
      return {
        content: [{ type: "text", text: `Knowledge not found: ${parsed.id}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: parsed.id,
              status: merged.status,
              type: merged.type,
              scope: merged.scope,
              updatedFields: Object.keys(parsed).filter((key) => key !== "id"),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
