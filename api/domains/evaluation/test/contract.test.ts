import { expect, test } from "bun:test";
import { evalCaseSchema } from "../index";

const REF = "legacy:knowledge_items:0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a";
const valid = {
	id: "case-001",
	query: "書き込みの前に何を確認する",
	spaces: ["coding"],
	relevant: [{ ref: REF, grade: 3 }],
	labelSource: "agent-draft",
	style: "question",
};

test("evalCaseSchema accepts a case and defaults kinds to knowledge", () => {
	const parsed = evalCaseSchema.parse(valid);
	expect(parsed.kinds).toEqual(["knowledge"]);
	expect(
		evalCaseSchema.safeParse({
			...valid,
			note: "n",
			kinds: ["knowledge", "episode"],
		}).success,
	).toBe(true);
	expect(
		evalCaseSchema.safeParse({
			...valid,
			relevant: [
				{
					ref: "legacy:episode_cards:0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a",
					grade: 1,
				},
			],
		}).success,
	).toBe(true);
});

test("evalCaseSchema rejects what the plan forbids", () => {
	for (const bad of [
		{ ...valid, id: "Bad Id" },
		{ ...valid, id: "" },
		{ ...valid, query: "" },
		{ ...valid, query: "x".repeat(513) },
		{ ...valid, spaces: [] },
		{ ...valid, spaces: ["personal"] },
		{ ...valid, kinds: [] },
		{ ...valid, relevant: [] },
		{ ...valid, relevant: [{ ref: REF, grade: 0 }] },
		{ ...valid, relevant: [{ ref: REF, grade: 4 }] },
		{ ...valid, relevant: [{ ref: REF, grade: 1.5 }] },
		{
			...valid,
			relevant: [
				{
					ref: "legacy:sources:0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a",
					grade: 1,
				},
			],
		},
		{ ...valid, relevant: [{ ref: "kn_abc", grade: 1 }] },
		{ ...valid, labelSource: "robot" },
		{ ...valid, style: "essay" },
		{ ...valid, note: "n".repeat(501) },
		{ ...valid, extra: true },
	])
		expect(evalCaseSchema.safeParse(bad).success).toBe(false);
});
