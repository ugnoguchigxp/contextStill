import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { allMigrations } from "../migrations";
import {
	EXIT_FAILURE,
	EXIT_OK,
	EXIT_USAGE,
	EXIT_WRITER_OWNED,
	intOption,
	numberOption,
	parseArgs,
	runCommand,
	UsageError,
	unitIntervalOption,
} from "./shared";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const env = () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-command-"));
	dirs.push(dir);
	return { dir, env: { CONTEXT_STILL_DB: join(dir, "db.sqlite3") } };
};

test("parseArgs reads flags and values, skips a lone --, and refuses the rest", () => {
	const spec = { a: "flag", b: "value" } as const;
	const parsed = parseArgs(["--", "--a", "--b", "x"], spec);
	expect([...parsed.flags]).toEqual(["a"]);
	expect(parsed.values.get("b")).toBe("x");
	expect(() => parseArgs(["--zzz"], spec)).toThrow(UsageError);
	expect(() => parseArgs(["--b"], spec)).toThrow("missing value for --b");
	expect(() => parseArgs(["--b", "--a"], spec)).toThrow(
		"missing value for --b",
	);
	expect(() => parseArgs(["stray"], spec)).toThrow("unexpected argument");
});

test("numeric options", () => {
	const args = parseArgs(
		["--n", "12", "--m", "0.995", "--bad", "x", "--zero", "0"],
		{
			n: "value",
			m: "value",
			bad: "value",
			zero: "value",
		},
	);
	expect(intOption(args, "n", 1)).toBe(12);
	expect(intOption(args, "absent", 7)).toBe(7);
	expect(() => intOption(args, "bad", 1)).toThrow(UsageError);
	expect(() => intOption(args, "zero", 1)).toThrow(UsageError);
	expect(numberOption(args, "m", 1)).toBe(0.995);
	expect(() => numberOption(args, "bad", 1)).toThrow(UsageError);
});

test("numberOption refuses a blank value; unitIntervalOption keeps (0, 1]", () => {
	const args = parseArgs(
		["--blank", "", "--neg", "-1", "--one", "1", "--over", "1.5", "--m", "0.5"],
		{ blank: "value", neg: "value", one: "value", over: "value", m: "value" },
	);
	// Number("") is 0: a blank threshold must not silently pass every comparison.
	expect(() => numberOption(args, "blank", 1)).toThrow(UsageError);
	expect(() => unitIntervalOption(args, "blank", 0.9)).toThrow(UsageError);
	expect(() => unitIntervalOption(args, "neg", 0.9)).toThrow(UsageError);
	expect(() => unitIntervalOption(args, "over", 0.9)).toThrow(UsageError);
	expect(unitIntervalOption(args, "one", 0.9)).toBe(1);
	expect(unitIntervalOption(args, "m", 0.9)).toBe(0.5);
	expect(unitIntervalOption(args, "absent", 0.9)).toBe(0.9);
});

test("runCommand: exit 0 and the report on stdout; the lock is released", async () => {
	const { env: e } = env();
	const lines: string[] = [];
	const log = console.log;
	console.log = (line: string) => void lines.push(line);
	try {
		const code = await runCommand(
			"t",
			[],
			async (runtime) => ({ db: runtime.config.dbPath.endsWith("db.sqlite3") }),
			{ env: e },
		);
		expect(code).toBe(EXIT_OK);
	} finally {
		console.log = log;
	}
	expect(JSON.parse(lines.join("\n"))).toEqual({ db: true });
	// The runtime was closed, so the writer lock is free.
	await openStore(e.CONTEXT_STILL_DB, allMigrations).close();
});

test("runCommand: exit 1 on failure, 2 on bad arguments (before the database is opened)", async () => {
	const { env: e } = env();
	const error = console.error;
	const seen: string[] = [];
	console.error = (line: string) => void seen.push(line);
	try {
		expect(
			await runCommand(
				"t",
				[],
				async () => {
					throw new Error("boom secret");
				},
				{ env: e },
			),
		).toBe(EXIT_FAILURE);
		expect(
			await runCommand("t", ["--x"], async () => ({}), {
				env: e,
				validate: (a) => void parseArgs(a, {}),
			}),
		).toBe(EXIT_USAGE);
		expect(
			await runCommand("t", [], async () => ({}), {
				env: { CONTEXT_STILL_PORT: "39171" },
			}),
		).toBe(EXIT_FAILURE);
	} finally {
		console.error = error;
	}
	// A failure reports a code, never the message of an arbitrary error.
	expect(seen.join("\n")).not.toContain("boom secret");
	expect(seen).toContain("t: command_failed");
	expect(seen).toContain("t: port_reserved_by_legacy");
});

test("runCommand: exitCode judges a completed report, which is printed either way", async () => {
	const { env: e } = env();
	const lines: string[] = [];
	const log = console.log;
	console.log = (line: string) => void lines.push(line);
	try {
		const code = await runCommand("t", [], async () => ({ failed: 2 }), {
			env: e,
			exitCode: (report) => (report.failed > 0 ? EXIT_FAILURE : EXIT_OK),
		});
		expect(code).toBe(EXIT_FAILURE);
	} finally {
		console.log = log;
	}
	expect(JSON.parse(lines.join("\n"))).toEqual({ failed: 2 });
});

test("runCommand: exit 3 while another process owns the database", async () => {
	const { env: e } = env();
	const owner = openStore(e.CONTEXT_STILL_DB, allMigrations);
	const error = console.error;
	const seen: string[] = [];
	console.error = (line: string) => void seen.push(line);
	try {
		expect(await runCommand("t", [], async () => ({}), { env: e })).toBe(
			EXIT_WRITER_OWNED,
		);
	} finally {
		console.error = error;
		await owner.close();
	}
	expect(seen).toEqual(["t: database_writer_owned"]);
});
