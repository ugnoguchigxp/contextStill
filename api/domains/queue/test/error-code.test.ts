import { expect, test } from "bun:test";
import { toErrorCode } from "../service/runner-shared";

test("snake_case error codes are stored as-is", () => {
	expect(toErrorCode(new Error("larm_inference_401"))).toBe(
		"larm_inference_401",
	);
});

test("free text from providers never becomes an error code", () => {
	for (const message of [
		"接続できませんでした",
		"fetch failed https://example.com/v1?key=sk-abc123",
		"Bearer sk-live-0123456789",
		"A".repeat(200),
	])
		expect(toErrorCode(new Error(message))).toBe("handler_failed");
	expect(toErrorCode("boom")).toBe("execution_failed");
	expect(toErrorCode(new Error(""))).toBe("execution_failed");
});
