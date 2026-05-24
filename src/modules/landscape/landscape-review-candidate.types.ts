import type {
  LandscapeReviewCandidateCreateInput,
  LandscapeReviewCandidateCreateResult,
} from "../../shared/schemas/landscape-review-candidate.schema.js";

export type CreateLandscapeReviewCandidatesInput = LandscapeReviewCandidateCreateInput;
export type CreateLandscapeReviewCandidatesResult = LandscapeReviewCandidateCreateResult;

export type LandscapeReviewCandidateType = "rule" | "procedure";

export type LandscapeReviewCandidateDraft = {
  candidateType: LandscapeReviewCandidateType;
  title: string;
  body: string;
  candidateKey: string;
  targetKey: string;
};
