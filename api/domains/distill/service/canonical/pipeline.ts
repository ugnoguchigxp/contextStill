import {
	DistillError,
	plannerOutput,
	verifierOutput,
	type CanonicalDraft,
	type DistillDeps,
	type PlannerOutput,
	type VerifierOutput,
} from "../../contracts";
import {
	buildPlanRepairUser,
	buildPlanUser,
	buildReviseUser,
	CANONICAL_PLAN_SYSTEM,
	CANONICAL_PLAN_VERSION,
	type PlanAtom,
	type VerifierFeedback,
} from "../../prompts/canonical-plan";
import {
	buildVerifyUser,
	CANONICAL_VERIFY_SYSTEM,
	CANONICAL_VERIFY_VERSION,
} from "../../prompts/canonical-verify";
import { callJson } from "../llm";
import { checkPlan, polarityTie } from "./host";
import type {
	AtomView,
	GroupResult,
	PlannedRelation,
	UnitInput,
	UnitResult,
	VerifierSummary,
	Violation,
} from "./types";

const PLAN_MAX_OUTPUT_TOKENS = 6000;
const VERIFY_MAX_OUTPUT_TOKENS = 1500;

export function planAtom(atom: AtomView): PlanAtom {
	const r = atom.row;
	return {
		ref: atom.alias,
		type: r.type,
		polarity: r.polarity,
		title: r.title,
		body: r.body,
		appliesWhen: r.appliesWhen,
		notAppliesWhen: r.notAppliesWhen,
		steps: r.steps,
		repoScoped: r.scope === "repo" || r.repoKey !== null,
		generality: atom.generality,
	};
}

/** How the verifier's answer is read (6.4): only a full "supported" is accepted. */
export type VerifierClass = "accepted" | "rejected" | "unknown";

export function classifyVerifier(
	out: VerifierOutput,
	claimCount: number,
): { class: VerifierClass; summary: VerifierSummary } {
	const entailed = new Map<
		number,
		VerifierOutput["claims"][number]["entailed"]
	>();
	for (const c of out.claims) entailed.set(c.index, c.entailed);
	const failedClaims: number[] = [];
	let unknownClaim = false;
	for (let i = 0; i < claimCount; i++) {
		const e = entailed.get(i);
		if (e === "no") failedClaims.push(i);
		else if (e !== "yes") unknownClaim = true;
	}
	const checks = Object.entries(out.checks);
	const failedChecks = checks
		.filter(([, v]) => v === "not_preserved")
		.map(([k]) => k);
	const unknownCheck = checks.some(([, v]) => v === "unknown");
	const summary: VerifierSummary = {
		verdict: out.verdict,
		rationale: out.rationale,
		failedClaims,
		failedChecks,
	};
	const bad = failedClaims.length > 0 || failedChecks.length > 0;
	if (out.verdict === "supported" && !bad && !unknownClaim && !unknownCheck)
		return { class: "accepted", summary };
	if (out.verdict === "rejected" || bad) return { class: "rejected", summary };
	return { class: "unknown", summary };
}

interface Ctx {
	deps: DistillDeps;
	input: UnitInput;
	signal: AbortSignal;
}

const subjectOf = (input: UnitInput) =>
	input.clusterId ? `canonical:${input.clusterId}` : "canonical:singles";

const violationLines = (violations: readonly Violation[]) =>
	violations.map((v) => ({
		code: v.code,
		group: v.groupIndex,
		detail: v.detail,
	}));

type Verified = Awaited<ReturnType<typeof verify>>;

async function verify(
	ctx: Ctx,
	members: readonly AtomView[],
	draft: CanonicalDraft,
) {
	const result = await callJson(ctx.deps, {
		runId: ctx.input.runId,
		stage: "canonical",
		subjectRef: subjectOf(ctx.input),
		promptVersion: CANONICAL_VERIFY_VERSION,
		system: CANONICAL_VERIFY_SYSTEM,
		user: buildVerifyUser(members.map(planAtom), draft),
		schema: verifierOutput,
		maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
		signal: ctx.signal,
	});
	return {
		...classifyVerifier(result.value, draft.claims.length),
		callId: result.callId,
	};
}

const isInvalid = (error: unknown) =>
	error instanceof DistillError && error.code === "llm_invalid_output";

type ReviewResult = Extract<GroupResult, { kind: "review" }>;

/**
 * The planner, the host checks, the verifier and the one repair of each (6.4). It writes no
 * business row (the LLM call rows are written by `callJson`). An answer the model could not make
 * valid ends in a review result, never in an exception; a `LarmError` is rethrown for the queue.
 */
export async function distillUnit(
	deps: DistillDeps,
	input: UnitInput,
	signal: AbortSignal,
): Promise<UnitResult> {
	const ctx: Ctx = { deps, input, signal };
	const atoms = input.atoms;
	const byAlias = new Map(atoms.map((a) => [a.alias, a]));
	const hostCtx = { atoms, repoTerms: input.repoTerms, mode: input.kind };
	const firstUser = buildPlanUser(atoms.map(planAtom), input.kind);

	// Without a usable plan a cluster is one review subject; singles are reviewed one by one.
	const unplanned = (reason: string): UnitResult => {
		const groupsOf =
			input.kind === "cluster"
				? [atoms.map((a) => a.alias)]
				: atoms.map((a) => [a.alias]);
		return {
			groups: groupsOf.map((members): ReviewResult => ({
				kind: "review",
				review: "host_rejected",
				members,
				draft: null,
				violations: [],
				verifier: null,
				reason,
				plannerCallId: null,
				verifierCallId: null,
				index: null,
			})),
			relations: [],
			relationsDropped: 0,
		};
	};

	let plan: PlannerOutput;
	let plannerCallId: string;
	try {
		const first = await callJson(deps, {
			runId: input.runId,
			stage: "canonical",
			subjectRef: subjectOf(input),
			promptVersion: CANONICAL_PLAN_VERSION,
			system: CANONICAL_PLAN_SYSTEM,
			user: firstUser,
			schema: plannerOutput,
			maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
			signal,
		});
		plan = first.value;
		plannerCallId = first.callId;
	} catch (error) {
		if (isInvalid(error)) return unplanned("planner_invalid_output");
		throw error;
	}

	let violations = checkPlan(plan, hostCtx);
	if (violations.length > 0) {
		try {
			const repaired = await callJson(deps, {
				runId: input.runId,
				stage: "canonical",
				subjectRef: subjectOf(input),
				promptVersion: CANONICAL_PLAN_VERSION,
				system: CANONICAL_PLAN_SYSTEM,
				user: buildPlanRepairUser(firstUser, plan, violationLines(violations)),
				schema: plannerOutput,
				maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
				signal,
			});
			plan = repaired.value;
			plannerCallId = repaired.callId;
			violations = checkPlan(plan, hostCtx);
		} catch (error) {
			// The first answer and its violations stand.
			if (!isInvalid(error)) throw error;
		}
	}

	const rejected = new Set<number>();
	for (const v of violations)
		if (v.groupIndex !== null) rejected.add(v.groupIndex);
	// An alias no group holds is reviewed as a group of its own.
	const uncovered = violations
		.filter((v) => v.code === "coverage_missing" && byAlias.has(v.detail))
		.map((v) => v.detail);
	const relationsDropped = violations.filter(
		(v) => v.code === "relation_index",
	).length;

	const results: GroupResult[] = [];
	for (let index = 0; index < plan.groups.length; index++) {
		const group = plan.groups[index]!;
		const members = group.members.filter((a) => byAlias.has(a));
		if (rejected.has(index)) {
			results.push({
				kind: "review",
				review: "host_rejected",
				members,
				draft: group.canonical,
				violations: violations.filter((v) => v.groupIndex === index),
				verifier: null,
				reason: "host_check",
				plannerCallId,
				verifierCallId: null,
				index,
			});
		} else if (group.disposition !== "canonical") {
			results.push({
				kind: "disposition",
				members,
				disposition: group.disposition,
				plannerCallId,
				index,
			});
		} else {
			results.push(
				await verifyGroup(ctx, {
					index,
					members,
					draft: group.canonical!,
					tie: polarityTie(group, byAlias),
					plannerCallId,
					byAlias,
				}),
			);
		}
	}
	if (uncovered.length > 0)
		results.push({
			kind: "review",
			review: "host_rejected",
			members: uncovered,
			draft: null,
			violations: violations.filter((v) => v.code === "coverage_missing"),
			verifier: null,
			reason: "host_check",
			plannerCallId,
			verifierCallId: null,
			index: null,
		});

	const relations: PlannedRelation[] = plan.relations.filter(
		(r) => r.a < plan.groups.length && r.b < plan.groups.length && r.a !== r.b,
	);
	return { groups: results, relations, relationsDropped };
}

interface GroupJob {
	index: number;
	members: string[];
	draft: CanonicalDraft;
	tie: boolean;
	plannerCallId: string;
	byAlias: ReadonlyMap<string, AtomView>;
}

/** The verifier, and after a "rejected" one revision of the draft and a second verifier pass. */
async function verifyGroup(ctx: Ctx, job: GroupJob): Promise<GroupResult> {
	const memberAtoms = job.members.map((a) => job.byAlias.get(a)!);
	const review = (
		kind: ReviewResult["review"],
		over: Partial<ReviewResult>,
	): ReviewResult => ({
		kind: "review",
		review: kind,
		members: job.members,
		draft: job.draft,
		violations: [],
		verifier: null,
		reason: kind,
		plannerCallId: job.plannerCallId,
		verifierCallId: null,
		index: job.index,
		...over,
	});
	const adopted = (
		draft: CanonicalDraft,
		plannerCallId: string,
		verifierCallId: string,
	): GroupResult => ({
		kind: "canonical",
		members: job.members,
		draft,
		plannerCallId,
		verifierCallId,
		polarityTie: job.tie,
		index: job.index,
	});

	let first: Verified;
	try {
		first = await verify(ctx, memberAtoms, job.draft);
	} catch (error) {
		if (isInvalid(error))
			return review("verifier_unknown", { reason: "verifier_invalid_output" });
		throw error;
	}
	if (first.class === "accepted")
		return adopted(job.draft, job.plannerCallId, first.callId);
	if (first.class === "unknown")
		return review("verifier_unknown", {
			verifier: first.summary,
			verifierCallId: first.callId,
			reason: "verifier_unknown",
		});

	// Rejected: the planner revises this group once; the revision passes the checks and the verifier again.
	const feedback: VerifierFeedback = first.summary;
	const afterFirst = {
		verifier: first.summary,
		verifierCallId: first.callId,
	};
	let revised: PlannerOutput;
	let revisedCallId: string;
	try {
		const call = await callJson(ctx.deps, {
			runId: ctx.input.runId,
			stage: "canonical",
			subjectRef: subjectOf(ctx.input),
			promptVersion: CANONICAL_PLAN_VERSION,
			system: CANONICAL_PLAN_SYSTEM,
			user: buildReviseUser(memberAtoms.map(planAtom), job.draft, feedback),
			schema: plannerOutput,
			maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
			signal: ctx.signal,
		});
		revised = call.value;
		revisedCallId = call.callId;
	} catch (error) {
		if (isInvalid(error))
			return review("verifier_unknown", {
				...afterFirst,
				reason: "revision_invalid_output",
			});
		throw error;
	}
	const group = revised.groups[0];
	if (
		revised.groups.length !== 1 ||
		!group ||
		group.disposition !== "canonical" ||
		group.canonical === null ||
		group.members.length !== job.members.length ||
		!job.members.every((a) => group.members.includes(a))
	)
		return review("verifier_unknown", {
			...afterFirst,
			reason: "revision_changed_group",
		});
	const draft = group.canonical;
	const local = checkPlan(
		{ ...revised, relations: [] },
		{ atoms: memberAtoms, repoTerms: ctx.input.repoTerms, mode: "cluster" },
	).map((v) => ({ ...v, groupIndex: job.index }));
	if (local.length > 0)
		return review("host_rejected", {
			...afterFirst,
			draft,
			violations: local,
			plannerCallId: revisedCallId,
			reason: "host_check_after_revision",
		});
	let second: Verified;
	try {
		second = await verify(ctx, memberAtoms, draft);
	} catch (error) {
		if (isInvalid(error))
			return review("verifier_unknown", {
				draft,
				plannerCallId: revisedCallId,
				reason: "verifier_invalid_output",
			});
		throw error;
	}
	if (second.class === "accepted")
		return adopted(draft, revisedCallId, second.callId);
	return review("verifier_unknown", {
		draft,
		plannerCallId: revisedCallId,
		verifier: second.summary,
		verifierCallId: second.callId,
		reason: "verifier_not_supported",
	});
}
