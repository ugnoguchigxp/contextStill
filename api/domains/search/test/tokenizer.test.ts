import { expect, test } from "bun:test";
import { tokenizeQuery } from "../index";

test("3+ character words go to fts, 2 character words to short, single characters are dropped", () => {
	expect(tokenizeQuery("Backup DB x")).toEqual({
		ftsTerms: ["backup"],
		shortTerms: ["db"],
	});
});

test("NFKC and lowercase are applied", () => {
	expect(tokenizeQuery("ＢＡＣＫＵＰ").ftsTerms).toEqual(["backup"]);
});

test("a Japanese phrase yields a 3+ character term and a 2 character term", () => {
	expect(tokenizeQuery("書き込み").ftsTerms).toContain("書き込み");
	expect(tokenizeQuery("規則").shortTerms).toEqual(["規則"]);
});

test("adjacent CJK words are also joined; separated words are not", () => {
	const joined = tokenizeQuery("命名規則");
	expect(joined.ftsTerms.some((t) => t === "命名規則")).toBe(true);
	const apart = tokenizeQuery("命名 規則");
	expect(apart.ftsTerms).not.toContain("命名規則");
	expect(apart.shortTerms).toEqual(expect.arrayContaining(["命名", "規則"]));
});

test("terms are deduplicated and capped", () => {
	expect(tokenizeQuery("alpha alpha ALPHA").ftsTerms).toEqual(["alpha"]);
	const many = Array.from(
		{ length: 40 },
		(_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`,
	).join(" ");
	expect(tokenizeQuery(many).ftsTerms).toHaveLength(32);
	const shorts = Array.from(
		{ length: 20 },
		(_, i) => `a${String.fromCharCode(97 + i)}`,
	).join(" ");
	expect(tokenizeQuery(shorts).shortTerms).toHaveLength(8);
});

test("punctuation only yields nothing", () => {
	expect(tokenizeQuery("!!! ... ?")).toEqual({ ftsTerms: [], shortTerms: [] });
});

test("hiragana-only 2 character words are dropped before the short-term cap", () => {
	expect(tokenizeQuery("する いる ひどい").shortTerms).toEqual([]);
	// Katakana, kanji and alphanumerics stay; they must not be crowded out by hiragana.
	const mixed = [
		...Array.from({ length: 10 }, (_, i) => `${"あいうえおかきくけこ"[i]}ー`),
		"規則",
		"ab",
		"ルール",
		"カメ",
	].join(" ");
	const { shortTerms } = tokenizeQuery(mixed);
	expect(shortTerms).toEqual(expect.arrayContaining(["規則", "ab", "カメ"]));
	expect(shortTerms.every((t) => !/^[\p{Script=Hiragana}ー]+$/u.test(t))).toBe(
		true,
	);
});
