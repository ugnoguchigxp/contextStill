import type { LandscapeContradictionCandidate } from "../../shared/schemas/landscape-contradiction.schema.js";
import type {
  LandscapeReviewItem,
  LandscapeReviewItemCandidate,
  LandscapeReviewItemProposedAction,
  LandscapeReviewItemReason,
  LandscapeReviewItemSource,
  LandscapeReviewItemStatus,
} from "../../shared/schemas/landscape-review.schema.js";
import type {
  LandscapeAppliesToRefineCandidate,
  LandscapeReplayComparisonResponse,
  LandscapeReplaySnapshot,
  LandscapeRunStatusFilter,
} from "./landscape-replay.types.js";
import type { LandscapeSnapshot } from "./landscape.types.js";
import type { LandscapeGraphRelationAxis, LandscapeGraphStatusFilter } from "./landscape.types.js";

export type BuildLandscapeReviewItemCandidatesInput = {
  generatedAt?: string;
  runStatus: LandscapeRunStatusFilter;
  sources: LandscapeReviewItemSource[];
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
  landscapeSnapshot?: LandscapeSnapshot | null;
  landscapeReplaySnapshot?: LandscapeReplaySnapshot | null;
  landscapeReplayComparison?: LandscapeReplayComparisonResponse | null;
  contradictionCandidates?: LandscapeContradictionCandidate[];
};

export type LandscapeReviewItemCandidateBuildResult = {
  generatedAt: string;
  candidates: LandscapeReviewItemCandidate[];
  candidateCount: number;
};

export type MaterializeLandscapeReviewItemsInput = {
  dryRun: boolean;
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  landscapeLimit: number;
  landscapeStatus: LandscapeGraphStatusFilter;
  relationAxes: LandscapeGraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  sources: LandscapeReviewItemSource[];
  materializeLimit: number;
};

export type LandscapeReviewItemMaterializeResult = {
  dryRun: boolean;
  generatedAt: string;
  candidateCount: number;
  insertedCount: number;
  existingCount: number;
  skippedCount: number;
  items: LandscapeReviewItem[];
  candidates: LandscapeReviewItemCandidate[];
};

export type LandscapeReviewItemInsert = Omit<LandscapeReviewItemCandidate, "note"> & {
  note?: string | null;
};

export type ListLandscapeReviewItemsInput = {
  status: LandscapeReviewItemStatus | "all";
  source: LandscapeReviewItemSource | "all";
  reason: LandscapeReviewItemReason | "all";
  proposedAction: LandscapeReviewItemProposedAction | "all";
  knowledgeId?: string;
  runId?: string;
  communityKey?: string;
  priorityMin: number;
  limit: number;
};

export type LandscapeReviewItemListResult = {
  items: LandscapeReviewItem[];
  count: number;
};

export type UpdateLandscapeReviewItemStatusInput = {
  id: string;
  status: LandscapeReviewItemStatus;
  note?: string;
};
