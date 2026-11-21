import { VideoUnderstandError } from "./errors";

/** Fixed-capacity, non-queueing limiter. Excess work fails before media acquisition. */
export class ConcurrencyLimiter {
	#active = 0;

	get active(): number {
		return this.#active;
	}

	acquire(limit: number): () => void {
		if (this.#active >= limit) {
			throw new VideoUnderstandError("concurrency_limit", `Concurrent video call limit (${limit}) reached`);
		}
		this.#active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#active -= 1;
		};
	}
}
