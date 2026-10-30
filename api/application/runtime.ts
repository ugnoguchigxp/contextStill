import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { getLogger } from "../infrastructure/logger";
import { vectorSpaceKey } from "../infrastructure/vector";
import {
	createLarmEmbedding,
	LARM_EMBEDDING_SPACE,
	type LarmEmbeddingClient,
} from "../domains/larm";
import { createQueue, type QueueService } from "../domains/queue";
import { createSearch, type SearchService } from "../domains/search";
import { createSettings, type SettingsService } from "../domains/settings";
import type { RuntimeConfig } from "./config";
import { allMigrations } from "./migrations";

const log = getLogger("runtime");

export interface RuntimeDeps {
	fetch?: typeof fetch;
	now?: () => Date;
}

export interface Runtime {
	config: RuntimeConfig;
	store: SqliteStore;
	settings: SettingsService;
	larm: LarmEmbeddingClient;
	/** Created without handlers and never started in N0/N1. */
	queue: QueueService;
	search: SearchService;
	/** `space_key` of the LARM embedding space every vector of this system belongs to. */
	spaceKey: string;
	now: () => Date;
	/** Releases the LARM connection and closes the store (and so the OS writer lock). */
	close(): Promise<void>;
}

/** Key of the one embedding space ContextStill uses (larm-embedding.v1). */
export const LARM_SPACE_KEY = vectorSpaceKey({
	modelId: LARM_EMBEDDING_SPACE.model.id,
	revision: LARM_EMBEDDING_SPACE.model.revision,
	artifactDigest: LARM_EMBEDDING_SPACE.model.artifactDigest,
	dimension: LARM_EMBEDDING_SPACE.dimension,
});

/**
 * The single place that opens the database. Throws `WriterOwnedError`
 * (`database_writer_owned`) while another process owns it.
 */
export async function openRuntime(
	config: RuntimeConfig,
	deps: RuntimeDeps = {},
): Promise<Runtime> {
	const now = deps.now ?? (() => new Date());
	const store = openStore(config.dbPath, allMigrations);
	try {
		const settings = await createSettings(store, {
			dbPath: config.dbPath,
			keyDir: config.keyDir,
			env: { CONTEXT_STILL_SECRET_KEY: config.secretKey },
			now,
		});
		const larm = createLarmEmbedding({
			baseUrl: () => settings.get().larm.baseUrl,
			token: () => config.larmToken,
			audience: () => settings.get().larm.audience,
			profile: () => settings.get().larm.embeddingProfile,
			// Looked up per call so that a test preload that blocks the global fetch stays in force.
			fetch:
				deps.fetch ??
				(((input, init) => globalThis.fetch(input, init)) as typeof fetch),
			now: () => now().getTime(),
		});
		const queue = createQueue(store);
		const search = createSearch({
			store,
			spaceKey: LARM_SPACE_KEY,
			embedQuery: async (text, signal) => {
				const [vector] = await larm.embed([text], "query", { signal });
				if (!vector) throw new Error("larm_contract_mismatch");
				return vector;
			},
		});
		return {
			config,
			store,
			settings,
			larm,
			queue,
			search,
			spaceKey: LARM_SPACE_KEY,
			now,
			async close() {
				try {
					await larm.release();
				} catch (error) {
					log.warn("runtime.larm_release_failed", {
						reason: (error as { code?: string }).code ?? "unknown",
					});
				}
				await store.close();
			},
		};
	} catch (error) {
		await store.close();
		throw error;
	}
}
