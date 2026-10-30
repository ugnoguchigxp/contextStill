import { createRequire } from "node:module";

/**
 * Loaded before every test file (bunfig.toml). Tests must never reach a real service:
 * the environment is cleared of this product's variables, and every way to open a network
 * connection or a listening socket throws. Network-like work goes through a fetch injected
 * as a dependency.
 */
for (const name of Object.keys(process.env))
	if (name.startsWith("CONTEXT_STILL_") || name.startsWith("LARM_"))
		delete process.env[name];

const blocked = (what: string) => () => {
	throw new Error(`${what}_disabled_in_tests`);
};

/** Replaces `target[key]` with a throwing function; false when the property cannot be replaced. */
function block(target: object, key: string, label: string): boolean {
	try {
		Object.defineProperty(target, key, {
			value: blocked(label),
			writable: true,
			configurable: true,
			enumerable: true,
		});
		return (target as Record<string, unknown>)[key] !== undefined;
	} catch {
		return false;
	}
}

globalThis.fetch = (() => {
	throw new Error("network_disabled_in_tests");
}) as unknown as typeof fetch;

// Bun.fetch is neither writable nor configurable (and `globalThis.Bun` is read-only), so the
// runtime offers no way to replace it; product code must not call it. The other entry points
// are plain writable properties, and `import { serve } from "bun"` sees the replacement.
const bun = Bun as unknown as Record<string, unknown>;
for (const [key, label] of [
	["serve", "serve"],
	["listen", "listen"],
	["connect", "connect"],
	["udpSocket", "udp"],
] as const)
	bun[key] = blocked(label);

/** A constructor that throws, so `new WebSocket(...)` is refused. */
(globalThis as unknown as { WebSocket: unknown }).WebSocket = function () {
	throw new Error("websocket_disabled_in_tests");
};

// Both the CommonJS object and the ES module's default export are patched; named imports
// (`import { request } from "node:http"`) are checked by scripts/test-preload.test.ts.
const require = createRequire(import.meta.url);
const modules: Record<string, string[]> = {
	"node:http": ["request", "get", "createServer"],
	"node:https": ["request", "get", "createServer"],
	"node:net": ["connect", "createConnection", "createServer"],
	"node:tls": ["connect"],
	"node:dgram": ["createSocket"],
	"node:http2": ["connect", "createServer", "createSecureServer"],
};
for (const [name, keys] of Object.entries(modules)) {
	const module = require(name) as object;
	for (const key of keys) block(module, key, `${name.slice(5)}_${key}`);
}
