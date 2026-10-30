import type { Migration } from "../infrastructure/sqlite";
import { migrations as experience } from "../domains/experience";
import { migrations as knowledge } from "../domains/knowledge";
import { migrations as legacy } from "../domains/legacy";
import { migrations as queue } from "../domains/queue";
import { migrations as settings } from "../domains/settings";
import { migrations as sources } from "../domains/sources";
import { migrations as usage } from "../domains/usage";
import { migrations as vectors } from "../domains/vectors";

/**
 * Every migration of the product, in the registration order the golden test pins. A migration
 * is never edited or reordered after it is deployed; new ones are appended with their `after`.
 */
export const allMigrations: readonly Migration[] = [
	...settings,
	...queue,
	...sources,
	...experience,
	...knowledge,
	...vectors,
	...usage,
	...legacy,
];
