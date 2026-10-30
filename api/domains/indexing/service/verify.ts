import { sha256Hex } from "../../../infrastructure/digest";
import { cosine, unpackVector } from "../../../infrastructure/vector";
import { recordVerificationRun, setVerification } from "../../vectors";
import type {
	IndexingDeps,
	VerifyLegacyArgs,
	VerifyLegacyReport,
} from "../contracts";
import {
	getLegacySampleRows,
	listUnverifiedLegacyKnowledgeIds,
} from "../repository";
import { embeddingText } from "./embedding-text";
import { embedBatch, errorCode } from "./larm-embed";

const PASSAGE_PREFIX = "passage: ";

function summarize(values: number[]) {
	if (values.length === 0) return { minCosine: 0, meanCosine: 0 };
	return {
		minCosine: Math.min(...values),
		meanCosine: values.reduce((sum, v) => sum + v, 0) / values.length,
	};
}

/** Cosine against the stored vector; a stored vector of another length can never match. */
function cosineAgainst(stored: Float32Array, fresh: Float32Array): number {
	if (stored.length !== fresh.length) return 0;
	const value = cosine(stored, fresh);
	return Number.isFinite(value) ? value : 0;
}

/**
 * Embeds a deterministic sample of the unverified legacy knowledge vectors again and compares
 * it with the stored ones. A pass marks every unverified legacy vector of the verification
 * population (current text, owner row present) verified, a failure marks them mismatch. An empty
 * population or sample changes nothing and records no run. The thresholds are provisional (unverified against live LARM).
 */
export async function verifyLegacyVectors(
	deps: IndexingDeps,
	args: VerifyLegacyArgs,
): Promise<VerifyLegacyReport> {
	const runId = crypto.randomUUID();
	const empty: VerifyLegacyReport = {
		runId,
		sampleSize: 0,
		minCosine: null,
		meanCosine: null,
		passed: false,
		prefixDiagnostic: null,
		updatedRows: 0,
	};
	const ids = deps.store.read((db) =>
		listUnverifiedLegacyKnowledgeIds(db, deps.spaceKey),
	);
	if (ids.length === 0 || args.sampleSize <= 0) {
		deps.log("no unverified legacy knowledge vectors to verify");
		return empty;
	}
	const population = new Set(ids);

	const chosen = ids
		.map((id) => ({ id, key: sha256Hex(id) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.slice(0, args.sampleSize)
		.map((entry) => entry.id);
	const byId = new Map(
		deps.store
			.read((db) => getLegacySampleRows(db, deps.spaceKey, chosen))
			.map((row) => [row.id, row]),
	);
	const sample = chosen.flatMap((id) => {
		const row = byId.get(id);
		return row
			? [
					{
						id,
						text: embeddingText("knowledge", row),
						stored: unpackVector(row.vector),
					},
				]
			: [];
	});

	if (sample.length === 0) {
		deps.log("no sample could be read; nothing verified");
		return empty;
	}

	const fresh = await embedBatch(
		deps,
		sample.map((s) => s.text),
		"passage",
	);
	if (!fresh.ok) throw fresh.error;
	const scores = sample.map((s, i) =>
		cosineAgainst(s.stored, fresh.vectors[i]!),
	);
	const { minCosine, meanCosine } = summarize(scores);
	const passed =
		minCosine >= args.thresholdMin && meanCosine >= args.thresholdMean;

	let prefixDiagnostic: VerifyLegacyReport["prefixDiagnostic"] = null;
	if (!passed) {
		// Same sample with the "passage: " prefix put into the text: tells a missing prefix (the
		// stored vectors were made with it) from a doubled one apart.
		const prefixed = await embedBatch(
			deps,
			sample.map((s) => PASSAGE_PREFIX + s.text),
			"passage",
		);
		if (prefixed.ok)
			prefixDiagnostic = summarize(
				sample.map((s, i) => cosineAgainst(s.stored, prefixed.vectors[i]!)),
			);
		else deps.log(`prefix diagnostic skipped: ${errorCode(prefixed.error)}`);
		deps.log(
			"verification failed: re-embed the legacy vectors with `bun run vectors:embed -- --owner knowledge --all`",
		);
	}

	let updatedRows = 0;
	if (!args.dryRun) {
		const now = deps.now().toISOString();
		updatedRows = await deps.store.write((db) => {
			recordVerificationRun(db, {
				id: runId,
				spaceKey: deps.spaceKey,
				ownerKind: "knowledge",
				origin: "legacy_import",
				sampleSize: sample.length,
				minCosine,
				meanCosine,
				thresholdMin: args.thresholdMin,
				thresholdMean: args.thresholdMean,
				passed,
				detail: {
					sampleIds: sample.map((s) => s.id),
					prefixDiagnostic,
					...(passed
						? {}
						: {
								recommendation:
									"bun run vectors:embed -- --owner knowledge --all",
							}),
				},
				now,
			});
			// Only the owners that were in the population when the sample was chosen and still
			// are: orphan vectors and rows that appeared or changed since stay as they are.
			const ownerIds = listUnverifiedLegacyKnowledgeIds(
				db,
				deps.spaceKey,
			).filter((id) => population.has(id));
			return setVerification(db, {
				ownerIds,
				spaceKey: deps.spaceKey,
				ownerKind: "knowledge",
				origin: "legacy_import",
				from: ["unverified"],
				to: passed ? "verified" : "mismatch",
				now,
			});
		});
	}
	return {
		runId,
		sampleSize: sample.length,
		minCosine,
		meanCosine,
		passed,
		prefixDiagnostic,
		updatedRows,
	};
}
