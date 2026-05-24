import type {
  LandscapeReviewCandidateCreateInput,
  LandscapeReviewCandidateCreateResult,
  LandscapeReviewCandidateLink,
  LandscapeReviewCandidateLinkUpdateInput,
  LandscapeReviewCandidateLinkUpdateResult,
} from "../../shared/schemas/landscape-review-candidate.schema.js";

export type CreateLandscapeReviewCandidatesInput = LandscapeReviewCandidateCreateInput;
export type CreateLandscapeReviewCandidatesResult = LandscapeReviewCandidateCreateResult;
export type UpdateLandscapeReviewCandidateLinkInput = LandscapeReviewCandidateLinkUpdateInput;
export type UpdateLandscapeReviewCandidateLinkResult = LandscapeReviewCandidateLinkUpdateResult;
export type LandscapeReviewCandidateLinkEntry = LandscapeReviewCandidateLink;

export type LandscapeReviewCandidateType = "rule" | "procedure";

export type LandscapeReviewCandidateDraft = {
  candidateType: LandscapeReviewCandidateType;
  title: string;
  body: string;
  candidateKey: string;
  targetKey: string;
};
