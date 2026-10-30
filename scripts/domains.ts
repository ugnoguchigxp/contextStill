/**
 * The domain graph. `tier` is the layer of a domain: a domain may depend (api) only on
 * domains of a strictly lower tier, so a lower domain can never reference a higher one.
 * scripts/boundaries.ts enforces this next to the allow-list in `depends`.
 * Tests may import the public entry of any domain (they wire everything).
 */
export const domains = {
	settings: { tier: 0, depends: [] },
	larm: { tier: 0, depends: [] },
	queue: { tier: 0, depends: [] },
	vectors: { tier: 0, depends: [] },
	sources: { tier: 0, depends: [] },
	usage: { tier: 0, depends: [] },
	experience: { tier: 1, depends: ["sources"] },
	knowledge: { tier: 1, depends: ["sources"] },
	search: { tier: 2, depends: ["knowledge", "experience", "vectors"] },
	legacy: {
		tier: 2,
		depends: ["sources", "experience", "knowledge", "vectors", "usage"],
	},
	indexing: {
		tier: 2,
		depends: ["larm", "vectors", "knowledge", "experience"],
	},
	mcp: { tier: 3, depends: ["search", "knowledge", "experience", "sources"] },
	evaluation: { tier: 3, depends: ["search", "legacy", "knowledge"] },
} as const satisfies Record<
	string,
	{ tier: number; depends: readonly string[] }
>;

export type Domain = keyof typeof domains;
export type DomainInfo = { tier: number; depends: readonly string[] };

export function isDomain(value: string): value is Domain {
	return Object.hasOwn(domains, value);
}

export function dependsOf(domain: Domain): readonly string[] {
	return domains[domain].depends;
}

/** The domain plus everything it depends on, transitively. */
export function closure(domain: Domain): Domain[] {
	const seen = new Set<Domain>();
	const visit = (name: Domain) => {
		if (seen.has(name)) return;
		seen.add(name);
		for (const dep of domains[name].depends) visit(dep as Domain);
	};
	visit(domain);
	return [...seen];
}
