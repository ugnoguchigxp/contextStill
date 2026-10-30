/**
 * The larm-embedding.v1 space. legacy does not depend on larm (domain graph), so the
 * descriptor is copied here; a test pins it to `LARM_EMBEDDING_SPACE` field by field.
 * `ensureVectorSpace` stores it as `descriptor_json`, so it must stay identical.
 */
export const LEGACY_VECTOR_SPACE = {
	contractVersion: "larm-embedding.v1",
	workload: "embedding",
	model: {
		id: "intfloat/multilingual-e5-small",
		revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
		artifactDigest:
			"63bc913284590439c0fdadcd5f61ee9ad9630591075314bc975fb190983ed62c",
	},
	dimension: 384,
	inputTypes: ["query", "passage"],
	prefixes: { query: "query: ", passage: "passage: " },
	normalization: "l2",
	tokenization: {
		kind: "sentencepiece-bpe",
		tokenizerDigest:
			"0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
		maxTokens: 512,
		truncation: "end",
		pooling: "mean",
	},
} as const;
