import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type DomainInfo, domains, isDomain } from "./domains";

const root = resolve(import.meta.dir, "..");
const domainsDir = resolve(root, "api/domains");
const applicationDir = resolve(root, "api/application");
const infrastructureDir = resolve(root, "api/infrastructure");

const inside = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir}${sep}`);

/** `*.test.ts` and anything under `api/domains/<domain>/test/`; nothing else is exempt. */
const isTestFile = (path: string) => {
	if (/\.test(\.[cm]?[tj]sx?)?$/.test(path)) return true;
	if (!inside(path, domainsDir)) return false;
	const parts = relative(domainsDir, path).split(sep);
	return parts.length > 2 && parts[1] === "test";
};

/** The domain a path belongs to: `api/domains/<name>/…`; "" for an undeclared directory. */
function domainOf(path: string): string | null {
	if (!inside(path, domainsDir) || path === domainsDir) return null;
	return relative(domainsDir, path).split(sep)[0] ?? null;
}

interface Reference {
	spec: string | null;
}

/** Drops comments so that import-like text in them is not a reference. Strings are kept. */
function stripComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		const next = text[i + 1];
		if (c === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
		} else if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += c;
			i++;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === "\\") {
					out += text[i]!;
					i++;
				}
				if (i < text.length) out += text[i]!;
				i++;
			}
			if (i < text.length) out += quote;
			i++;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

const STATIC_FROM =
	/\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?(["'])([^"'\n]+)\1/g;
const SIDE_EFFECT_IMPORT = /\bimport\s+(["'])([^"'\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)\)/g;
const REQUIRE_CALL = /(?<![\w$.])require\s*\(\s*([^)]*)\)/g;
const IMPORT_META_RESOLVE = /\bimport\.meta\.resolve\s*\(\s*([^)]*)\)/g;

/** Every module reference: import/export-from, side-effect import, import(), require(), import.meta.resolve(). */
export function references(text: string): Reference[] {
	const code = stripComments(text);
	const found: Reference[] = [];
	for (const m of code.matchAll(STATIC_FROM)) found.push({ spec: m[2]! });
	for (const m of code.matchAll(SIDE_EFFECT_IMPORT))
		found.push({ spec: m[2]! });
	for (const pattern of [DYNAMIC_IMPORT, REQUIRE_CALL, IMPORT_META_RESOLVE])
		for (const m of code.matchAll(pattern)) {
			const arg = m[1]!.trim();
			const literal = /^(["'`])([^"'`$\n]+)\1$/.exec(arg);
			found.push({ spec: literal ? literal[2]! : null });
		}
	return found;
}

const aliasPrefixes = ["@/", "~/", "api/", "scripts/"];

/** Checks one file's source text; `name` is the repo-relative path and only used in messages. */
export function checkSource(name: string, text: string): string[] {
	const errors: string[] = [];
	const path = resolve(root, name);
	const inDomains = inside(path, domainsDir);
	const source = domainOf(path);
	if (inDomains && source !== null && !isDomain(source))
		errors.push(`${name}: undeclared domain directory ${source}`);
	const test = isTestFile(path);
	for (const { spec } of references(text)) {
		if (spec === null) {
			errors.push(`${name}: boundary_dynamic_specifier`);
			continue;
		}
		if (!spec.startsWith(".")) {
			if (aliasPrefixes.some((prefix) => spec.startsWith(prefix)))
				errors.push(`${name}: boundary_alias_forbidden (${spec})`);
			continue;
		}
		const target = resolve(dirname(path), spec);
		// api/infrastructure is the lowest layer: no domains, no application.
		if (
			inside(path, infrastructureDir) &&
			!test &&
			(inside(target, domainsDir) || inside(target, applicationDir))
		)
			errors.push(
				`${name}: infrastructure must not import domains/application (${spec})`,
			);
		// A domain never reaches up into the application.
		if (inDomains && inside(target, applicationDir))
			errors.push(`${name}: domain must not import api/application (${spec})`);
		// Test code and its helpers are for tests: production code never imports them.
		if (!test && isTestFile(target))
			errors.push(
				`${name}: non-test code must not import test files (${spec})`,
			);
		const targetDomain = domainOf(target);
		// api/application reaches a domain only through its public entry.
		if (inside(path, applicationDir) && targetDomain !== null) {
			const rest = relative(resolve(domainsDir, targetDomain), target)
				.split(sep)
				.join("/");
			const allowed =
				rest === "" ||
				rest === "index" ||
				rest === "contracts" ||
				rest.startsWith("contracts/") ||
				(test && (rest === "test" || rest.startsWith("test/")));
			if (!allowed)
				errors.push(
					`${name}: application must use ${targetDomain} public entry (${spec})`,
				);
		}
		if (!inDomains || source === null || targetDomain === null) continue;
		if (targetDomain === source) continue;
		if (!isDomain(source) || !isDomain(targetDomain)) {
			if (!isDomain(targetDomain))
				errors.push(`${name}: import of undeclared domain ${targetDomain}`);
			continue;
		}
		if (
			!test &&
			!(domains[source].depends as readonly string[]).includes(targetDomain)
		)
			errors.push(`${name}: forbidden dependency ${source} -> ${targetDomain}`);
		const rest = relative(resolve(domainsDir, targetDomain), target)
			.split(sep)
			.join("/");
		const publicEntry =
			rest === "" ||
			rest === "index" ||
			rest === "contracts" ||
			rest === "contracts/index";
		if (!publicEntry)
			errors.push(
				`${name}: import ${spec} bypasses ${targetDomain} public entry`,
			);
	}
	return errors;
}

/** Every declared dependency must point to a strictly lower tier, and to a known domain. */
export function checkTiers(
	graph: Record<string, DomainInfo> = domains,
): string[] {
	const errors: string[] = [];
	for (const [name, info] of Object.entries(graph))
		for (const dep of info.depends) {
			const target = graph[dep];
			if (!target) errors.push(`unknown dependency ${name} -> ${dep}`);
			else if (target.tier >= info.tier)
				errors.push(
					`tier violation ${name} (tier ${info.tier}) -> ${dep} (tier ${target.tier}): dependencies must point to a lower tier`,
				);
		}
	return errors;
}

export function checkBoundaries(files: string[]): string[] {
	const errors = checkTiers();
	for (const name of files) {
		const path = resolve(root, name);
		if (!existsSync(path) || !/\.[cm]?[tj]sx?$/.test(path)) continue;
		errors.push(...checkSource(name, readFileSync(path, "utf8")));
	}
	// A directory under api/domains that the table does not declare.
	if (existsSync(domainsDir))
		for (const name of readdirSync(domainsDir))
			if (statSync(join(domainsDir, name)).isDirectory() && !isDomain(name))
				errors.push(`api/domains/${name}: undeclared domain directory`);
	return errors;
}

const skipped = new Set(["node_modules", ".git"]);
// Runtime output directories are skipped only directly under api/, never inside a domain.
const skippedUnderApi = new Set(["data", "coverage"]);
function walk(path: string): string[] {
	try {
		return readdirSync(path).flatMap((name) => {
			if (skipped.has(name)) return [];
			if (path === join(root, "api") && skippedUnderApi.has(name)) return [];
			const file = join(path, name);
			return statSync(file).isDirectory() ? walk(file) : [file];
		});
	} catch {
		return [];
	}
}

/** Every checked source file, relative to the repository root. */
export function allSourceFiles(): string[] {
	return ["api"]
		.flatMap((dir) => walk(join(root, dir)))
		.filter((file) => /\.tsx?$/.test(file))
		.map((file) => relative(root, file));
}

if (import.meta.main) {
	const files = allSourceFiles();
	const errors = checkBoundaries(files);
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(`boundaries ok (${files.length} files)`);
}
