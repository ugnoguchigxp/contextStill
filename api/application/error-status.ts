import type { HttpErrorStatus } from "../infrastructure/http";
import { errorStatus as larm } from "../domains/larm";
import { errorStatus as search } from "../domains/search";
import { errorStatus as settings } from "../domains/settings";
import { legacyErrorStatus as legacy } from "../domains/legacy";
import { vectorErrorStatus as vectors } from "../domains/vectors";

export type ErrorStatus = HttpErrorStatus | 500 | 501;

/** Codes that belong to no single domain. A domain's own codes live in its contracts. */
const shared = {
	invalid_input: 400,
	unauthorized: 401,
	not_found: 404,
	payload_too_large: 413,
	database_writer_queue_full: 503,
	database_closing: 503,
	not_implemented: 501,
} as const satisfies Record<string, ErrorStatus>;

/**
 * Merges status tables. The same code may appear in several tables only with the same
 * status; a disagreement is a programming error and fails at module load.
 */
export function mergeErrorStatus(
	...tables: Array<Readonly<Record<string, ErrorStatus>>>
): Record<string, ErrorStatus> {
	const merged: Record<string, ErrorStatus> = {};
	for (const table of tables)
		for (const [code, status] of Object.entries(table)) {
			if (merged[code] !== undefined && merged[code] !== status)
				throw new Error(`error_status_conflict:${code}`);
			merged[code] = status;
		}
	return merged;
}

const statusByCode = mergeErrorStatus(
	shared,
	larm,
	search,
	settings,
	legacy,
	vectors,
);

const CODE = /^[a-z][a-z0-9_]*$/;

/** The stable code carried by a thrown value: its `code` field, else a code-shaped message. */
export function errorCodeOf(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code === "string" && statusByCode[code] !== undefined) return code;
	if (typeof message === "string" && statusByCode[message] !== undefined)
		return message;
	return null;
}

/** `{ error, status }` for a response. Anything not in the table is a 500 `internal_error`. */
export function errorResponse(error: unknown): {
	error: string;
	status: ErrorStatus;
} {
	const code = errorCodeOf(error);
	if (code && CODE.test(code))
		return { error: code, status: statusByCode[code]! };
	return { error: "internal_error", status: 500 };
}
