import { readFileSync } from "node:fs";
import { type EvalCase, evalCaseSchema } from "../contracts";

/** One JSON object per line; blank lines are skipped. Errors name the 1-based line. */
export function parseEvalSet(text: string): EvalCase[] {
	const cases: EvalCase[] = [];
	const ids = new Set<string>();
	text.split("\n").forEach((line, index) => {
		if (line.trim() === "") return;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			throw new Error(`eval_set_invalid_json: line ${index + 1}`);
		}
		const parsed = evalCaseSchema.safeParse(json);
		if (!parsed.success)
			throw new Error(
				`eval_set_invalid_case: line ${index + 1}: ${parsed.error.issues
					.map((issue) => `${issue.path.join(".")} ${issue.message}`)
					.join("; ")}`,
			);
		if (ids.has(parsed.data.id))
			throw new Error(
				`eval_set_duplicate_id: line ${index + 1}: ${parsed.data.id}`,
			);
		ids.add(parsed.data.id);
		cases.push(parsed.data);
	});
	return cases;
}

export function loadEvalSet(path: string): EvalCase[] {
	return parseEvalSet(readFileSync(path, "utf8"));
}
