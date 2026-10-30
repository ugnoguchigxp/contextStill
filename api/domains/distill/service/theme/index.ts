import type { Database } from "bun:sqlite";
import { z } from "zod";
import { sha256Hex } from "../../../../infrastructure/digest";
import { getKnowledgeById } from "../../../knowledge";
import {
	getCluster,
	listClusterMembers,
	setClusterState,
	upsertCluster,
	upsertFacetConcept,
} from "../../../map";
import type { HandlerDefinition } from "../../../queue";
import { getVector } from "../../../vectors";
import {
	DistillError,
	themeOutput,
	type DistillDeps,
	type DistillStage,
	type StartStageOptions,
	type ThemeModule,
	type ThemeOutput,
} from "../../contracts";
import {
	FACET_PROMPT_VERSION,
	FACET_SYSTEM,
	facetRepairUser,
	facetUser,
} from "../../prompts/facet";
import {
	THEME_PROMPT_VERSION,
	THEME_SYSTEM,
	themeRepairUser,
	themeUser,
} from "../../prompts/theme";
import { addRunCounts, finishRun, insertReview } from "../../repository";
import { buildRepoTerms, repoSignals } from "../checks";
import { callJson } from "../llm";
import {
	checkFacetOutput,
	conceptsOf,
	decideFacets,
	facetOutput,
	planFacetBatches,
	type FacetBatch,
} from "./facets";
import {
	applyThemes,
	clusterThemes,
	leafThemeOf,
	reconcileThemes,
	type ThemePoint,
} from "./plan";
import {
	collectFacetEvidence,
	listActiveCanonicals,
	listRepoKeys,
} from "./queries";
import {
	classifyError,
	clearWorkTail,
	enqueueWindow,
	reviewId,
	runIsOpen,
	saveWorkTail,
	settleRunJob,
	type WorkItem,
} from "./work";

const KIND = "distill.theme";
/** Share of the canonicals that may lack a usable vector before the stage refuses (6.0). */
const UNUSABLE_MAX = 0.01;

const payloadSchema = z.union([
	z.strictObject({
		runId: z.string().min(1),
		seq: z.number().int().min(0),
		themeId: z.string().min(1),
	}),
	z.strictObject({
		runId: z.string().min(1),
		seq: z.number().int().min(0),
		facet: z.strictObject({
			key: z.enum(["domains", "technologies", "changeTypes"]),
			values: z.array(z.string().max(80)).min(1).max(50),
		}),
	}),
]);
type Payload = z.infer<typeof payloadSchema>;

interface ThemeItem {
	alias: string;
	id: string;
	title: string;
	situation: string;
	body: string;
}
type Input =
	| { type: "skip" }
	| {
			type: "theme";
			runId: string;
			themeId: string;
			level: 1 | 2;
			memberDigest: string;
			items: ThemeItem[];
			repoTerms: string[];
	  }
	| { type: "facet"; runId: string; batch: FacetBatch; repoTerms: string[] };

type Output =
	| { type: "skip" }
	| {
			type: "theme";
			status: "ok";
			output: ThemeOutput;
			keyMembers: string[];
			callId: string;
	  }
	| { type: "theme"; status: "rejected" | "invalid"; findings: string[] }
	| {
			type: "facet";
			status: "ok";
			concepts: { rawValue: string; concept: string }[];
	  }
	| { type: "facet"; status: "rejected" | "invalid"; findings: string[] };

/** Host check of a theme page (6.9): key members are members of the theme, no repo specifics. */
export function checkTheme(
	output: ThemeOutput,
	aliases: ReadonlySet<string>,
	repoTerms: readonly string[],
): string[] {
	const findings: string[] = [];
	const seen = new Set<string>();
	for (const alias of output.keyMembers) {
		if (!aliases.has(alias))
			findings.push(`keyMembers: ${alias} is not a member of the theme`);
		else if (seen.has(alias))
			findings.push(`keyMembers: ${alias} is listed twice`);
		seen.add(alias);
	}
	if (output.name.trim().length === 0) findings.push("name: empty");
	const fields: [string, string][] = [
		["name", output.name],
		["description", output.description],
		["overview", output.overview],
		...output.aliases.map((v, i): [string, string] => [`aliases[${i}]`, v]),
		...output.cautions.map((v, i): [string, string] => [`cautions[${i}]`, v]),
		...output.openQuestions.map((v, i): [string, string] => [
			`openQuestions[${i}]`,
			v,
		]),
	];
	for (const [field, text] of fields) {
		const s = repoSignals(text, repoTerms);
		for (const m of s.repoTerms) findings.push(`${field}: repo_term ${m}`);
		for (const m of s.absolutePaths)
			findings.push(`${field}: absolute_path ${m}`);
		for (const m of s.relativePaths)
			findings.push(`${field}: relative_path ${m}`);
		for (const m of s.ports) findings.push(`${field}: port ${m}`);
	}
	return findings;
}

export function createTheme(deps: DistillDeps): ThemeModule {
	const repoTermsOf = (db: Database) => buildRepoTerms(listRepoKeys(db));

	async function writePage(
		input: Extract<Input, { type: "theme" }>,
		signal: AbortSignal,
	): Promise<Output> {
		const aliases = new Set(input.items.map((i) => i.alias));
		const base = themeUser({ level: input.level, items: input.items });
		const ask = (user: string) =>
			callJson(deps, {
				runId: input.runId,
				stage: "theme",
				subjectRef: `theme:${input.themeId}`,
				promptVersion: THEME_PROMPT_VERSION,
				system: THEME_SYSTEM,
				user,
				schema: themeOutput,
				maxOutputTokens: 1500,
				signal,
			});
		try {
			let answer = await ask(base);
			let findings = checkTheme(answer.value, aliases, input.repoTerms);
			if (findings.length > 0) {
				answer = await ask(themeRepairUser(base, findings));
				findings = checkTheme(answer.value, aliases, input.repoTerms);
			}
			if (findings.length > 0)
				return { type: "theme", status: "rejected", findings };
			const byAlias = new Map(input.items.map((i) => [i.alias, i.id]));
			return {
				type: "theme",
				status: "ok",
				output: answer.value,
				keyMembers: answer.value.keyMembers.map((a) => byAlias.get(a)!),
				callId: answer.callId,
			};
		} catch (error) {
			if (error instanceof DistillError && error.code === "llm_invalid_output")
				return { type: "theme", status: "invalid", findings: [] };
			throw error;
		}
	}

	async function normalizeFacets(
		input: Extract<Input, { type: "facet" }>,
		signal: AbortSignal,
	): Promise<Output> {
		const { key, values } = input.batch;
		const base = facetUser({ key, values });
		const ask = (user: string) =>
			callJson(deps, {
				runId: input.runId,
				stage: "theme",
				subjectRef: `facet:${key}`,
				promptVersion: FACET_PROMPT_VERSION,
				system: FACET_SYSTEM,
				user,
				schema: facetOutput,
				maxOutputTokens: 3000,
				signal,
			});
		try {
			let answer = await ask(base);
			let findings = checkFacetOutput(
				answer.value,
				values.length,
				input.repoTerms,
			);
			if (findings.length > 0) {
				answer = await ask(facetRepairUser(base, findings));
				findings = checkFacetOutput(
					answer.value,
					values.length,
					input.repoTerms,
				);
			}
			if (findings.length > 0)
				return { type: "facet", status: "rejected", findings };
			return {
				type: "facet",
				status: "ok",
				concepts: conceptsOf(answer.value, values),
			};
		} catch (error) {
			if (error instanceof DistillError && error.code === "llm_invalid_output")
				return { type: "facet", status: "invalid", findings: [] };
			throw error;
		}
	}

	function settleTheme(
		tx: Database,
		payload: Extract<Payload, { themeId: string }>,
		input: Extract<Input, { type: "theme" }> | null,
		output: Output,
		at: string,
	): Record<string, number> {
		if (output.type !== "theme" || input === null) return {};
		const theme = getCluster(tx, payload.themeId);
		// The members changed while the model worked: the next run plans the theme again.
		if (!theme || theme.memberDigest !== input.memberDigest)
			return { stale: 1 };
		if (output.status === "ok") {
			const out = output.output;
			const name = out.name.trim();
			upsertCluster(tx, {
				...theme,
				name,
				aliases: [
					...new Set(
						out.aliases
							.map((a) => a.trim())
							.filter((a) => a.length > 0 && a !== name),
					),
				],
				description: out.description.trim(),
				summary: {
					overview: out.overview,
					keyMembers: output.keyMembers,
					cautions: out.cautions,
					openQuestions: out.openQuestions,
					promptVersion: THEME_PROMPT_VERSION,
					callId: output.callId,
				},
				members: listClusterMembers(tx, theme.id),
				updatedAt: at,
			});
			setClusterState(tx, theme.id, "distilled", at);
			return { distilled: 1 };
		}
		setClusterState(tx, theme.id, "review", at);
		insertReview(tx, {
			id: reviewId("host_rejected", "theme", theme.id, theme.memberDigest),
			kind: "host_rejected",
			subject: {
				stage: "theme",
				themeId: theme.id,
				reason:
					output.status === "rejected" ? "host_check" : "llm_invalid_output",
				findings: output.findings,
			},
			at,
		});
		return { review: 1 };
	}

	function settleFacet(
		tx: Database,
		payload: Extract<Payload, { facet: unknown }>,
		output: Output,
		at: string,
	): Record<string, number> {
		if (output.type !== "facet") return {};
		if (output.status === "ok") {
			let mapped = 0;
			for (const c of output.concepts) {
				const result = upsertFacetConcept(tx, {
					facetKey: payload.facet.key,
					rawValue: c.rawValue,
					concept: c.concept,
					themeId: null,
					origin: "llm",
					at,
				});
				if (result !== "unchanged") mapped++;
			}
			return { facetsMapped: mapped };
		}
		insertReview(tx, {
			id: reviewId(
				"host_rejected",
				"facet",
				payload.facet.key,
				sha256Hex(payload.facet.values.join("\n")),
			),
			kind: "host_rejected",
			subject: {
				stage: "theme",
				facetKey: payload.facet.key,
				values: payload.facet.values.length,
				reason:
					output.status === "rejected" ? "host_check" : "llm_invalid_output",
				findings: output.findings,
			},
			at,
		});
		return { review: 1 };
	}

	const handler: HandlerDefinition<Payload, Input, Output> = {
		kind: KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "replay_safe",
		resourceKey: "llm",
		classify: classifyError,
		prepareInTransaction(tx, claim) {
			const p = claim.payload;
			if (!runIsOpen(tx, p.runId))
				return { status: "stale", reason: "run_closed" };
			if ("facet" in p)
				return {
					status: "ready",
					input: {
						type: "facet",
						runId: p.runId,
						batch: { key: p.facet.key, values: p.facet.values },
						repoTerms: repoTermsOf(tx),
					},
				};
			const theme = getCluster(tx, p.themeId);
			if (
				!theme ||
				theme.kind !== "theme" ||
				theme.state === "distilled" ||
				theme.state === "rejected"
			)
				return { status: "ready", input: { type: "skip" } };
			const ranked = listClusterMembers(tx, theme.id).sort(
				(a, b) =>
					(b.similarity ?? 0) - (a.similarity ?? 0) || (a.id < b.id ? -1 : 1),
			);
			const items: ThemeItem[] = [];
			for (const m of ranked) {
				if (items.length >= 20) break;
				const row = getKnowledgeById(tx, m.id);
				if (!row || row.status !== "active") continue;
				items.push({
					alias: `a${items.length + 1}`,
					id: row.id,
					title: row.title,
					situation: row.situation,
					body: row.body,
				});
			}
			if (items.length === 0)
				return { status: "ready", input: { type: "skip" } };
			return {
				status: "ready",
				input: {
					type: "theme",
					runId: p.runId,
					themeId: theme.id,
					level: theme.level === 1 ? 1 : 2,
					memberDigest: theme.memberDigest,
					items,
					repoTerms: repoTermsOf(tx),
				},
			};
		},
		async execute(input, context) {
			if (input.type === "theme") return writePage(input, context.signal);
			if (input.type === "facet") return normalizeFacets(input, context.signal);
			return { type: "skip" };
		},
		settleInTransaction(tx, claim, input, outcome) {
			if (outcome.type === "retry") return "applied";
			const p = claim.payload;
			const at = deps.now().toISOString();
			const counts =
				outcome.type === "success"
					? "facet" in p
						? settleFacet(tx, p, outcome.result, at)
						: settleTheme(
								tx,
								p,
								input?.type === "theme" ? input : null,
								outcome.result,
								at,
							)
					: {};
			settleRunJob(tx, deps, {
				stage: "theme",
				runId: p.runId,
				seq: p.seq,
				fatal: outcome.type !== "success",
				counts,
			});
			return "applied";
		},
		cancelInTransaction(tx, job) {
			// Cancelling one job cancels the run: the jobs not fed yet would never end.
			addRunCounts(tx, job.payload.runId, { cancelled: 1 });
			const at = deps.now().toISOString();
			clearWorkTail(tx, "theme", job.payload.runId, at);
			finishRun(tx, job.payload.runId, "cancelled", at);
		},
	};

	return {
		registerHandlers() {
			deps.queue.registerHandler(handler);
		},
		async start(
			stage: DistillStage,
			runId: string,
			opts: StartStageOptions,
		): Promise<number> {
			if (stage !== "theme") throw new DistillError("invalid_distill_request");
			// Read the canonicals and their vectors. A vector counts only when it belongs to the
			// current text and is verified (6.0), unless this is a pilot run.
			const loaded = deps.store.read((db) => {
				const canonicals = listActiveCanonicals(db);
				const points: ThemePoint[] = [];
				for (const c of canonicals) {
					const v = getVector(db, "knowledge", c.id, deps.spaceKey);
					if (
						v &&
						v.contentDigest === c.contentDigest &&
						(opts.allowUnverified ||
							v.origin === "larm" ||
							v.verification === "verified")
					)
						points.push({
							id: c.id,
							contentDigest: c.contentDigest,
							vector: v.vector,
						});
				}
				return {
					total: canonicals.length,
					points,
					evidence: collectFacetEvidence(db),
				};
			});
			if (loaded.total === 0) return 0;
			const unusable = loaded.total - loaded.points.length;
			if (
				loaded.points.length === 0 ||
				(!opts.allowUnverified && unusable > loaded.total * UNUSABLE_MAX)
			)
				throw new DistillError("distill_vectors_unverified");

			const raw = await clusterThemes(loaded.points);
			const digests = new Map(
				loaded.points.map((p) => [p.id, p.contentDigest]),
			);
			const at = deps.now().toISOString();

			const plan = (db: Database) => {
				const themes = reconcileThemes(
					db,
					raw,
					digests,
					at,
					opts.allowUnverified === true,
				);
				const facets = decideFacets(loaded.evidence, leafThemeOf(themes));
				const asked = planFacetBatches(db, facets.undecided);
				const items: WorkItem[] = [];
				const wanted = themes.themes
					.filter((t) => t.needsJob)
					.sort((a, b) => b.level - a.level || (a.id < b.id ? -1 : 1));
				for (const t of wanted)
					items.push({
						kind: KIND,
						dedupeKey: `theme:${runId}:${t.id}:${t.memberDigest}:${THEME_PROMPT_VERSION}`,
						subjectRef: `theme:${t.id}`,
						payload: { runId, seq: items.length, themeId: t.id },
					});
				for (const batch of asked.batches)
					items.push({
						kind: KIND,
						dedupeKey: `facet:${runId}:${batch.key}:${sha256Hex(batch.values.join("\n"))}:${FACET_PROMPT_VERSION}`,
						subjectRef: `facet:${batch.key}`,
						payload: { runId, seq: items.length, facet: batch },
					});
				return {
					themes,
					facets,
					skipped: asked.skipped,
					items: opts.limit === undefined ? items : items.slice(0, opts.limit),
				};
			};

			if (opts.dryRun) return deps.store.read(plan).items.length;

			const result = await deps.store.write((db) => {
				const p = plan(db);
				applyThemes(db, p.themes, at);
				for (const m of p.facets.mapped)
					upsertFacetConcept(db, {
						facetKey: m.facetKey,
						rawValue: m.rawValue,
						concept: m.rawValue,
						themeId: m.themeId,
						origin: "deterministic",
						at,
					});
				saveWorkTail(db, "theme", runId, p.items, at);
				addRunCounts(db, runId, {
					planned: p.items.length,
					themes: p.themes.themes.length,
					inherited: p.themes.inherited,
					dropped: p.themes.dropped.length,
					excluded: unusable,
					facetsDeterministic: p.facets.mapped.length,
					facetsSkipped: p.skipped,
				});
				return p;
			});
			await enqueueWindow(deps, result.items);
			return result.items.length;
		},
	};
}
