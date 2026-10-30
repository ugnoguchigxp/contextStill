import type { Migration } from "../infrastructure/sqlite";
import { migrations as distill } from "../domains/distill";
import { migrations as experience } from "../domains/experience";
import { migrations as knowledge } from "../domains/knowledge";
import { migrations as legacy } from "../domains/legacy";
import { migrations as map } from "../domains/map";
import { migrations as queue } from "../domains/queue";
import { migrations as settings } from "../domains/settings";
import { migrations as sources } from "../domains/sources";
import { migrations as usage } from "../domains/usage";
import { migrations as vectors } from "../domains/vectors";

/**
 * Every migration of the product, in the registration order the golden test pins. A migration
 * is never edited or reordered after it is deployed; new ones are appended with their `after`.
 * The order is written out id by id: it does not depend on the order of the domain arrays.
 */
const REGISTRATION_ORDER = [
	"settings/0001-init",
	"queue/0001-init",
	"sources/0001-init",
	"experience/0001-init",
	"knowledge/0001-init",
	"vectors/0001-init",
	"usage/0001-init",
	"legacy/0001-init",
	"map/0001-init",
	"knowledge/0002-canonical",
	"experience/0002-retrieval",
	"distill/0001-init",
] as const;

const declared = new Map<string, Migration>(
	[
		...settings,
		...queue,
		...sources,
		...experience,
		...knowledge,
		...vectors,
		...usage,
		...legacy,
		...map,
		...distill,
	].map((m) => [m.id, m]),
);

export const allMigrations: readonly Migration[] = REGISTRATION_ORDER.map(
	(id) => {
		const migration = declared.get(id);
		if (!migration) throw new Error(`migration_not_declared:${id}`);
		return migration;
	},
);

if (declared.size !== REGISTRATION_ORDER.length)
	throw new Error("migration_not_registered");
