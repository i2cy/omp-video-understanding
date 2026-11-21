import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VideoUnderstandingService } from "../src/service";
import type { BackendAnswer, NativeVideoBackend, NativeVideoRequest } from "../src/types";

const fixture = path.resolve("fixtures/native-motion.mp4");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function authorizedRoot(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "video-service-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function settings(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		baseUrl: "http://backend.invalid/v1",
		model: "configured-model",
		localRoots: JSON.stringify([root, path.dirname(fixture)]),
		...overrides,
	};
}

function backendWith(answer: BackendAnswer | ((request: NativeVideoRequest) => Promise<BackendAnswer>)): { backend: NativeVideoBackend; requests: NativeVideoRequest[] } {
	const requests: NativeVideoRequest[] = [];
	return {
		requests,
		backend: {
			async analyze(request) {
				requests.push(request);
				return typeof answer === "function" ? answer(request) : answer;
			},
		},
	};
}

const success: BackendAnswer = {
	answer: "The square moves left to right, then changes from black to red.",
	model: "served-model",
	finishReason: "stop",
	usage: { promptTokens: 40, completionTokens: 12 },
	warnings: [],
};

describe("video understanding service", () => {
	test("returns native provenance, media metadata, usage and stable phases", async () => {
		const root = await authorizedRoot();
		const { backend, requests } = backendWith(success);
		const phases: string[] = [];
		const service = new VideoUnderstandingService(backend, async () => settings(root));
		const result = await service.understand(
			{ source: { kind: "file", path: fixture }, question: "Describe motion", maxOutputTokens: 9999 },
			{ cwd: root, onPhase: phase => phases.push(phase) },
		);
		expect(result.provenance.mode).toBe("native-video-url");
		expect(result.provenance.backend).toBe("vllm-openai-compatible");
		expect(result.provenance.model).toBe("served-model");
		expect(result.provenance.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.media.durationMs).toBeGreaterThan(1000);
		expect(result.usage).toEqual(success.usage);
		expect(phases).toEqual(["resolving_source", "validating_media", "dispatching", "waiting_for_backend", "completed"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.maxOutputTokens).toBe(1024);
		expect(requests[0]?.dataUrl.startsWith("data:video/mp4;base64,")).toBe(true);
	});

	test("does not dispatch while disabled or when an attachment is outside the current context", async () => {
		const root = await authorizedRoot();
		const { backend, requests } = backendWith(success);
		const disabled = new VideoUnderstandingService(backend, async () => settings(root, { enabled: false }));
		await expect(disabled.understand({ source: { kind: "file", path: fixture }, question: "test" }, { cwd: root })).rejects.toMatchObject({ code: "disabled" });
		const noResolver = new VideoUnderstandingService(backend, async () => settings(root));
		await expect(noResolver.understand({ source: { kind: "attachment", id: "1" }, question: "test" }, { cwd: root })).rejects.toMatchObject({ code: "permission_denied" });
		expect(requests).toHaveLength(0);
	});

	test("maps post-dispatch cancellation and never falls back", async () => {
		const root = await authorizedRoot();
		const controller = new AbortController();
		const { backend, requests } = backendWith(async request => {
			const cancelled = Promise.withResolvers<void>();
			request.signal.addEventListener("abort", () => cancelled.reject(new DOMException("cancelled", "AbortError")), { once: true });
			controller.abort();
			await cancelled.promise;
			throw new Error("cancelled request unexpectedly completed");
		});
		const service = new VideoUnderstandingService(backend, async () => settings(root));
		await expect(service.understand(
			{ source: { kind: "file", path: fixture }, question: "test" },
			{ cwd: root, signal: controller.signal },
		)).rejects.toMatchObject({ code: "cancelled" });
		expect(requests).toHaveLength(1);
	});

	test("maps the overall backend deadline to timeout", async () => {
		vi.useFakeTimers();
		try {
			const root = await authorizedRoot();
			const started = Promise.withResolvers<void>();
			const { backend } = backendWith(async request => {
				started.resolve();
				const aborted = Promise.withResolvers<void>();
				request.signal.addEventListener("abort", () => aborted.reject(new DOMException("deadline", "AbortError")), { once: true });
				await aborted.promise;
				throw new Error("timed-out request unexpectedly completed");
			});
			const service = new VideoUnderstandingService(backend, async () => settings(root, { timeoutSeconds: 1 }));
			const pending = service.understand({ source: { kind: "file", path: fixture }, question: "test" }, { cwd: root });
			await started.promise;
			vi.advanceTimersByTime(1000);
			await Promise.resolve();
			await expect(pending).rejects.toMatchObject({ code: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("enforces the non-queueing concurrency boundary before a second dispatch", async () => {
		const root = await authorizedRoot();
		const firstAnswer = Promise.withResolvers<BackendAnswer>();
		const firstStarted = Promise.withResolvers<void>();
		const { backend, requests } = backendWith(() => {
			firstStarted.resolve();
			return firstAnswer.promise;
		});
		const service = new VideoUnderstandingService(backend, async () => settings(root));
		const input = { source: { kind: "file", path: fixture }, question: "test" } as const;
		const first = service.understand(input, { cwd: root });
		await firstStarted.promise;
		await expect(service.understand(input, { cwd: root })).rejects.toMatchObject({ code: "concurrency_limit" });
		expect(requests).toHaveLength(1);
		firstAnswer.resolve(success);
		await expect(first).resolves.toMatchObject({ schemaVersion: 1 });
	});
});
