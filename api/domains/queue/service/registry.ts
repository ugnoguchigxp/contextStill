import type { HandlerDefinition } from "../types";

type AnyHandler = HandlerDefinition<unknown, unknown, unknown>;

export function createRegistry() {
	const handlers = new Map<string, AnyHandler>();
	return {
		register<P, I, O>(definition: HandlerDefinition<P, I, O>) {
			if (handlers.has(definition.kind))
				throw new Error(`invalid_duplicate_handler:${definition.kind}`);
			handlers.set(definition.kind, definition as unknown as AnyHandler);
		},
		get: (kind: string) => handlers.get(kind),
	};
}
export type Registry = ReturnType<typeof createRegistry>;

/** Transaction callbacks must be synchronous; a Promise would escape the Writer transaction. */
export function sync<T>(value: T): T {
	if (value instanceof Promise) {
		void value.catch(() => {});
		throw new Error("invalid_async_transaction_callback");
	}
	return value;
}
