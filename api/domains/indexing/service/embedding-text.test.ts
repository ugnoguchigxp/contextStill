import { expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { knowledgeContentDigest } from "../../knowledge";
import { embeddingText } from "./embedding-text";

test("an empty situation gives the N1 text and digest", () => {
	for (const situation of [undefined, ""]) {
		const text = embeddingText("knowledge", {
			title: "T",
			body: "B",
			situation,
		});
		expect(text).toBe("T\nB");
		expect(sha256Hex(text)).toBe(knowledgeContentDigest("T", "B"));
		expect(sha256Hex(text)).toBe(knowledgeContentDigest("T", "B", situation));
	}
});

test("a situation comes first and the digest follows the text", () => {
	const text = embeddingText("knowledge", {
		title: "T",
		body: "B",
		situation: "S",
	});
	expect(text).toBe("S\nT\nB");
	expect(sha256Hex(text)).toBe(knowledgeContentDigest("T", "B", "S"));
	expect(knowledgeContentDigest("T", "B", "S")).not.toBe(
		knowledgeContentDigest("T", "B"),
	);
});

test("episodes ignore the knowledge rule", () => {
	expect(embeddingText("episode", { title: "t", situation: "s" })).toBe("t\ns");
});
