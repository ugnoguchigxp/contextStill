import { expect, test } from "bun:test";
import { HANDLE_PATTERN, handleKind, makeHandle } from "./handle";

test("handles are deterministic and match the pattern", () => {
	const id = "0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a";
	const k = makeHandle("knowledge", id);
	const e = makeHandle("episode", id);
	expect(k).toMatch(HANDLE_PATTERN);
	expect(e).toMatch(HANDLE_PATTERN);
	expect(k.startsWith("kn_")).toBe(true);
	expect(e.startsWith("ep_")).toBe(true);
	expect(makeHandle("knowledge", id)).toBe(k);
	expect(k.slice(3)).not.toBe(e.slice(3));
	expect(makeHandle("knowledge", `${id}x`)).not.toBe(k);
});

test("theme handles use the th_ prefix and are distinct from the other kinds", () => {
	const t = makeHandle("theme", "a");
	expect(t).toMatch(HANDLE_PATTERN);
	expect(t.startsWith("th_")).toBe(true);
	expect(handleKind(t)).toBe("theme");
	expect(t.slice(3)).not.toBe(makeHandle("knowledge", "a").slice(3));
	expect(makeHandle("theme", "a")).toBe(t);
});

test("handle values are pinned", () => {
	expect(makeHandle("knowledge", "a")).toBe(PINNED.knowledgeA);
	expect(makeHandle("episode", "a")).toBe(PINNED.episodeA);
});

test("handleKind reads the prefix of a well-formed handle only", () => {
	expect(handleKind(makeHandle("knowledge", "x"))).toBe("knowledge");
	expect(handleKind(makeHandle("episode", "x"))).toBe("episode");
	for (const bad of [
		"",
		"kn_",
		"kn_short",
		"xx_aaaaaaaaaaaaaaaaaaaaaaaaaa",
		"kn_AAAAAAAAAAAAAAAAAAAAAAAAAA",
		"kn_1aaaaaaaaaaaaaaaaaaaaaaaaa",
		"kn_aaaaaaaaaaaaaaaaaaaaaaaaaaa",
	])
		expect(handleKind(bad)).toBeNull();
});

const PINNED = {
	knowledgeA: "kn_g6opspj5gfkawo7xjrs3efxjei",
	episodeA: "ep_22ysnkohafxa3o2tzygofxp7xe",
};
