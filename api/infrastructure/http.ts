import type { Context } from "hono";
import { z } from "zod";

export type ParseJsonBodyOptions = {
	/** Error code of the 400 response. Defaults to `invalid_input`. */
	code?: string;
	/** Value validated in place of a body that is empty (not malformed). */
	emptyAs?: unknown;
};

export type ParseQueryOptions = {
	/** Error code of the 400 response. Defaults to `invalid_input`. */
	code?: string;
};

export type ParsedInput<T> =
	| { ok: true; data: T }
	| { ok: false; response: Response };

/**
 * Reads the request body as JSON and validates it. A body that is not JSON, or that the schema
 * rejects, yields the ready-made 400 response so every controller answers the same way.
 */
export async function parseJsonBody<T>(
	c: Context,
	schema: z.ZodType<T>,
	options: ParseJsonBodyOptions = {},
): Promise<ParsedInput<T>> {
	let raw: unknown = null;
	try {
		const text = await c.req.text();
		raw =
			"emptyAs" in options && text.trim() === ""
				? options.emptyAs
				: JSON.parse(text);
	} catch {
		// Unreadable or malformed body: validated as null, so the schema rejects it.
		raw = null;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		return {
			ok: false,
			response: c.json({ error: options.code ?? "invalid_input" }, 400),
		};
	return { ok: true, data: parsed.data };
}

/**
 * Validates the query string against a schema; a rejected query yields the ready-made 400
 * response. An absent parameter reaches the schema as undefined, so its default applies. Unknown
 * parameters are the schema's concern (a plain object ignores them, a strict one rejects them).
 */
export function parseQuery<T>(
	c: Context,
	schema: z.ZodType<T>,
	options: ParseQueryOptions = {},
): ParsedInput<T> {
	const parsed = schema.safeParse(c.req.query());
	if (!parsed.success)
		return {
			ok: false,
			response: c.json({ error: options.code ?? "invalid_input" }, 400),
		};
	return { ok: true, data: parsed.data };
}

/**
 * A non-negative decimal integer query value. Text that is empty or not a plain number is
 * rejected, never read as 0 or NaN; bounds are added with `.pipe(z.number().min(..).max(..))`.
 */
export const queryInt = z
	.string()
	.regex(/^\d{1,15}$/)
	.transform(Number);

/** HTTP statuses a thrown error code may map to; each domain declares its own in `contracts`. */
export type HttpErrorStatus =
	| 400
	| 401
	| 403
	| 404
	| 409
	| 410
	| 411
	| 413
	| 415
	| 422
	| 429
	| 501
	| 502
	| 503;
