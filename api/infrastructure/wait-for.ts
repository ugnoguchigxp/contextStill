/**
 * Test support: resolves as soon as `condition` holds, polling on short real-time ticks,
 * and fails with `wait_for_timeout` instead of hanging when it never does.
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	options: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const { timeout = 5000, interval = 2 } = options;
	const end = performance.now() + timeout;
	while (!(await condition())) {
		if (performance.now() > end) throw new Error("wait_for_timeout");
		await Bun.sleep(interval);
	}
}

/**
 * Test support: lets already-scheduled promise continuations and I/O callbacks run, by
 * yielding to the event loop `turns` times. Replaces a fixed sleep after releasing a gate
 * when no observable condition marks the end of the late work.
 */
export async function settle(turns = 25): Promise<void> {
	for (let i = 0; i < turns; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
}
