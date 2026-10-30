import { expect, test } from "bun:test";
import { settle, waitFor } from "./wait-for";

test("resolves once the condition holds, without waiting out the timeout", async () => {
	let ticks = 0;
	const started = performance.now();
	await waitFor(() => ++ticks >= 3, { timeout: 5000 });
	expect(ticks).toBe(3);
	expect(performance.now() - started).toBeLessThan(1000);
});

test("accepts an async condition and fails when it is never met", async () => {
	await waitFor(async () => true);
	await expect(waitFor(() => false, { timeout: 20 })).rejects.toThrow(
		"wait_for_timeout",
	);
});

test("settle runs queued continuations without waiting in real time", async () => {
	let done = false;
	setImmediate(() => {
		Promise.resolve()
			.then(() => Promise.resolve())
			.then(() => {
				done = true;
			});
	});
	const started = performance.now();
	await settle();
	expect(done).toBe(true);
	expect(performance.now() - started).toBeLessThan(200);
});
