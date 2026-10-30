import { expect, test } from "bun:test";
import {
	allSourceFiles,
	checkBoundaries,
	checkSource,
	checkTiers,
	references,
} from "./boundaries";
import { closure, dependsOf, domains, isDomain } from "./domains";

const check = (name: string, spec: string, kind = "import { x } from") =>
	checkSource(name, `${kind} "${spec}";`);

test("the repository itself has no boundary violation", () => {
	const files = allSourceFiles();
	expect(files.length).toBeGreaterThan(50);
	expect(checkBoundaries(files)).toEqual([]);
});

test("the domain table is a DAG that only points to lower tiers", () => {
	expect(checkTiers()).toEqual([]);
	expect(
		checkTiers({ a: { tier: 1, depends: ["b"] }, b: { tier: 1, depends: [] } }),
	).toEqual([
		"tier violation a (tier 1) -> b (tier 1): dependencies must point to a lower tier",
	]);
	expect(
		checkTiers({ a: { tier: 0, depends: ["b"] }, b: { tier: 2, depends: [] } }),
	).toHaveLength(1);
	expect(checkTiers({ a: { tier: 1, depends: ["zzz"] } })).toEqual([
		"unknown dependency a -> zzz",
	]);
	expect(isDomain("knowledge")).toBe(true);
	expect(isDomain("toString")).toBe(false);
	expect(dependsOf("mcp")).toContain("search");
	expect(closure("mcp")).toEqual(
		expect.arrayContaining(["search", "knowledge", "vectors", "sources"]),
	);
	expect(closure("settings")).toEqual(["settings"]);
	// The plan's tiers.
	expect(
		Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, v.tier])),
	).toEqual({
		settings: 0,
		larm: 0,
		queue: 0,
		vectors: 0,
		sources: 0,
		usage: 0,
		map: 0,
		experience: 1,
		knowledge: 1,
		search: 2,
		legacy: 2,
		indexing: 2,
		mcp: 4,
		distill: 3,
		evaluation: 4,
	});
});

test("a domain may import a declared lower-tier domain through its public entry only", () => {
	const file = "api/domains/search/service/a.ts";
	expect(check(file, "../../knowledge")).toEqual([]);
	expect(check(file, "../../knowledge/index")).toEqual([]);
	expect(check(file, "../../knowledge/contracts")).toEqual([]);
	expect(check(file, "../../knowledge/contracts/index")).toEqual([]);
	expect(check(file, "../../knowledge/repository")).toEqual([
		`${file}: import ../../knowledge/repository bypasses knowledge public entry`,
	]);
	expect(check(file, "../../knowledge/service/x")).toHaveLength(1);
	expect(check(file, "../../knowledge/contracts/deep/x")).toHaveLength(1);
	expect(check(file, "../contracts")).toEqual([]);
	expect(check(file, "../repository/anything")).toEqual([]);
});

test("a higher tier is never imported", () => {
	expect(check("api/domains/knowledge/service/a.ts", "../../search")).toEqual([
		"api/domains/knowledge/service/a.ts: forbidden dependency knowledge -> search",
	]);
	expect(check("api/domains/settings/service/a.ts", "../../mcp")).toEqual([
		"api/domains/settings/service/a.ts: forbidden dependency settings -> mcp",
	]);
	expect(check("api/domains/search/service/a.ts", "../../mcp")).toHaveLength(1);
});

test("an undeclared dependency is refused even toward a lower tier", () => {
	expect(check("api/domains/knowledge/service/a.ts", "../../vectors")).toEqual([
		"api/domains/knowledge/service/a.ts: forbidden dependency knowledge -> vectors",
	]);
	expect(check("api/domains/vectors/service/a.ts", "../../larm")).toHaveLength(
		1,
	);
	expect(
		check("api/domains/mcp/controller/a.ts", "../../vectors"),
	).toHaveLength(1);
	expect(check("api/domains/mcp/controller/a.ts", "../../search")).toEqual([]);
});

test("tests may import any domain, but still only its public entry", () => {
	expect(check("api/domains/vectors/test/a.test.ts", "../../larm")).toEqual([]);
	expect(check("api/domains/knowledge/test/a.test.ts", "../../search")).toEqual(
		[],
	);
	expect(
		check("api/domains/vectors/test/a.test.ts", "../../larm/service/embedding"),
	).toHaveLength(1);
	// Only *.test.ts and domains/<domain>/test/ are exempt; a fixture elsewhere is checked.
	expect(
		check("api/domains/sources/service/a.fixture.ts", "../../larm"),
	).toHaveLength(1);
	expect(
		check("api/domains/sources/service/test.ts", "../../larm"),
	).toHaveLength(1);
	expect(check("api/domains/sources/a.test.ts", "../../larm")).toEqual([]);
});

test("production code never imports test files or test directories", () => {
	const message = (file: string, spec: string) =>
		`${file}: non-test code must not import test files (${spec})`;
	for (const [file, spec] of [
		["api/domains/larm/service/a.ts", "../test/helper"],
		["api/domains/larm/service/a.ts", "../../sources/test/helper"],
		["api/domains/larm/service/a.ts", "./a.test"],
		["api/domains/larm/service/a.ts", "../test/b.test.ts"],
		["api/application/a.ts", "../domains/larm/test/helper"],
		["api/infrastructure/a.ts", "./b.test"],
	] as const)
		expect(checkSource(file, `import { x } from "${spec}";`)).toContain(
			message(file, spec),
		);
	expect(check("api/domains/larm/test/a.test.ts", "./helper")).toEqual([]);
	expect(check("api/domains/larm/test/helper.ts", "../service")).toEqual([]);
});

test("domains never import api/application", () => {
	for (const file of [
		"api/domains/larm/service/a.ts",
		"api/domains/larm/test/a.test.ts",
	])
		expect(check(file, "../../../application/config")).toEqual([
			`${file}: domain must not import api/application (../../../application/config)`,
		]);
	expect(
		check("api/domains/larm/service/a.ts", "../../../infrastructure/digest"),
	).toEqual([]);
});

test("infrastructure imports neither domains nor application (tests excepted)", () => {
	const message = (spec: string) =>
		`api/infrastructure/a.ts: infrastructure must not import domains/application (${spec})`;
	expect(check("api/infrastructure/a.ts", "../domains/knowledge")).toEqual([
		message("../domains/knowledge"),
	]);
	expect(check("api/infrastructure/a.ts", "../application/app")).toEqual([
		message("../application/app"),
	]);
	expect(check("api/infrastructure/sqlite/a.ts", "../logger")).toEqual([]);
	expect(check("api/infrastructure/sqlite/a.ts", "./b")).toEqual([]);
	expect(check("api/infrastructure/a.test.ts", "../domains/knowledge")).toEqual(
		[],
	);
});

test("the application reaches a domain through its public entry or contracts only", () => {
	const file = "api/application/a.ts";
	expect(check(file, "../domains/knowledge")).toEqual([]);
	expect(check(file, "../domains/knowledge/index")).toEqual([]);
	expect(check(file, "../domains/knowledge/contracts")).toEqual([]);
	expect(check(file, "../domains/knowledge/repository")).toEqual([
		`${file}: application must use knowledge public entry (../domains/knowledge/repository)`,
	]);
	expect(check(file, "../infrastructure/sqlite")).toEqual([]);
	expect(
		check("api/application/a.test.ts", "../domains/knowledge/test/helper"),
	).toEqual([]);
	expect(check(file, "../domains/knowledge/test/helper")).toHaveLength(2);
});

test("path aliases are refused but packages pass", () => {
	for (const spec of ["@/x", "~/x", "api/x", "scripts/x"])
		expect(check("api/application/a.ts", spec)).toEqual([
			`api/application/a.ts: boundary_alias_forbidden (${spec})`,
		]);
	for (const spec of ["zod", "hono", "node:path", "bun:test", "bun:sqlite"])
		expect(check("api/application/a.ts", spec)).toEqual([]);
});

test("every form of reference is seen", () => {
	const file = "api/domains/knowledge/service/a.ts";
	const bad = "../../search/service/x";
	for (const text of [
		`import { a } from "${bad}";`,
		`import type { A } from "${bad}";`,
		`import a, { b } from '${bad}';`,
		`import * as a from "${bad}";`,
		`export * from "${bad}";`,
		`export { a } from "${bad}";`,
		`export type { A } from "${bad}";`,
		`import "${bad}";`,
		`const m = await import("${bad}");`,
		`type T = import("${bad}").T;`,
		`import {\n  a,\n  b,\n} from "${bad}";`,
	])
		expect(checkSource(file, text).length).toBeGreaterThan(0);
});

test("require() and import.meta.resolve() are references too", () => {
	const file = "api/domains/knowledge/service/a.ts";
	const bad = "../../search/service/x";
	for (const text of [
		`const m = require("${bad}");`,
		`const m = require('${bad}');`,
		`const p = import.meta.resolve("${bad}");`,
		`const m = module.exports = require( "${bad}" );`,
	])
		expect(checkSource(file, text).length).toBeGreaterThan(0);
	for (const text of [
		"const m = require(name);",
		"const p = import.meta.resolve(`../x/${y}`);",
	])
		expect(checkSource(file, text)).toEqual([
			`${file}: boundary_dynamic_specifier`,
		]);
	// createRequire(...) and a method named require are not the require function.
	expect(
		checkSource(file, "const r = createRequire(import.meta.url);"),
	).toEqual([]);
	expect(checkSource(file, "container.require(name);")).toEqual([]);
	expect(references('const a = require("zod");')).toEqual([{ spec: "zod" }]);
});

test("dynamic specifiers are refused; comments are not references", () => {
	const file = "api/domains/knowledge/service/a.ts";
	expect(checkSource(file, "const m = await import(name);")).toEqual([
		`${file}: boundary_dynamic_specifier`,
	]);
	expect(checkSource(file, "const m = await import(`../x/${y}`);")).toEqual([
		`${file}: boundary_dynamic_specifier`,
	]);
	expect(checkSource(file, '// import { a } from "../../search";')).toEqual([]);
	expect(checkSource(file, '/* import { a } from "../../search"; */')).toEqual(
		[],
	);
	expect(checkSource(file, 'const s = "not an import";')).toEqual([]);
	expect(references('import { a } from "./a";\nconst x = 1;')).toEqual([
		{ spec: "./a" },
	]);
});

test("a directory that the table does not declare is refused", () => {
	expect(
		checkSource("api/domains/mystery/service/a.ts", "export const a = 1;"),
	).toEqual([
		"api/domains/mystery/service/a.ts: undeclared domain directory mystery",
	]);
	expect(check("api/domains/search/service/a.ts", "../../mystery")).toEqual([
		"api/domains/search/service/a.ts: import of undeclared domain mystery",
	]);
});
