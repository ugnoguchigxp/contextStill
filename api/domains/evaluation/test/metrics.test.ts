import { expect, test } from "bun:test";
import { queryMetrics } from "../service/metrics";

const grades = (entries: [string, number][]) => new Map(entries);
const log3 = Math.log2(3);
const log5 = Math.log2(5);

test("recall, MRR and nDCG match a hand calculation", () => {
	// relevant a(grade 3) and b(grade 2); result order x, b, y, a
	const m = queryMetrics(
		["x", "b", "y", "a"],
		grades([
			["a", 3],
			["b", 2],
		]),
		10,
	);
	expect(m.recall).toBe(1);
	expect(m.mrr).toBe(1 / 2);
	expect(m.firstRelevantRank).toBe(2);
	// DCG: b at rank 2 -> (2^2-1)/log2(3); a at rank 4 -> (2^3-1)/log2(5)
	const dcg = 3 / log3 + 7 / log5;
	// ideal: a at rank 1 -> 7/log2(2); b at rank 2 -> 3/log2(3)
	const idcg = 7 + 3 / log3;
	expect(m.ndcg).toBeCloseTo(dcg / idcg, 12);
});

test("a perfect ranking gives nDCG 1 and MRR 1", () => {
	const m = queryMetrics(
		["a", "b", "z"],
		grades([
			["a", 3],
			["b", 2],
		]),
		10,
	);
	expect(m).toEqual({ recall: 1, mrr: 1, ndcg: 1, firstRelevantRank: 1 });
});

test("k cuts the result list and the ideal list", () => {
	const g = grades([
		["a", 3],
		["b", 2],
	]);
	const m = queryMetrics(["x", "b", "y", "a"], g, 2);
	expect(m.recall).toBe(1 / 2);
	expect(m.mrr).toBe(1 / 2);
	expect(m.ndcg).toBeCloseTo(3 / log3 / (7 + 3 / log3), 12);
	// k=1 sees only the first result: nothing relevant
	expect(queryMetrics(["x", "b", "y", "a"], g, 1)).toEqual({
		recall: 0,
		mrr: 0,
		ndcg: 0,
		firstRelevantRank: null,
	});
});

test("no relevant result gives all zeros, and repeated keys count once", () => {
	const g = grades([["a", 1]]);
	expect(queryMetrics([], g, 10).recall).toBe(0);
	const m = queryMetrics(["x", "a", "a"], g, 10);
	expect(m.recall).toBe(1);
	expect(m.firstRelevantRank).toBe(2);
	// gain 2^1-1 = 1: DCG 1/log2(3), ideal 1/log2(2)
	expect(m.ndcg).toBeCloseTo(1 / log3, 12);
});
