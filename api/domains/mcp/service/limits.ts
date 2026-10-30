/** Request limits of the MCP endpoint: a token bucket (60 per minute, burst 10) and 4 concurrent calls. */
export const BUCKET_CAPACITY = 10;
export const BUCKET_REFILL_PER_MS = 60 / 60_000;
export const MAX_CONCURRENT = 4;

export interface RequestLimiter {
	/** Takes a token and a concurrency slot; null when either is exhausted (and then takes neither). */
	acquire(now: number): (() => void) | null;
}

export function createLimiter(): RequestLimiter {
	let tokens = BUCKET_CAPACITY;
	let last: number | null = null;
	let inflight = 0;
	return {
		acquire(now) {
			if (last !== null && now > last)
				tokens = Math.min(
					BUCKET_CAPACITY,
					tokens + (now - last) * BUCKET_REFILL_PER_MS,
				);
			last = last === null ? now : Math.max(last, now);
			// A call refused for concurrency does not spend a token.
			if (tokens < 1 || inflight >= MAX_CONCURRENT) return null;
			tokens -= 1;
			inflight += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				inflight -= 1;
			};
		},
	};
}
