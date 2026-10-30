export type {
	SetVerificationInput,
	StoredVector,
	UpsertVectorInput,
	VectorOrigin,
	VectorOwnerKind,
	VectorSpaceDescriptor,
	VectorVerification,
	VerificationRun,
} from "./contracts";
export { vectorErrorStatus } from "./contracts";
export type { SetVerificationScopedInput } from "./repository";
export {
	ensureVectorSpace,
	getVector,
	migrations,
	recordVerificationRun,
	setVerification,
	topK,
	upsertVector,
} from "./repository";
