import type { Database } from "bun:sqlite";
import {
	getKnowledgeById,
	listSupersededBy,
	type KnowledgeRow,
} from "../../../knowledge";
import { getVector } from "../../../vectors";
import {
	type AuditCode,
	type AuditModule,
	type AuditReport,
	type CanonicalDraft,
	type DistillDeps,
} from "../../contracts";
import { listUnresolvedConflictPairs } from "../../repository";
import { buildRepoTerms, checkNovelty, lintGeneralization } from "../checks";
import { runSync, runYielding } from "../cluster/neighbors";
import { unjudgedSteps } from "../conflict/candidates";
import {
	listActiveCanonicals,
	listRepoKeys,
	listSupersededAtoms,
} from "../conflict/reads";
import { canonicalAtomIds } from "../conflict/strength";
import { listKnowledgeEvidence } from "../../../knowledge";

export { resampleJudgments, type ResampleReport } from "./resample";

const CODES: readonly AuditCode[] = [
	"unresolved_conflict",
	"unjudged_near_pair",
	"citation_invalid",
	"generalization_lint",
	"superseded_without_target",
	"active_atom_absorbed",
	"canonical_without_vector",
	"repo_scope_canonical",
];

/** Superseded atoms looked at in one read. */
const ATOM_CHUNK = 500;

const textOf = (row: KnowledgeRow) => `${row.title}\n${row.body}`;

/** The draft view of a stored canonical, for the same lint the canonical stage ran. */
function asDraft(row: KnowledgeRow): CanonicalDraft {
	return {
		type: row.type,
		polarity: row.polarity,
		title: row.title,
		situation: row.situation,
		guidance: row.body,
		rationale: row.rationale,
		appliesWhen: row.appliesWhen,
		notAppliesWhen: row.notAppliesWhen,
		steps: row.steps,
		exceptions: row.exceptions,
		claims: [],
	};
}

/**
 * Citations of one canonical: it has atoms to cite, they all exist, and every claim (the quote
 * of its evidence rows) is carried by the atoms that name it (the novelty rule of 6.4).
 */
function citationsValid(db: Database, canonical: KnowledgeRow): boolean {
	const atomIds = canonicalAtomIds(db, canonical.id);
	if (atomIds.length === 0) return false;
	const byQuote = new Map<string, string[]>();
	for (const e of listKnowledgeEvidence(db, canonical.id)) {
		if (e.targetKind !== "atom" || e.role !== "derived_from" || !e.targetId)
			continue;
		const atom = getKnowledgeById(db, e.targetId);
		if (!atom) return false;
		if (e.quote === null || e.quote.trim() === "") continue;
		const list = byQuote.get(e.quote) ?? [];
		list.push(textOf(atom));
		byQuote.set(e.quote, list);
	}
	for (const [quote, supports] of byQuote)
		if (!checkNovelty(quote, supports).ok) return false;
	return true;
}

/**
 * S7 (6.6): "the active canonicals do not contradict each other", checked from the tables.
 * `checked` counts what each check looked at; a violation names its subject (canonical ids,
 * or an atom id then its canonical id for `active_atom_absorbed`). Reads only.
 *
 * The check is a generator: every step is a read of its own and the generator yields between
 * steps (the candidate scan and every canonical), so that `auditYielding` lets the event loop
 * run and `audit` runs the same steps to the end. The reads are therefore not one snapshot: a
 * write between two of them is seen by the later ones only.
 */
function* auditSteps(deps: DistillDeps): Generator<void, AuditReport, void> {
	const { store } = deps;
	const violations: AuditReport["violations"] = [];
	const checked = Object.fromEntries(CODES.map((c) => [c, 0])) as Record<
		AuditCode,
		number
	>;
	const flag = (code: AuditCode, ...subject: string[]) =>
		violations.push({ code, subject });

	const head = store.read((db) => {
		const active = listActiveCanonicals(db);
		const activeIds = active.map((c) => c.id);
		return {
			active,
			unresolved: listUnresolvedConflictPairs(db, activeIds),
			repoTerms: buildRepoTerms(listRepoKeys(db)),
			supersededAtoms: listSupersededAtoms(db),
		};
	});
	const activeCount = head.active.length;

	// 1. unresolved conflicts between active canonicals
	checked.unresolved_conflict = activeCount;
	for (const [a, b] of head.unresolved) flag("unresolved_conflict", a, b);
	yield;

	// 2. candidate pairs without a judgment of their current texts
	const unjudged = yield* unjudgedSteps(store, deps.spaceKey);
	checked.unjudged_near_pair = activeCount;
	for (const p of unjudged) flag("unjudged_near_pair", p.a, p.b);

	// 3. citations and generalization, again, and the rest, one canonical a step
	for (const c of head.active) {
		store.read((db) => {
			const row = getKnowledgeById(db, c.id);
			if (!row) return;
			checked.citation_invalid++;
			if (!citationsValid(db, row)) flag("citation_invalid", c.id);
			checked.generalization_lint++;
			if (lintGeneralization(asDraft(row), head.repoTerms).length > 0)
				flag("generalization_lint", c.id);

			// 5. a vector made from the current text, and the global scope
			checked.canonical_without_vector++;
			const v = getVector(db, "knowledge", c.id, deps.spaceKey);
			if (!v || v.contentDigest !== row.contentDigest)
				flag("canonical_without_vector", c.id);
			checked.repo_scope_canonical++;
			if (row.scope !== "global" || row.repoKey !== null)
				flag("repo_scope_canonical", c.id);

			// 4b. none of the atoms a canonical stands on is still active
			for (const atomId of canonicalAtomIds(db, c.id)) {
				checked.active_atom_absorbed++;
				if (getKnowledgeById(db, atomId)?.status === "active")
					flag("active_atom_absorbed", atomId, c.id);
			}
		});
		yield;
	}

	// 4a. every superseded atom leads to an active or superseded canonical
	for (let i = 0; i < head.supersededAtoms.length; i += ATOM_CHUNK) {
		const chunk = head.supersededAtoms.slice(i, i + ATOM_CHUNK);
		store.read((db) => {
			for (const atomId of chunk) {
				checked.superseded_without_target++;
				if (listSupersededBy(db, atomId).length === 0)
					flag("superseded_without_target", atomId);
			}
		});
		yield;
	}

	return { ok: violations.length === 0, violations, checked };
}

/** The audit; `auditYielding` is the same check that lets the event loop run between steps. */
export function createAudit(deps: DistillDeps): AuditModule {
	return {
		audit: () => runSync(auditSteps(deps)),
		auditYielding: () => runYielding(auditSteps(deps)),
	};
}
