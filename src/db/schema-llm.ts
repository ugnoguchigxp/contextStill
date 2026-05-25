import { index, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const llmUsageLogs = pgTable(
  "llm_usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    costJpy: real("cost_jpy").default(0).notNull(),
    usageMode: text("usage_mode").notNull().default("estimated"),
    source: text("source").notNull().default("unknown"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("llm_usage_logs_created_at_idx").on(table.createdAt),
    providerIdx: index("llm_usage_logs_provider_idx").on(table.provider),
    sourceIdx: index("llm_usage_logs_source_idx").on(table.source),
    usageModeIdx: index("llm_usage_logs_usage_mode_idx").on(table.usageMode),
  }),
);
