import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Minimal JSON-lines logger on stderr. Only short strings and finite numbers
 * are logged as fields; error messages are never logged (they can carry
 * tokens, URLs or SQL parameters), only the frames of the stack.
 */
export type LogFields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

const scope = new AsyncLocalStorage<LogFields>();

export function withLogContext<T>(fields: LogFields, action: () => T): T {
	return scope.run({ ...scope.getStore(), ...fields }, action);
}

function safeFields(fields: LogFields): LogFields {
	return Object.fromEntries(
		Object.entries({ ...scope.getStore(), ...fields }).filter(
			([, value]) =>
				(typeof value === "string" && value.length <= 256) ||
				(typeof value === "number" && Number.isFinite(value)) ||
				typeof value === "boolean",
		),
	);
}

function silent(): boolean {
	return process.env.NODE_ENV === "test";
}

export function getLogger(component: string) {
	function log(
		level: Level,
		event: string,
		fields: LogFields = {},
		error?: unknown,
	) {
		if (silent()) return;
		const frames =
			error instanceof Error
				? error.stack?.split("\n").slice(1, 6).join("\n")
				: undefined;
		const line = JSON.stringify({
			time: new Date().toISOString(),
			level,
			component,
			event,
			...safeFields(fields),
			...(frames ? { frames } : {}),
		});
		process.stderr.write(`${line}\n`);
	}
	return {
		debug: (event: string, fields?: LogFields, error?: unknown) =>
			log("debug", event, fields, error),
		info: (event: string, fields?: LogFields, error?: unknown) =>
			log("info", event, fields, error),
		warn: (event: string, fields?: LogFields, error?: unknown) =>
			log("warn", event, fields, error),
		error: (event: string, fields?: LogFields, error?: unknown) =>
			log("error", event, fields, error),
	};
}
