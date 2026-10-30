import { expect, test } from "bun:test";
import * as bunModule from "bun";
import * as dgram from "node:dgram";
import * as http from "node:http";
import { get as httpGet, request as httpRequest } from "node:http";
import * as http2 from "node:http2";
import * as https from "node:https";
import * as net from "node:net";
import { connect as netConnect } from "node:net";
import * as tls from "node:tls";
import { connect as tlsConnect } from "node:tls";

test("fetch is blocked", () => {
	expect(() => fetch("http://127.0.0.1:1/")).toThrow(
		"network_disabled_in_tests",
	);
	expect(() => globalThis.fetch("https://example.com")).toThrow(
		"network_disabled_in_tests",
	);
});

test("Bun's server, socket and UDP entry points are blocked", () => {
	expect(() => Bun.serve({ port: 0, fetch: () => new Response("x") })).toThrow(
		"serve_disabled_in_tests",
	);
	expect(() => Bun.listen({} as never)).toThrow("listen_disabled_in_tests");
	expect(() => Bun.connect({} as never)).toThrow("connect_disabled_in_tests");
	expect(() => Bun.udpSocket({} as never)).toThrow("udp_disabled_in_tests");
	// `import { ... } from "bun"` sees the same replacements.
	expect(() => bunModule.serve({} as never)).toThrow("serve_disabled_in_tests");
});

test("WebSocket is blocked", () => {
	expect(() => new WebSocket("ws://127.0.0.1:1/")).toThrow(
		"websocket_disabled_in_tests",
	);
});

test("node:http and node:https cannot request or listen", () => {
	for (const module of [http, https]) {
		const name = module === http ? "http" : "https";
		expect(() => module.request("http://127.0.0.1:1/")).toThrow(
			`${name}_request_disabled_in_tests`,
		);
		expect(() => module.get("http://127.0.0.1:1/")).toThrow(
			`${name}_get_disabled_in_tests`,
		);
		expect(() => (module.createServer as () => unknown)()).toThrow(
			`${name}_createServer_disabled_in_tests`,
		);
	}
	// Named imports and the default export are the same replacement.
	expect(() => httpRequest("http://127.0.0.1:1/")).toThrow(
		"http_request_disabled_in_tests",
	);
	expect(() => httpGet("http://127.0.0.1:1/")).toThrow(
		"http_get_disabled_in_tests",
	);
});

test("node:net, node:tls, node:dgram and node:http2 cannot connect or listen", () => {
	expect(() => net.connect(1, "127.0.0.1")).toThrow(
		"net_connect_disabled_in_tests",
	);
	expect(() => netConnect(1, "127.0.0.1")).toThrow(
		"net_connect_disabled_in_tests",
	);
	expect(() => net.createConnection(1, "127.0.0.1")).toThrow(
		"net_createConnection_disabled_in_tests",
	);
	expect(() => net.createServer()).toThrow(
		"net_createServer_disabled_in_tests",
	);
	expect(() => tls.connect(1, "127.0.0.1")).toThrow(
		"tls_connect_disabled_in_tests",
	);
	expect(() => tlsConnect(1, "127.0.0.1")).toThrow(
		"tls_connect_disabled_in_tests",
	);
	expect(() => dgram.createSocket("udp4")).toThrow(
		"dgram_createSocket_disabled_in_tests",
	);
	expect(() => http2.connect("http://127.0.0.1:1")).toThrow(
		"http2_connect_disabled_in_tests",
	);
	expect(() => http2.createServer()).toThrow(
		"http2_createServer_disabled_in_tests",
	);
});

test("this product's environment variables are cleared", () => {
	const leaked = Object.keys(process.env).filter(
		(name) => name.startsWith("CONTEXT_STILL_") || name.startsWith("LARM_"),
	);
	expect(leaked).toEqual([]);
});
