import { expect, test } from "bun:test";
import {
	EXIT_FAILURE,
	EXIT_OK,
	EXIT_UNREACHABLE,
	EXIT_USAGE,
	runDistillCli,
	type DistillCliDeps,
} from "../cli";

const TOKEN = "api-token-0123456789abcdef0123";

interface Seen {
	method: string;
	url: string;
	authorization: string | null;
	body: unknown;
}

function harness(
	respond: (seen: Seen) => Response | Promise<Response> = () =>
		Response.json({}),
	files: Record<string, string> = {},
) {
	const requests: Seen[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const written: Record<string, string> = {};
	const modes: Record<string, number | undefined> = {};
	const deps: DistillCliDeps = {
		baseUrl: "http://127.0.0.1:39201",
		token: TOKEN,
		fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const seen: Seen = {
				method: init?.method ?? "GET",
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			};
			requests.push(seen);
			return respond(seen);
		}) as typeof fetch,
		readText: async (path) => {
			if (!(path in files)) throw new Error("ENOENT");
			return files[path]!;
		},
		writeText: async (path, text, mode) => {
			written[path] = text;
			modes[path] = mode;
		},
		stdout: (l) => out.push(l),
		stderr: (l) => err.push(l),
	};
	const run = (...argv: string[]) => runDistillCli(argv, deps);
	return { run, requests, out, err, written, modes, deps };
}

test("run STAGE posts the options and prints the answer", async () => {
	const h = harness(() =>
		Response.json({ runId: "run_1", enqueued: 4 }, { status: 202 }),
	);
	expect(
		await h.run(
			"run",
			"canonical",
			"--limit",
			"25",
			"--dry-run",
			"--allow-unverified",
		),
	).toBe(EXIT_OK);
	expect(h.requests).toEqual([
		{
			method: "POST",
			url: "http://127.0.0.1:39201/api/distill/runs",
			authorization: `Bearer ${TOKEN}`,
			body: {
				stage: "canonical",
				limit: 25,
				dryRun: true,
				allowUnverified: true,
			},
		},
	]);
	expect(JSON.parse(h.out.join("\n"))).toEqual({ runId: "run_1", enqueued: 4 });
	// bun passes the `--` of `bun run distill -- run assess` through
	const again = harness(() =>
		Response.json({ runId: "r", enqueued: 0 }, { status: 202 }),
	);
	expect(await again.run("--", "run", "assess")).toBe(EXIT_OK);
	expect(again.requests[0]!.body).toEqual({ stage: "assess", dryRun: false });
});

test("run: a running stage (409) is a failure with the code on stderr", async () => {
	const h = harness(() =>
		Response.json({ error: "distill_stage_running" }, { status: 409 }),
	);
	expect(await h.run("run", "conflict")).toBe(EXIT_FAILURE);
	expect(h.err).toEqual(["distill: distill_stage_running"]);
	expect(h.out).toEqual([]);
});

test("status and status RUN_ID", async () => {
	const h = harness((s) =>
		Response.json(
			s.url.endsWith("/status")
				? { atoms: {} }
				: { id: "run_1", state: "running" },
		),
	);
	expect(await h.run("status")).toBe(EXIT_OK);
	expect(await h.run("status", "run_1")).toBe(EXIT_OK);
	expect(h.requests.map((r) => [r.method, r.url])).toEqual([
		["GET", "http://127.0.0.1:39201/api/distill/status"],
		["GET", "http://127.0.0.1:39201/api/distill/runs/run_1"],
	]);
	expect(JSON.parse(h.out[1]!)).toEqual({ id: "run_1", state: "running" });
});

test("calibration-export writes the sample to the file", async () => {
	const sample = [
		{ pairId: "p1", similarity: 0.95 },
		{ pairId: "p2", similarity: 0.91 },
	];
	const h = harness(() => Response.json(sample));
	expect(await h.run("calibration-export", "/tmp/cal.json", "--n", "50")).toBe(
		EXIT_OK,
	);
	expect(h.requests[0]!.url).toBe(
		"http://127.0.0.1:39201/api/distill/calibration/sample?n=50",
	);
	expect(JSON.parse(h.written["/tmp/cal.json"]!)).toEqual(sample);
	expect(JSON.parse(h.out[0]!)).toEqual({ written: "/tmp/cal.json", pairs: 2 });
	const def = harness(() => Response.json([]));
	await def.run("calibration-export", "x.json");
	expect(def.requests[0]!.url).toContain("n=300");
});

test("calibration-import sends the labels (a list or {labels}) and prints the thresholds", async () => {
	const labels = [{ pairId: "p1", label: "same", labelSource: "owner" }];
	const h = harness(
		() => Response.json({ pairCandidate: 0.9, calibratedAt: "t" }),
		{
			"a.json": JSON.stringify(labels),
			"b.json": JSON.stringify({ labels }),
			"bad.json": "{{",
			"obj.json": JSON.stringify({ nope: 1 }),
		},
	);
	expect(await h.run("calibration-import", "a.json")).toBe(EXIT_OK);
	expect(await h.run("calibration-import", "b.json")).toBe(EXIT_OK);
	expect(h.requests.map((r) => [r.method, r.url, r.body])).toEqual([
		["PUT", "http://127.0.0.1:39201/api/distill/calibration", { labels }],
		["PUT", "http://127.0.0.1:39201/api/distill/calibration", { labels }],
	]);
	for (const file of ["bad.json", "obj.json", "missing.json"])
		expect(await h.run("calibration-import", file)).toBe(EXIT_USAGE);
	expect(h.requests).toHaveLength(2);
	// the server's refusal of a bad label is a failure, not a usage error
	const refuse = harness(
		() => Response.json({ error: "invalid_distill_request" }, { status: 400 }),
		{ "a.json": "[]" },
	);
	expect(await refuse.run("calibration-import", "a.json")).toBe(EXIT_FAILURE);
});

test("reviews lists open ones by default", async () => {
	const h = harness(() => Response.json([{ id: "r1" }]));
	expect(await h.run("reviews")).toBe(EXIT_OK);
	expect(await h.run("reviews", "--state", "dismissed")).toBe(EXIT_OK);
	expect(h.requests.map((r) => r.url)).toEqual([
		"http://127.0.0.1:39201/api/distill/reviews?state=open",
		"http://127.0.0.1:39201/api/distill/reviews?state=dismissed",
	]);
	expect(await h.run("reviews", "--state", "all")).toBe(EXIT_USAGE);
});

test("resolve ID JSON posts the decision; 204 prints the id", async () => {
	const h = harness(() => new Response(null, { status: 204 }));
	expect(
		await h.run(
			"resolve",
			"rv/1",
			'{"kind":"set_generality","generality":"general"}',
		),
	).toBe(EXIT_OK);
	expect(h.requests[0]).toMatchObject({
		method: "POST",
		url: "http://127.0.0.1:39201/api/distill/reviews/rv%2F1/resolve",
		body: { kind: "set_generality", generality: "general" },
	});
	expect(JSON.parse(h.out[0]!)).toEqual({ resolved: "rv/1" });
	for (const bad of ["{oops", "[]", "3"])
		expect(await h.run("resolve", "r1", bad)).toBe(EXIT_USAGE);
	expect(h.requests).toHaveLength(1);
	const nf = harness(() =>
		Response.json({ error: "distill_not_found" }, { status: 404 }),
	);
	expect(await nf.run("resolve", "zz", '{"kind":"dismiss"}')).toBe(
		EXIT_FAILURE,
	);
	expect(nf.err).toEqual(["distill: distill_not_found"]);
});

test("audit exits 0 for a clean report and 1 for violations; both are printed", async () => {
	const clean = harness(() =>
		Response.json({ ok: true, violations: [], checked: {} }),
	);
	expect(await clean.run("audit")).toBe(EXIT_OK);
	const dirty = harness(() =>
		Response.json({
			ok: false,
			violations: [{ code: "unresolved_conflict", subject: ["a", "b"] }],
			checked: {},
		}),
	);
	expect(await dirty.run("audit")).toBe(EXIT_FAILURE);
	expect(JSON.parse(dirty.out[0]!).violations).toHaveLength(1);
});

test("usage errors send nothing and exit 2", async () => {
	const h = harness();
	for (const argv of [
		[],
		["nope"],
		["run"],
		["run", "nostage"],
		["run", "assess", "--limit", "0"],
		["run", "assess", "--limit"],
		["run", "assess", "--bogus"],
		["run", "assess", "extra"],
		["status", "a", "b"],
		["calibration-export"],
		["resolve", "only-id"],
		["audit", "x"],
	])
		expect(await h.run(...argv)).toBe(EXIT_USAGE);
	expect(h.requests).toEqual([]);
	expect(h.err.every((l) => l.startsWith("distill: "))).toBe(true);
});

test("an unreachable backend is exit 4 and says nothing of the address or the token", async () => {
	const h = harness(() => {
		throw new TypeError(`connect ECONNREFUSED http://127.0.0.1:39201 ${TOKEN}`);
	});
	expect(await h.run("status")).toBe(EXIT_UNREACHABLE);
	expect(h.err).toEqual(["distill: backend_unreachable"]);
});

test("401 and a non-JSON error body are failures; the token is never printed", async () => {
	const unauthorized = harness(() =>
		Response.json({ error: "unauthorized" }, { status: 401 }),
	);
	expect(await unauthorized.run("audit")).toBe(EXIT_FAILURE);
	expect(unauthorized.err).toEqual(["distill: unauthorized"]);
	const html = harness(
		() => new Response("<html>boom</html>", { status: 502 }),
	);
	expect(await html.run("status")).toBe(EXIT_FAILURE);
	expect(html.err).toEqual(["distill: http_502"]);
	const odd = harness(() =>
		Response.json({ error: "Has Spaces And Secrets" }, { status: 500 }),
	);
	await odd.run("status");
	expect(odd.err).toEqual(["distill: http_500"]);
	for (const h of [unauthorized, html, odd])
		expect([...h.out, ...h.err].join("\n")).not.toContain(TOKEN);
});

test("R2-11: calibration-export asks for a file only the owner can read", async () => {
	const h = harness(() => Response.json([{ pairId: "p1" }]));
	await h.run("calibration-export", "/tmp/cal.json");
	expect(h.modes["/tmp/cal.json"]).toBe(0o600);
});

test("R2-11: a backend that does not answer in time is given up on", async () => {
	const h = harness();
	h.deps.timeoutMs = 20;
	h.deps.fetch = ((_input: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () =>
				reject(init!.signal!.reason),
			);
		})) as typeof fetch;
	expect(await runDistillCli(["status"], h.deps)).toBe(EXIT_UNREACHABLE);
	expect(h.err).toEqual(["distill: backend_timeout"]);
});
