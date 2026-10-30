import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { resolveOptions } from "../service/runner-options";

test("heartbeat waits release abort listeners after each elapsed interval", async () => {
	const signal = new AbortController().signal;
	for (let i = 0; i < 20; i++) await resolveOptions().sleep(1, signal);
	expect(getEventListeners(signal, "abort")).toHaveLength(0);
});

test("a wait on an already cancelled signal returns immediately", async () => {
	const controller = new AbortController();
	controller.abort();
	const finished = await Promise.race([
		resolveOptions()
			.sleep(100, controller.signal)
			.then(() => true),
		Bun.sleep(10).then(() => false),
	]);
	expect(finished).toBe(true);
});
