export interface Deadline {
	signal: AbortSignal;
	timedOut: () => boolean;
	elapsedMs: () => number;
	dispose: () => void;
}

export function createDeadline(timeoutSeconds: number, parent?: AbortSignal): Deadline {
	const startedAt = performance.now();
	const controller = new AbortController();
	let didTimeout = false;
	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(() => {
		didTimeout = true;
		controller.abort(new Error("deadline exceeded"));
	}, timeoutSeconds * 1000);
	return {
		signal: controller.signal,
		timedOut: () => didTimeout,
		elapsedMs: () => performance.now() - startedAt,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException("Operation cancelled", "AbortError");
	}
}
