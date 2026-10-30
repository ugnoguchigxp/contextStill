import { sha256Hex } from "../../../infrastructure/digest";
import { LARM_EMBEDDING_SPACE } from "../../larm";
import { ensureVectorSpace, upsertVector } from "../../vectors";
import type { EmbedArgs, EmbedReport, IndexingDeps } from "../contracts";
import { type EmbedSourceRow, listActiveForEmbedding } from "../repository";
import { embeddingText } from "./embedding-text";
import {
	EmbedAbortedError,
	embedBatch,
	errorCode,
	MAX_CONSECUTIVE_FAILURES,
} from "./larm-embed";

interface Candidate {
	id: string;
	text: string;
	digest: string;
}

function needsEmbedding(
	row: EmbedSourceRow,
	digest: string,
	mode: EmbedArgs["mode"],
): boolean {
	if (mode === "all") return true;
	return (
		row.storedDigest === null ||
		row.storedDigest !== digest ||
		row.storedVerification === "mismatch" ||
		row.storedVerification === "stale"
	);
}

/**
 * Embeds active rows into the LARM space as `origin='larm'`, `verification='verified'`.
 * `missing`: rows without a vector, with another content digest, or marked mismatch/stale.
 * `all`: every active row. `skipped` counts rows that were up to date (or have no text).
 * Stops with `EmbedAbortedError` (`embed_aborted: <reason>`) after MAX_CONSECUTIVE_FAILURES failed
 * batches in a row; what was saved before stays. A stop code from LARM is rethrown at once.
 */
export async function embedMissing(
	deps: IndexingDeps,
	args: EmbedArgs,
): Promise<EmbedReport> {
	const rows = deps.store.read((db) =>
		listActiveForEmbedding(db, args.owner, deps.spaceKey),
	);
	let skipped = 0;
	let candidates: Candidate[] = [];
	for (const row of rows) {
		const text = embeddingText(args.owner, row);
		if (text.trim() === "") {
			skipped++;
			continue;
		}
		const digest = sha256Hex(text);
		if (needsEmbedding(row, digest, args.mode))
			candidates.push({ id: row.id, text, digest });
		else skipped++;
	}
	if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);

	const report: EmbedReport = {
		owner: args.owner,
		candidates: candidates.length,
		embedded: 0,
		skipped,
		failed: 0,
		busyWaits: 0,
	};
	if (args.dryRun || candidates.length === 0) return report;

	const batchSize = Math.max(1, args.batchSize);
	let spaceChecked = false;
	let consecutiveFailures = 0;
	for (let start = 0; start < candidates.length; start += batchSize) {
		const batch = candidates.slice(start, start + batchSize);
		let outcome: Awaited<ReturnType<typeof embedBatch>>;
		try {
			outcome = await embedBatch(
				deps,
				batch.map((c) => c.text),
				"passage",
			);
		} catch (error) {
			deps.log(
				`stopped: ${errorCode(error)} (embedded ${report.embedded}, failed ${report.failed})`,
			);
			throw error;
		}
		report.busyWaits += outcome.busyWaits;
		if (!outcome.ok) {
			report.failed += batch.length;
			deps.log(
				`batch failed (${batch.length} rows): ${errorCode(outcome.error)}`,
			);
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				const reason = `${consecutiveFailures} consecutive batch failures (last: ${errorCode(outcome.error)})`;
				deps.log(
					`stopped: ${reason} (embedded ${report.embedded}, failed ${report.failed})`,
				);
				throw new EmbedAbortedError(reason, report.embedded, report.failed);
			}
			continue;
		}
		consecutiveFailures = 0;
		const vectors = outcome.vectors;
		const now = deps.now().toISOString();
		await deps.store.write((db) => {
			if (!spaceChecked) {
				if (ensureVectorSpace(db, LARM_EMBEDDING_SPACE, now) !== deps.spaceKey)
					throw new Error("vector_space_unknown");
				spaceChecked = true;
			}
			batch.forEach((candidate, i) => {
				upsertVector(db, {
					ownerKind: args.owner,
					ownerId: candidate.id,
					spaceKey: deps.spaceKey,
					contentDigest: candidate.digest,
					vector: vectors[i]!,
					origin: "larm",
					verification: "verified",
					now,
				});
			});
		});
		report.embedded += batch.length;
		deps.log(`embedded ${report.embedded}/${candidates.length}`);
	}
	return report;
}
