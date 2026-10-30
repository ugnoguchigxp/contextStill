import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { getLogger } from "../infrastructure/logger";
import { vectorSpaceKey } from "../infrastructure/vector";
import { createDistill, type DistillService } from "../domains/distill";
import { embedMissing } from "../domains/indexing";
import {
	createLarmChat,
	createLarmEmbedding,
	LARM_EMBEDDING_SPACE,
	type LarmEmbeddingClient,
	type LlmClient,
} from "../domains/larm";
import { createQueue, type QueueService } from "../domains/queue";
import { createSearch, type SearchService } from "../domains/search";
import { createSettings, type SettingsService } from "../domains/settings";
import { LEGACY_PORTS, type RuntimeConfig } from "./config";
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
	/** The LARM LLM connection that distill uses; claimed on the first call. */
	chat: LlmClient;
	/** Carries the distill handlers. Only the backend (server.ts) recovers and starts its runner. */
	queue: QueueService;
	search: SearchService;
	distill: DistillService;
	/** `space_key` of the LARM embedding space every vector of this system belongs to. */
	spaceKey: string;
	now: () => Date;
	/** Releases the LARM connections and closes the store (and so the OS writer lock). */
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
		const larmDeps = {
			baseUrl: () => settings.get().larm.baseUrl,
			token: () => config.larmToken,
			audience: () => settings.get().larm.audience,
			profile: () => settings.get().larm.embeddingProfile,
			// Looked up per call so that a test preload that blocks the global fetch stays in force.
			fetch:
				deps.fetch ??
				(((input, init) => globalThis.fetch(input, init)) as typeof fetch),
			now: () => now().getTime(),
		};
		const larm = createLarmEmbedding(larmDeps);
		const chat = createLarmChat({
			...larmDeps,
			llmProfile: () => settings.get().larm.llmProfile,
			forbiddenPorts: [...LEGACY_PORTS, config.port],
		});
		// One LLM slot until LARM's concurrent capacity is known (N2 plan 9.4).
		const queue = createQueue(store, {
			resources: { llm: 1, embedding: 1, cpu: 1 },
		});
		const search = createSearch({
			store,
			spaceKey: LARM_SPACE_KEY,
			embedQuery: async (text, signal) => {
				const [vector] = await larm.embed([text], "query", { signal });
				if (!vector) throw new Error("larm_contract_mismatch");
				return vector;
			},
		});
		const distill = createDistill({
			store,
			llm: chat,
			queue,
			spaceKey: LARM_SPACE_KEY,
			embedKnowledge: () =>
				embedMissing(
					{
						store,
						larm,
						spaceKey: LARM_SPACE_KEY,
						now,
						log: (line) => log.info("distill.embed", { line }),
						sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
					},
					{ owner: "knowledge", mode: "missing", batchSize: 16, dryRun: false },
				),
			now,
			log: (line) => log.info("distill", { line }),
		});
		distill.registerHandlers();
		return {
			config,
			store,
			settings,
			larm,
			chat,
			queue,
			search,
			distill,
			spaceKey: LARM_SPACE_KEY,
			now,
			async close() {
				for (const client of [larm, chat])
					try {
						await client.release();
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
