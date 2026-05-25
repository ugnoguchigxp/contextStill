import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contextCompileRuns, knowledgeUsageEvents } from "./schema-context.js";
import { distillationTargetStates, findCandidateResults } from "./schema-distillation.js";
import { knowledgeItems } from "./schema-knowledge.js";
import {
  landscapeReviewItemCandidateLinkStatusValues,
  landscapeReviewItemConfidenceValues,
  landscapeReviewItemProposedActionValues,
  landscapeReviewItemReasonValues,
  landscapeReviewItemSourceValues,
  landscapeReviewItemStatusValues,
  landscapeSnapshotCacheStatusValues,
  landscapeSnapshotCacheTypeValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const landscapeReviewItems = pgTable(
  "landscape_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    priority: integer("priority").notNull().default(50),
    confidence: text("confidence").notNull().default("low"),
    idempotencyKey: text("idempotency_key").notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id").references(() => contextCompileRuns.id, {
      onDelete: "set null",
    }),
    triggerEventId: uuid("trigger_event_id").references(() => knowledgeUsageEvents.id, {
      onDelete: "set null",
    }),
    communityKey: text("community_key"),
    communityLabel: text("community_label"),
    suggestedAppliesTo: jsonb("suggested_applies_to").default({}).notNull(),
    evidence: jsonb("evidence").default([]).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("landscape_review_items_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index("landscape_review_items_status_priority_created_at_idx").on(
      table.status,
      table.priority.desc(),
      table.createdAt,
    ),
    knowledgeStatusIdx: index("landscape_review_items_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    communityStatusIdx: index("landscape_review_items_community_status_idx").on(
      table.communityKey,
      table.status,
    ),
    runStatusIdx: index("landscape_review_items_run_status_idx").on(table.runId, table.status),
    reasonStatusIdx: index("landscape_review_items_reason_status_idx").on(
      table.reason,
      table.status,
    ),
    sourceCheck: check(
      "landscape_review_items_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(landscapeReviewItemSourceValues))})`,
    ),
    reasonCheck: check(
      "landscape_review_items_reason_check",
      sql`${table.reason} IN (${sql.raw(toSqlList(landscapeReviewItemReasonValues))})`,
    ),
    statusCheck: check(
      "landscape_review_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemStatusValues))})`,
    ),
    proposedActionCheck: check(
      "landscape_review_items_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(
        toSqlList(landscapeReviewItemProposedActionValues),
      )})`,
    ),
    confidenceCheck: check(
      "landscape_review_items_confidence_check",
      sql`${table.confidence} IN (${sql.raw(toSqlList(landscapeReviewItemConfidenceValues))})`,
    ),
    priorityCheck: check(
      "landscape_review_items_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 100`,
    ),
    evidenceArrayCheck: check(
      "landscape_review_items_evidence_array_check",
      sql`jsonb_typeof(${table.evidence}) = 'array'`,
    ),
    suggestedAppliesToObjectCheck: check(
      "landscape_review_items_suggested_applies_to_object_check",
      sql`jsonb_typeof(${table.suggestedAppliesTo}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "landscape_review_items_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);

export const landscapeReviewItemCandidateLinks = pgTable(
  "landscape_review_item_candidate_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewItemId: uuid("review_item_id")
      .references(() => landscapeReviewItems.id, { onDelete: "cascade" })
      .notNull(),
    targetStateId: uuid("target_state_id")
      .references(() => distillationTargetStates.id, { onDelete: "cascade" })
      .notNull(),
    findCandidateResultId: uuid("find_candidate_result_id")
      .references(() => findCandidateResults.id, { onDelete: "cascade" })
      .notNull(),
    candidateKey: text("candidate_key").notNull(),
    status: text("status").notNull().default("draft_created"),
    approvalNote: text("approval_note"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    reviewCandidateUnique: uniqueIndex(
      "landscape_review_item_candidate_links_review_candidate_unique",
    ).on(table.reviewItemId, table.candidateKey),
    targetCandidateUnique: uniqueIndex(
      "landscape_review_item_candidate_links_target_candidate_unique",
    ).on(table.targetStateId, table.findCandidateResultId),
    reviewStatusCreatedAtIdx: index(
      "landscape_review_item_candidate_links_review_status_created_at_idx",
    ).on(table.reviewItemId, table.status, table.createdAt),
    targetStateIdx: index("landscape_review_item_candidate_links_target_state_idx").on(
      table.targetStateId,
    ),
    findCandidateIdx: index("landscape_review_item_candidate_links_find_candidate_idx").on(
      table.findCandidateResultId,
    ),
    statusCheck: check(
      "landscape_review_item_candidate_links_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemCandidateLinkStatusValues))})`,
    ),
  }),
);

export const landscapeSnapshots = pgTable(
  "landscape_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotType: text("snapshot_type").notNull(),
    status: text("status").notNull().default("ready"),
    paramsHash: text("params_hash").notNull(),
    params: jsonb("params").notNull().default({}),
    payload: jsonb("payload").notNull().default({}),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    typeParamsHashUnique: uniqueIndex("landscape_snapshots_type_params_hash_unique").on(
      table.snapshotType,
      table.paramsHash,
    ),
    typeGeneratedAtIdx: index("landscape_snapshots_type_generated_at_idx").on(
      table.snapshotType,
      table.generatedAt,
    ),
    expiresAtIdx: index("landscape_snapshots_expires_at_idx").on(table.expiresAt),
    statusCheck: check(
      "landscape_snapshots_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeSnapshotCacheStatusValues))})`,
    ),
    typeCheck: check(
      "landscape_snapshots_type_check",
      sql`${table.snapshotType} IN (${sql.raw(toSqlList(landscapeSnapshotCacheTypeValues))})`,
    ),
    paramsObjectCheck: check(
      "landscape_snapshots_params_object_check",
      sql`jsonb_typeof(${table.params}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "landscape_snapshots_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);
