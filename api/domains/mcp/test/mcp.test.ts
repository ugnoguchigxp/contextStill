import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeHandle } from "../../../infrastructure/handle";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	migrations as experienceMigrations,
	upsertEpisode,
	type EpisodeInput,
} from "../../experience";
import {
	migrations as knowledgeMigrations,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
	type EvidenceInput,
	type KnowledgeInput,
} from "../../knowledge";
import {
	SearchError,
	type SearchHit,
	type SearchRequest,
	type SearchResponse,
	type SearchService,
} from "../../search";
import {
	migrations as sourcesMigrations,
	upsertSourceFragment,
	upsertSourceRecord,
	type SourceRecordInput,
} from "../../sources";
import { MCP_PROTOCOL_VERSION, MCP_VERSION, registerMcp } from "../index";
import {
	cutChars,
	publicUrl,
	resolveKnowledgeEvidence,
} from "../service/evidence";
import {
	BUCKET_CAPACITY,
	MAX_CONCURRENT,
	createLimiter,
} from "../service/limits";

const TOKEN = "t".repeat(32);
const HOST = "127.0.0.1:39181";
const T = "2026-10-01T00:00:00.000Z";

// Strings that must never appear in a response body.
const SECRETS = [
	"k-secret-id",
	"e-secret-id",
	"s-secret-doc",
	"s-secret-log",
	"s-secret-web",
	"s-secret-repo",
	"f-secret-frag",
	"file:///Users/secret/",
	"agent-log://secret",
	"repo-secret-key",
	"metadata-secret",
	"AGENT-LOG-SECRET-BODY",
	"REPO-SOURCE-SECRET-BODY",
];

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});

const knowledge = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
	id: "k-secret-id",
	layer: "atom",
	type: "procedure",
	polarity: "positive",
	title: "書き込み前に確認する",
	body: "データベースへの書き込みの前に必ずバックアップを取る",
	appliesWhen: ["migration"],
	notAppliesWhen: [],
	steps: ["backup", "migrate"],
	facets: {},
	confidence: 0.8,
	importance: 0.7,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	validFrom: null,
	validUntil: null,
	provenanceStatus: "resolved",
	metadata: { note: "metadata-secret" },
	createdAt: T,
	updatedAt: T,
	...over,
});
const episode = (over: Partial<EpisodeInput> = {}): EpisodeInput => ({
	id: "e-secret-id",
	title: "移行で失敗した",
	situation: "本番移行の前日",
	intent: "安全に移行する",
	decision: "段階的に行う",
	observations: "遅延が出た",
	action: "ロールバックした",
	outcome: "復旧した",
	lesson: "事前にバックアップを確認する",
	openQuestions: ["原因は何か"],
	outcomeKind: "mixed",
	eventStart: T,
	eventEnd: null,
	timePrecision: "day",
	confidence: 0.6,
	importance: 0.5,
	status: "active",
	space: "eumenes",
	scope: "global",
	repoKey: null,
	facets: {},
	metadata: { note: "metadata-secret" },
	createdAt: T,
	updatedAt: T,
	...over,
});
const source = (over: Partial<SourceRecordInput>): SourceRecordInput => ({
	id: "s-secret-doc",
	kind: "document",
	uri: "file:///Users/secret/doc.md",
	title: "設計メモ",
	content: "設計メモの本文。".repeat(10),
	space: "coding",
	scope: "global",
	repoKey: null,
	recordedAt: T,
	metadata: { note: "metadata-secret" },
	createdAt: T,
	updatedAt: T,
	...over,
});
const ev = (
	targetKind: EvidenceInput["targetKind"],
	targetId: string | null,
) => ({
	targetKind,
	targetId,
	externalRef: targetKind === "external" ? "ext://x" : null,
	role: "derived_from" as const,
	quote: null,
	confidence: null,
});

type SearchCall = SearchRequest;
function fakeSearch(
	hits: SearchHit[] = [],
	over: Partial<SearchResponse> = {},
) {
	const calls: SearchCall[] = [];
	const service: SearchService = {
		async search(req) {
			calls.push(req);
			return {
				hits,
				degraded: [],
				lanesUsed: ["fts"],
				candidateCounts: { fts: 0, short: 0, vector: 0 },
				...over,
			};
		},
	};
	return { service, calls };
}

function hit(over: Partial<SearchHit> = {}): SearchHit {
	return {
		kind: "knowledge",
		id: "k-secret-id",
		handle: makeHandle("knowledge", "k-secret-id"),
		title: "書き込み前に確認する",
		summary: "データベースへの書き込みの前に必ずバックアップを取る",
		type: "procedure",
		polarity: "positive",
		status: "active",
		space: "coding",
		confidence: 0.8,
		score: 0.0246,
		lanes: [{ lane: "fts", rank: 1, raw: -3 }],
		...over,
	};
}

async function setup(
	opts: { search?: SearchService; now?: () => number; seed?: boolean } = {},
) {
	const t = tempStore([
		...sourcesMigrations,
		...knowledgeMigrations,
		...experienceMigrations,
	]);
	disposers.push(t.dispose);
	if (opts.seed !== false)
		await t.store.write((db) => {
			upsertSourceRecord(db, source({}));
			upsertSourceFragment(db, {
				id: "f-secret-frag",
				sourceId: "s-secret-doc",
				locator: "#1",
				byteStart: null,
				byteEnd: null,
				heading: null,
				content: "断片の本文",
				createdAt: T,
			});
			upsertSourceRecord(
				db,
				source({
					id: "s-secret-log",
					kind: "agent_log",
					uri: "agent-log://secret",
					title: "log",
					content: "AGENT-LOG-SECRET-BODY",
				}),
			);
			upsertSourceRecord(
				db,
				source({
					id: "s-secret-web",
					kind: "web",
					uri: "https://example.com/page",
					title: "Web page",
					content: "web content",
				}),
			);
			upsertSourceRecord(
				db,
				source({
					id: "s-secret-repo",
					kind: "document",
					uri: "file:///Users/secret/repo.md",
					title: "repo doc",
					content: "REPO-SOURCE-SECRET-BODY",
					scope: "repo",
					repoKey: "repo-secret-key",
				}),
			);
			upsertKnowledgeItem(db, knowledge());
			replaceKnowledgeEvidence(
				db,
				"k-secret-id",
				"pipeline",
				[
					ev("fragment", "f-secret-frag"),
					ev("source", "s-secret-log"),
					ev("source", "s-secret-web"),
					ev("source", "s-secret-repo"),
					ev("external", null),
				],
				T,
			);
			upsertKnowledgeItem(
				db,
				knowledge({ id: "k-retracted-id", status: "retracted" }),
			);
			upsertKnowledgeItem(
				db,
				knowledge({
					id: "k-repo-id",
					scope: "repo",
					repoKey: "repo-secret-key",
				}),
			);
			upsertEpisode(db, episode());
		});
	const search = opts.search ?? fakeSearch().service;
	const app = new Hono();
	registerMcp(app, {
		path: "/mcp",
		token: TOKEN,
		allowedHosts: [HOST, "localhost:39181", "[::1]:39181"],
		search,
		store: t.store,
		...(opts.now ? { now: opts.now } : {}),
	});
	return { app, store: t.store };
}

const auth = { host: HOST, authorization: `Bearer ${TOKEN}` };
const bodies: string[] = [];

async function post(
	app: Hono,
	body: unknown,
	headers: Record<string, string> = auth,
) {
	const res = await app.request("/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await res.text();
	bodies.push(text);
	return { res, text, json: text ? (JSON.parse(text) as any) : null };
}
const call = (name: string, args: unknown, id = 1) => ({
	jsonrpc: "2.0",
	id,
	method: "tools/call",
	params: { name, arguments: args },
});
async function tool(app: Hono, name: string, args: unknown) {
	const { res, text, json } = await post(app, call(name, args));
	const content = json.result.content;
	expect(content).toHaveLength(1);
	expect(content[0].type).toBe("text");
	return {
		res,
		bytes: new TextEncoder().encode(text).byteLength,
		isError: json.result.isError as boolean | undefined,
		payload: JSON.parse(content[0].text) as any,
	};
}

afterEach(() => {
	for (const text of bodies.splice(0))
		for (const secret of SECRETS) expect(text).not.toContain(secret);
});

test("initialize, ping, notifications and tools/list follow the contract", async () => {
	const { app } = await setup();
	const init = await post(app, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {},
	});
	expect(init.res.status).toBe(200);
	expect(init.res.headers.get("content-type")).toContain("application/json");
	expect(init.json.result).toEqual({
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: { tools: {} },
		serverInfo: { name: "context-still", version: MCP_VERSION },
	});
	expect(MCP_PROTOCOL_VERSION).toBe("2025-03-26");

	const ping = await post(app, { jsonrpc: "2.0", id: "p", method: "ping" });
	expect(ping.json).toEqual({ jsonrpc: "2.0", id: "p", result: {} });

	const note = await post(app, {
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	expect(note.res.status).toBe(202);
	expect(note.text).toBe("");

	const list = await post(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
	const tools = list.json.result.tools;
	expect(tools.map((t: any) => t.name)).toEqual([
		"search_knowledge",
		"get_knowledge",
	]);
	const search = tools[0].inputSchema;
	expect(search.additionalProperties).toBe(false);
	expect(search.required).toEqual(["query"]);
	expect(search.properties.spaces.default).toEqual(["general", "eumenes"]);
	expect(search.properties.spaces.items.enum).toEqual([
		"coding",
		"general",
		"eumenes",
	]);
	expect(search.properties.kinds.default).toEqual(["knowledge"]);
	expect(search.properties.limit).toEqual({
		type: "integer",
		minimum: 1,
		maximum: 20,
		default: 8,
	});
	expect(search.properties.depth).toEqual({
		type: "integer",
		minimum: 0,
		maximum: 2,
		default: 0,
	});
	expect(search.properties.query).toEqual({
		type: "string",
		minLength: 1,
		maxLength: 512,
	});
	expect(tools[1].inputSchema.properties.handle.pattern).toBe(
		"^(kn|ep)_[a-z2-7]{26}$",
	);
	expect(tools[1].inputSchema.required).toEqual(["handle"]);
});

test("unknown methods answer -32601; malformed messages are rejected", async () => {
	const { app } = await setup();
	const unknown = await post(app, {
		jsonrpc: "2.0",
		id: 3,
		method: "resources/list",
	});
	expect(unknown.json.error.code).toBe(-32601);
	expect(unknown.json.id).toBe(3);

	const parse = await post(app, "{not json");
	expect(parse.res.status).toBe(400);
	expect(parse.json.error.code).toBe(-32700);

	const batch = await post(app, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
	expect(batch.res.status).toBe(400);
	expect(batch.json.error.code).toBe(-32600);

	const badTool = await post(app, call("nope", {}));
	expect(badTool.json.error.code).toBe(-32602);
});

test("GET, DELETE and other methods are 405", async () => {
	const { app } = await setup();
	for (const method of ["GET", "DELETE", "PUT"]) {
		const res = await app.request("/mcp", { method, headers: auth });
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
	}
});

test("authentication: 401 with WWW-Authenticate and no secret", async () => {
	const { app } = await setup();
	const cases: Record<string, string>[] = [
		{ host: HOST },
		{ host: HOST, authorization: "Bearer wrong" },
		{ host: HOST, authorization: `Basic ${TOKEN}` },
		{ host: HOST, authorization: `Bearer ${TOKEN}x` },
	];
	for (const headers of cases) {
		const r = await post(
			app,
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			headers,
		);
		expect(r.res.status).toBe(401);
		expect(r.res.headers.get("www-authenticate")).toBe("Bearer");
		expect(r.text).not.toContain(TOKEN);
	}
	const get = await app.request("/mcp", {
		method: "GET",
		headers: { host: HOST },
	});
	expect(get.status).toBe(401);
});

test("Host and Origin checks come first", async () => {
	const { app } = await setup();
	const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
	for (const host of ["evil.example:39181", "127.0.0.1:1", ""]) {
		const headers: Record<string, string> = {
			authorization: `Bearer ${TOKEN}`,
		};
		if (host) headers.host = host;
		expect((await post(app, ping, headers)).res.status).toBe(403);
	}
	// Wrong host wins over a wrong token.
	expect(
		(await post(app, ping, { host: "evil.example", authorization: "Bearer x" }))
			.res.status,
	).toBe(403);
	for (const origin of [
		"https://evil.example",
		"null",
		"http://127.0.0.1.evil.example",
		"garbage",
	])
		expect((await post(app, ping, { ...auth, origin })).res.status).toBe(403);
	for (const origin of [
		"http://127.0.0.1:5173",
		"http://localhost",
		"http://[::1]:39181",
	])
		expect((await post(app, ping, { ...auth, origin })).res.status).toBe(200);
	expect(
		(await post(app, ping, { ...auth, host: "LOCALHOST:39181" })).res.status,
	).toBe(200);
});

test("bodies over 32 KiB are 413, by header and by actual size", async () => {
	const { app } = await setup();
	const big = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "ping",
		params: { pad: "x".repeat(33 * 1024) },
	});
	expect((await post(app, big)).res.status).toBe(413);
	const declared = await app.request("/mcp", {
		method: "POST",
		headers: { ...auth, "content-length": "40000" },
		body: "{}",
	});
	expect(declared.status).toBe(413);
	// A chunked body without Content-Length is cut off while reading.
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("x".repeat(20 * 1024)));
			controller.enqueue(new TextEncoder().encode("x".repeat(20 * 1024)));
			controller.close();
		},
	});
	const chunked = await app.request("/mcp", {
		method: "POST",
		headers: auth,
		body: stream,
		duplex: "half",
	} as RequestInit);
	expect(chunked.status).toBe(413);
	// Exactly 32 KiB passes the size check.
	const pad =
		32 * 1024 -
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "ping",
			params: { pad: "" },
		}).length;
	const edge = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "ping",
		params: { pad: "x".repeat(pad) },
	});
	expect(edge.length).toBe(32 * 1024);
	expect((await post(app, edge)).res.status).toBe(200);
});

test("token bucket: burst 10 then 429, refilling 1 per second", async () => {
	let now = 1_000_000;
	const { app } = await setup({ now: () => now });
	const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
	for (let i = 0; i < 10; i++)
		expect((await post(app, ping)).res.status).toBe(200);
	const limited = await post(app, ping);
	expect(limited.res.status).toBe(429);
	expect(limited.res.headers.get("retry-after")).toBe("1");
	// Unauthenticated requests do not spend tokens.
	expect((await post(app, ping, { host: HOST })).res.status).toBe(401);
	now += 1000;
	expect((await post(app, ping)).res.status).toBe(200);
	expect((await post(app, ping)).res.status).toBe(429);
	now += 60_000;
	for (let i = 0; i < 10; i++)
		expect((await post(app, ping)).res.status).toBe(200);
	expect((await post(app, ping)).res.status).toBe(429);
});

test("concurrency: the fifth in-flight call is 429", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let started = 0;
	const search: SearchService = {
		async search() {
			started += 1;
			await gate;
			return {
				hits: [],
				degraded: [],
				lanesUsed: [],
				candidateCounts: { fts: 0, short: 0, vector: 0 },
			};
		},
	};
	const { app } = await setup({ search });
	const pending = [1, 2, 3, 4].map((id) =>
		app.request("/mcp", {
			method: "POST",
			headers: auth,
			body: JSON.stringify(call("search_knowledge", { query: "q" }, id)),
		}),
	);
	for (let i = 0; i < 200 && started < 4; i++) await Bun.sleep(5);
	expect(started).toBe(4);
	const fifth = await post(app, { jsonrpc: "2.0", id: 9, method: "ping" });
	expect(fifth.res.status).toBe(429);
	release();
	for (const res of await Promise.all(pending)) expect(res.status).toBe(200);
	expect(
		(await post(app, { jsonrpc: "2.0", id: 10, method: "ping" })).res.status,
	).toBe(200);
});

test("search_knowledge: defaults, mapping, and degraded additions", async () => {
	const fake = fakeSearch([hit()], { degraded: ["vector_unavailable"] });
	const { app } = await setup({ search: fake.service });
	const r = await tool(app, "search_knowledge", { query: "  バックアップ  " });
	expect(r.isError).toBeUndefined();
	expect(fake.calls[0]).toMatchObject({
		query: "バックアップ",
		kinds: ["knowledge"],
		spaces: ["general", "eumenes"],
		limit: 8,
	});
	expect(fake.calls[0]!.repoKey).toBeUndefined();
	expect(r.payload.contractVersion).toBe("contextstill-search.v1");
	expect(r.payload.trust).toEqual({
		trustClass: "untrusted_knowledge_evidence",
		instructionAuthority: "none",
	});
	expect(r.payload.warnings).toEqual([]);
	expect(r.payload.truncated).toBe(false);
	expect(r.payload.degraded).toEqual(["vector_unavailable"]);
	const result = r.payload.results[0];
	expect(Object.keys(result).sort()).toEqual(
		[
			"confidence",
			"evidenceSummary",
			"handle",
			"kind",
			"polarity",
			"route",
			"score",
			"space",
			"status",
			"summary",
			"themes",
			"title",
			"type",
		].sort(),
	);
	expect(result.handle).toBe(makeHandle("knowledge", "k-secret-id"));
	expect(result.themes).toEqual([]);
	expect(result.route).toEqual([{ via: "seed", lane: "fts", rank: 1 }]);
	// fragment + agent_log + web + repo document + external; the repo source still counts as a kind.
	expect(result.evidenceSummary).toEqual({
		count: 5,
		sourceKinds: ["agent_log", "document", "external", "web"],
	});

	const withExpansion = await tool(app, "search_knowledge", {
		query: "q",
		depth: 2,
		theme: "db",
	});
	expect(withExpansion.payload.degraded).toEqual([
		"vector_unavailable",
		"expansion_unavailable",
		"theme_unavailable",
	]);
	const plain = await tool(app, "search_knowledge", { query: "q", depth: 0 });
	expect(plain.payload.degraded).toEqual(["vector_unavailable"]);
});

test("search_knowledge passes explicit filters and episode hits get a summary", async () => {
	const ep = hit({
		kind: "episode",
		id: "e-secret-id",
		handle: makeHandle("episode", "e-secret-id"),
		type: null,
		polarity: null,
		space: "eumenes",
	});
	const fake = fakeSearch([ep]);
	const { app } = await setup({ search: fake.service });
	const r = await tool(app, "search_knowledge", {
		query: "q",
		kinds: ["knowledge", "episode"],
		types: ["rule"],
		spaces: ["coding"],
		limit: 20,
	});
	expect(fake.calls[0]).toMatchObject({
		kinds: ["knowledge", "episode"],
		types: ["rule"],
		spaces: ["coding"],
		limit: 20,
	});
	expect(r.payload.results[0].kind).toBe("episode");
	expect(r.payload.results[0].type).toBeNull();
});

test("invalid arguments are rejected as tool errors", async () => {
	const fake = fakeSearch();
	let clock = 0;
	const { app } = await setup({
		search: fake.service,
		now: () => (clock += 2000),
	});
	const bad: unknown[] = [
		{},
		{ query: "" },
		{ query: "x".repeat(513) },
		{ query: "q", extra: 1 },
		{ query: "q", spaces: ["personal"] },
		{ query: "q", spaces: [] },
		{ query: "q", spaces: ["coding", "coding"] },
		{ query: "q", kinds: ["document"] },
		{ query: "q", kinds: [] },
		{ query: "q", types: ["rule", "rule"] },
		{ query: "q", limit: 0 },
		{ query: "q", limit: 21 },
		{ query: "q", limit: 1.5 },
		{ query: "q", depth: 3 },
		{ query: "q", depth: -1 },
		{ query: "q", theme: "x".repeat(129) },
		{ query: 5 },
	];
	for (const args of bad) {
		const r = await tool(app, "search_knowledge", args);
		expect(r.isError).toBe(true);
		expect(r.payload).toEqual({ error: "invalid_arguments" });
	}
	expect(fake.calls).toHaveLength(0);
	for (const args of [
		{},
		{ handle: "kn_short" },
		{ handle: makeHandle("knowledge", "x").toUpperCase() },
		{ handle: makeHandle("knowledge", "x"), extra: 1 },
	]) {
		const r = await tool(app, "get_knowledge", args);
		expect(r.payload).toEqual({ error: "invalid_arguments" });
	}
});

test("a SearchError becomes a tool error and other failures stay internal", async () => {
	const failing = (error: Error): SearchService => ({
		async search() {
			throw error;
		},
	});
	let { app } = await setup({
		search: failing(new SearchError("invalid_query")),
	});
	let r = await tool(app, "search_knowledge", { query: "   " });
	expect(r.isError).toBe(true);
	expect(r.payload).toEqual({ error: "invalid_query" });
	({ app } = await setup({ search: failing(new Error("secret-db-detail")) }));
	r = await tool(app, "search_knowledge", { query: "q" });
	expect(r.isError).toBe(true);
	expect(r.payload).toEqual({ error: "internal_error" });
});

test("search responses stay within 32 KiB and report truncated", async () => {
	const hits = Array.from({ length: 20 }, (_, i) =>
		hit({
			title: `長いタイトル${i}`.padEnd(1500, "あ"),
			summary: "い".repeat(280),
		}),
	);
	const { app } = await setup({ search: fakeSearch(hits).service });
	const r = await tool(app, "search_knowledge", { query: "q", limit: 20 });
	expect(r.bytes).toBeLessThanOrEqual(32 * 1024);
	expect(r.payload.truncated).toBe(true);
	expect(r.payload.results.length).toBeGreaterThan(0);
	expect(r.payload.results.length).toBeLessThan(20);
	expect(r.payload.results[0].title).toContain("長いタイトル0");

	const small = await setup({ search: fakeSearch([hit(), hit()]).service });
	const s = await tool(small.app, "search_knowledge", { query: "q" });
	expect(s.payload.truncated).toBe(false);
	expect(s.payload.results).toHaveLength(2);
});

test("get_knowledge returns a knowledge item with safe evidence", async () => {
	const { app } = await setup();
	const r = await tool(app, "get_knowledge", {
		handle: makeHandle("knowledge", "k-secret-id"),
	});
	expect(r.isError).toBeUndefined();
	expect(r.payload.contractVersion).toBe("contextstill-knowledge.v1");
	expect(r.payload.trust.instructionAuthority).toBe("none");
	const item = r.payload.item;
	expect(item).toMatchObject({
		kind: "knowledge",
		layer: "atom",
		type: "procedure",
		polarity: "positive",
		title: "書き込み前に確認する",
		appliesWhen: ["migration"],
		steps: ["backup", "migrate"],
		status: "active",
		space: "coding",
		supersededBy: null,
		evidenceTruncated: false,
	});
	expect(Object.keys(item)).not.toContain("id");
	expect(item.evidence).toHaveLength(5);
	const byKind = (kind: string) =>
		item.evidence.filter((e: any) => e.sourceKind === kind);
	// document via fragment: the fragment text, no URL (file URI)
	expect(
		byKind("document")
			.map((e: any) => e)
			.find((e: any) => e.excerpt === "断片の本文"),
	).toEqual({
		role: "derived_from",
		sourceKind: "document",
		title: "設計メモ",
		url: null,
		excerpt: "断片の本文",
	});
	// repo-scope document: role and kind only
	expect(byKind("document").filter((e: any) => "excerpt" in e)).toHaveLength(1);
	expect(byKind("web")[0]).toEqual({
		role: "derived_from",
		sourceKind: "web",
		title: "Web page",
		url: "https://example.com/page",
		excerpt: "web content",
	});
	expect(byKind("agent_log")).toEqual([
		{ role: "derived_from", sourceKind: "agent_log" },
	]);
	expect(byKind("external")).toEqual([
		{ role: "derived_from", sourceKind: "external" },
	]);
});

test("get_knowledge returns an episode", async () => {
	const { app, store } = await setup();
	await store.write((db) => {
		// Episode evidence: a document source and a conversation log.
		db.query(
			"INSERT INTO episode_sources (episode_id, source_id, locator, role) VALUES (?, ?, '', 'derived_from')",
		).run("e-secret-id", "s-secret-doc");
		db.query(
			"INSERT INTO episode_sources (episode_id, source_id, locator, role) VALUES (?, ?, '', 'supports')",
		).run("e-secret-id", "s-secret-log");
	});
	const r = await tool(app, "get_knowledge", {
		handle: makeHandle("episode", "e-secret-id"),
	});
	expect(r.isError).toBeUndefined();
	const item = r.payload.item;
	expect(item).toMatchObject({
		kind: "episode",
		title: "移行で失敗した",
		lesson: "事前にバックアップを確認する",
		outcomeKind: "mixed",
		openQuestions: ["原因は何か"],
		timePrecision: "day",
		space: "eumenes",
		status: "active",
	});
	expect(item.evidence).toHaveLength(2);
	const log = item.evidence.find((e: any) => e.sourceKind === "agent_log");
	expect(log).toEqual({ role: "supports", sourceKind: "agent_log" });
	const doc = item.evidence.find((e: any) => e.sourceKind === "document");
	expect(doc.excerpt.startsWith("設計メモの本文。")).toBe(true);
	expect(doc.url).toBeNull();
});

test("get_knowledge answers not_found for missing, retracted, repo-scope and personal rows", async () => {
	const { app, store } = await setup();
	await store.write((db) => {
		upsertKnowledgeItem(
			db,
			knowledge({ id: "k-personal-id", space: "personal" }),
		);
		upsertEpisode(db, episode({ id: "e-retracted-id", status: "retracted" }));
		upsertEpisode(
			db,
			episode({ id: "e-repo-id", scope: "repo", repoKey: "repo-secret-key" }),
		);
	});
	const handles = [
		makeHandle("knowledge", "k-missing"),
		makeHandle("episode", "e-missing"),
		makeHandle("knowledge", "k-retracted-id"),
		makeHandle("knowledge", "k-repo-id"),
		makeHandle("knowledge", "k-personal-id"),
		makeHandle("episode", "e-retracted-id"),
		makeHandle("episode", "e-repo-id"),
	];
	for (const handle of handles) {
		const r = await tool(app, "get_knowledge", { handle });
		expect(r.isError).toBe(true);
		expect(r.payload).toEqual({ error: "not_found" });
	}
	// stale episodes and superseded knowledge are still readable
	await store.write((db) => {
		upsertEpisode(db, episode({ id: "e-stale-id", status: "stale" }));
		upsertKnowledgeItem(
			db,
			knowledge({ id: "k-old-id", status: "superseded" }),
		);
	});
	expect(
		(
			await tool(app, "get_knowledge", {
				handle: makeHandle("episode", "e-stale-id"),
			})
		).payload.item.status,
	).toBe("stale");
	expect(
		(
			await tool(app, "get_knowledge", {
				handle: makeHandle("knowledge", "k-old-id"),
			})
		).payload.item.status,
	).toBe("superseded");
});

test("get_knowledge responses are cut to fit 32 KiB", async () => {
	const { app, store } = await setup();
	await store.write((db) => {
		for (let i = 0; i < 12; i++)
			upsertSourceRecord(
				db,
				source({
					id: `s-big-${i}`,
					uri: `https://example.com/${i}`,
					content: "あ".repeat(2000),
				}),
			);
		upsertKnowledgeItem(
			db,
			knowledge({ id: "k-big-id", body: "い".repeat(9000) }),
		);
		replaceKnowledgeEvidence(
			db,
			"k-big-id",
			"pipeline",
			Array.from({ length: 12 }, (_, i) => ev("source", `s-big-${i}`)),
			T,
		);
	});
	const r = await tool(app, "get_knowledge", {
		handle: makeHandle("knowledge", "k-big-id"),
	});
	expect(r.bytes).toBeLessThanOrEqual(32 * 1024);
	expect(r.payload.item.evidenceTruncated).toBe(true);
	expect(r.payload.item.evidence.length).toBeLessThanOrEqual(10);
	expect(r.payload.item.body.length).toBeGreaterThan(0);
	expect(r.payload.item.body.length).toBeLessThanOrEqual(8000);
	for (const e of r.payload.item.evidence)
		expect(e.excerpt.length).toBeLessThanOrEqual(600);
});

test("search evidence resolution never reads a source or fragment body", async () => {
	const { store } = await setup();
	await store.write((db) => {
		upsertSourceRecord(
			db,
			source({
				id: "s-huge",
				uri: "https://example.com/huge",
				content: "あ".repeat(500_000),
			}),
		);
	});
	const sqls: string[] = [];
	store.readSnapshot((db) => {
		const spy = new Proxy(db, {
			get(target, prop) {
				if (prop === "query")
					return (sql: string) => {
						sqls.push(sql);
						return target.query(sql);
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const items = resolveKnowledgeEvidence(spy, "k-secret-id");
		expect(items).toHaveLength(5);
		expect(items.some((i) => i.fragmentId === "f-secret-frag")).toBe(true);
		for (const i of items) expect(i.source).not.toHaveProperty("content");
	});
	expect(sqls.length).toBeGreaterThan(0);
	for (const sql of sqls) expect(sql).not.toMatch(/\bcontent\b/);
});

test("search_knowledge works on huge source bodies and returns only counts", async () => {
	const { app, store } = await setup({ search: fakeSearch([hit()]).service });
	await store.write((db) => {
		upsertSourceRecord(
			db,
			source({
				id: "s-huge",
				uri: "https://example.com/huge",
				content: "あ".repeat(500_000),
			}),
		);
		replaceKnowledgeEvidence(
			db,
			"k-secret-id",
			"pipeline",
			[ev("source", "s-huge")],
			T,
		);
	});
	const r = await tool(app, "search_knowledge", { query: "q" });
	expect(r.payload.results[0].evidenceSummary).toEqual({
		count: 1,
		sourceKinds: ["document"],
	});
});

test("get_knowledge reads bodies only for the 10 published evidence items", async () => {
	const { app, store } = await setup();
	await store.write((db) => {
		for (let i = 0; i < 15; i++)
			upsertSourceRecord(
				db,
				source({
					id: `s-many-${i}`,
					uri: `https://example.com/${i}`,
					content: "本文",
				}),
			);
		replaceKnowledgeEvidence(
			db,
			"k-secret-id",
			"pipeline",
			Array.from({ length: 15 }, (_, i) => ev("source", `s-many-${i}`)),
			T,
		);
	});
	const r = await tool(app, "get_knowledge", {
		handle: makeHandle("knowledge", "k-secret-id"),
	});
	expect(r.payload.item.evidence).toHaveLength(10);
	expect(r.payload.item.evidenceTruncated).toBe(true);
});

test("a concurrency refusal does not spend a rate-limit token", () => {
	const limiter = createLimiter();
	const held = Array.from({ length: MAX_CONCURRENT }, () => limiter.acquire(0));
	expect(held.every((h) => h !== null)).toBe(true);
	// Refused for concurrency many times: no tokens are lost.
	for (let i = 0; i < 20; i++) expect(limiter.acquire(0)).toBeNull();
	for (const release of held) release?.();
	// The tokens left are the capacity minus the 4 granted calls.
	let granted = 0;
	while (limiter.acquire(0)) granted += 1;
	// Each acquire above keeps its slot, so at most MAX_CONCURRENT are granted; tokens remain.
	expect(granted).toBe(MAX_CONCURRENT);
	expect(BUCKET_CAPACITY - MAX_CONCURRENT - granted).toBe(2);
});

test("publicUrl keeps only http(s) and strips credentials, query and hash", () => {
	expect(publicUrl("https://user:pw@example.com/a/b?token=1#frag")).toBe(
		"https://example.com/a/b",
	);
	expect(publicUrl("http://example.com:8080/x?y=1")).toBe(
		"http://example.com:8080/x",
	);
	expect(publicUrl("HTTPS://Example.com/p")).toBe("https://example.com/p");
	expect(publicUrl("file:///Users/secret/doc.md")).toBeNull();
	expect(publicUrl("agent-log://secret")).toBeNull();
	expect(publicUrl("ftp://example.com/x")).toBeNull();
	expect(publicUrl("javascript:alert(1)")).toBeNull();
	expect(publicUrl("/Users/secret/doc.md")).toBeNull();
	expect(publicUrl("not a url")).toBeNull();
	expect(publicUrl("https://")).toBeNull();
});

test("an evidence url in a response carries no userinfo, query or hash", async () => {
	const { app, store } = await setup();
	await store.write((db) => {
		upsertSourceRecord(
			db,
			source({
				id: "s-web-cred",
				kind: "web",
				uri: "https://u:p@example.com/doc?token=SECRET-TOKEN#frag",
				title: "t",
				content: "body",
			}),
		);
		replaceKnowledgeEvidence(
			db,
			"k-secret-id",
			"pipeline",
			[ev("source", "s-web-cred")],
			T,
		);
	});
	const r = await tool(app, "get_knowledge", {
		handle: makeHandle("knowledge", "k-secret-id"),
	});
	expect(r.payload.item.evidence[0].url).toBe("https://example.com/doc");
});

test("cutChars cuts at code point boundaries", () => {
	expect(cutChars("abc", 5)).toBe("abc");
	expect(cutChars("abcdef", 3)).toBe("abc");
	expect(cutChars("abc", 0)).toBe("");
	// Astral characters count as one and are never split.
	expect(cutChars("😀😀😀", 2)).toBe("😀😀");
	expect(cutChars("a😀b😀c", 3)).toBe("a😀b");
	expect(cutChars("😀😀", 2)).toBe("😀😀");
	expect(cutChars("😀".repeat(100_000), 600)).toBe("😀".repeat(600));
});
