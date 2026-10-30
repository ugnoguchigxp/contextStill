import { expect, test } from "bun:test";
import { legacyQueryTokens, legacyScoreText } from "../index";

const QUERY = "本番のデータベース移行を安全に行う";

test("legacyScoreText keeps the two v1 unit-test expectations", () => {
	expect(
		legacyScoreText("データベースをバックアップしてから移行する", QUERY),
	).toBeGreaterThanOrEqual(2);
	expect(legacyScoreText("UIのボタン文言を変更する", QUERY)).toBe(0);
});

test("whole-query match adds 4 and each contained token adds 1", () => {
	// query "abc def": whole phrase absent, tokens "abc" and "def" both present
	expect(legacyScoreText("def and abc", "abc def")).toBe(2);
	// whole phrase present (+4) plus both tokens (+2)
	expect(legacyScoreText("xx abc def yy", "abc def")).toBe(6);
	expect(legacyScoreText("nothing here", "abc def")).toBe(0);
	// empty / blank queries never score
	expect(legacyScoreText("abc", "")).toBe(0);
	expect(legacyScoreText("abc", "   ")).toBe(0);
});

test("matching is case-insensitive and trims the query", () => {
	expect(legacyScoreText("Use SQLite WAL mode", "  sqlite wal  ")).toBe(4 + 2);
});

test("tokens split on anything but letters, digits, underscore and hyphen", () => {
	expect(legacyQueryTokens("Foo_bar, baz-qux! a 12; X")).toEqual([
		"foo_bar",
		"baz-qux",
		"12",
	]);
	// ASCII-only tokens get no n-grams; duplicates are removed
	expect(legacyQueryTokens("abc abc ABC")).toEqual(["abc"]);
	expect(legacyQueryTokens("   ")).toEqual([]);
	expect(legacyQueryTokens("!!! ??? a")).toEqual([]);
});

test("non-ASCII tokens add width-3 then width-2 character n-grams", () => {
	expect(legacyQueryTokens("移行手順")).toEqual([
		"移行手順",
		"移行手",
		"行手順",
		"移行",
		"行手",
		"手順",
	]);
	// a mixed token is n-grammed whole (one non-ASCII character is enough)
	expect(legacyQueryTokens("UI文言")).toEqual([
		"ui文言",
		"ui文",
		"i文言",
		"ui",
		"i文",
		"文言",
	]);
	// a two-character token has no width-3 window and yields only itself
	expect(legacyQueryTokens("移行")).toEqual(["移行"]);
});

test("the token list is cut at 48 entries", () => {
	const long =
		"あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
	const chars = [...long];
	expect(chars).toHaveLength(46);
	const windows = (width: number) =>
		Array.from({ length: chars.length - width + 1 }, (_, i) =>
			chars.slice(i, i + width).join(""),
		);
	// whole token (1) + 44 three-grams + the first 3 two-grams reach 48 entries
	const expected = [long, ...windows(3), ...windows(2)].slice(0, 48);
	const tokens = legacyQueryTokens(long);
	expect(tokens).toHaveLength(48);
	expect(tokens).toEqual(expected);
	expect(tokens[44]).toBe([...long].slice(-3).join(""));
	expect(tokens.slice(45)).toEqual(["あい", "いう", "うえ"]);
});

test("n-grams are formed on characters, not UTF-16 units", () => {
	expect(legacyQueryTokens("𠮷野家")).toEqual(["𠮷野家", "𠮷野", "野家"]);
});
