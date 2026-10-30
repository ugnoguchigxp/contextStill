export type {
	EmbeddingTextRow,
	EmbedArgs,
	EmbedReport,
	IndexingDeps,
	VerifyLegacyArgs,
	VerifyLegacyReport,
} from "./contracts";
export { embeddingText, embedMissing, verifyLegacyVectors } from "./service";
export { EmbedAbortedError } from "./service/larm-embed";
