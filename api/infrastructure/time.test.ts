import { expect, test } from "bun:test";
import { classifyTime, toUtcIso } from "./time";

test("every legacy format becomes UTC ISO", () => {
	expect(toUtcIso("unix-ms:1782131618752")).toBe("2026-06-22T12:33:38.752Z");
	expect(toUtcIso("2026-09-11 05:04:10")).toBe("2026-09-11T05:04:10.000Z");
	expect(toUtcIso("2026-06-18T14:57:56.032Z")).toBe("2026-06-18T14:57:56.032Z");
	expect(toUtcIso("2026-06-18T23:57:56+09:00")).toBe(
		"2026-06-18T14:57:56.000Z",
	);
});

test("values that cannot be understood become null", () => {
	for (const bad of ["", "abc", "unix-ms:x", "unix-ms:", "2026-13-01 00:00:00"])
		expect(toUtcIso(bad)).toBeNull();
	expect(toUtcIso(null)).toBeNull();
	expect(toUtcIso(undefined)).toBeNull();
	expect(toUtcIso("2026-02-30 00:00:00")).toBeNull();
});

test("classifyTime names the format", () => {
	expect(classifyTime("unix-ms:1782131618752")).toBe("unix_ms");
	expect(classifyTime("2026-09-11 05:04:10")).toBe("sqlite");
	expect(classifyTime("2026-06-18T14:57:56.032Z")).toBe("iso");
	expect(classifyTime("2026-06-18T23:57:56+09:00")).toBe("iso");
	expect(classifyTime("")).toBe("invalid");
	expect(classifyTime("abc")).toBe("invalid");
	expect(classifyTime("unix-ms:x")).toBe("invalid");
});

test("ISO values with an impossible calendar date or time are not rolled over", () => {
	for (const bad of [
		"2026-02-31T00:00:00Z",
		"2026-02-31T00:00:00",
		"2026-04-31T10:00:00Z",
		"2026-02-29T00:00:00Z",
		"2026-06-18T24:00:00Z",
		"2026-06-18T23:60:00Z",
		"2026-06-18T23:59:60Z",
		"2026-13-01T00:00:00Z",
		"2026-06-18T10:00:00+24:00",
		"2026-06-18T10:00:00+09:60",
	]) {
		expect(toUtcIso(bad)).toBeNull();
		expect(classifyTime(bad)).toBe("invalid");
	}
	expect(toUtcIso("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
	expect(toUtcIso("2026-06-18T10:00")).toBe("2026-06-18T10:00:00.000Z");
	expect(toUtcIso("2026-06-18T10:00:00.5")).toBe("2026-06-18T10:00:00.500Z");
});
