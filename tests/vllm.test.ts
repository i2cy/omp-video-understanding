import { afterEach, describe, expect, test } from "bun:test";
import { VideoUnderstandError } from "../src/errors";
import type {
	AcquiredMedia,
	NativeVideoRequest,
	VideoPluginConfig,
	VideoUnderstandErrorCode,
} from "../src/types";
import { testVllmConnection, VllmVideoBackend } from "../src/vllm";

interface SeenRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}

type Responder = (request: SeenRequest) => Response | Promise<Response>;

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

async function startServer(respond: Responder): Promise<{
	baseUrl: string;
	requests: SeenRequest[];
}> {
	const requests: SeenRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const rawBody = await request.text();
			let body: unknown = undefined;
			if (rawBody) {
				try {
					body = JSON.parse(rawBody);
				} catch {
					body = rawBody;
				}
			}
			const seen: SeenRequest = {
				method: request.method,
				path: new URL(request.url).pathname,
				headers: Object.fromEntries(request.headers.entries()),
				body,
			};
			requests.push(seen);
			return respond(seen);
		},
	});
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests };
}

function makeConfig(baseUrl: string, apiKey = ""): VideoPluginConfig {
	return {
		schemaVersion: 1,
		enabled: true,
		backend: { type: "vllm-video-url", baseUrl, model: "configured-model", apiKey },
		limits: {
			timeoutSeconds: 30,
			maxMediaBytes: 1024 * 1024,
			maxDurationSeconds: 30,
			maxOutputTokens: 512,
			concurrency: 1,
		},
		sources: {
			allowLocalFiles: true,
			localRoots: [],
			allowRemoteUrls: false,
			allowedRemoteDomains: [],
		},
	};
}

const media: AcquiredMedia = {
	path: "/tmp/native-video.mp4",
	mimeType: "video/mp4",
	sizeBytes: 4,
	sha256: "a".repeat(64),
	cleanup: async () => {},
};

function makeRequest(config: VideoPluginConfig, signal = new AbortController().signal): NativeVideoRequest {
	return {
		config,
		media,
		dataUrl: "data:video/mp4;base64,AAAA",
		question: "Which way does the object move?",
		maxOutputTokens: 123,
		signal,
	};
}

function completionResponse(overrides: Record<string, unknown> = {}): Response {
	return Response.json({
		model: "served-model",
		choices: [{ message: { role: "assistant", content: "It moves left to right." }, finish_reason: "stop" }],
		usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 },
		...overrides,
	});
}

describe("VllmVideoBackend", () => {
	test("sends only the configured native-video request and maps the answer", async () => {
		const { baseUrl, requests } = await startServer(() => completionResponse());
		const config = makeConfig(baseUrl, "secret-key");
		const answer = await new VllmVideoBackend().analyze(makeRequest(config));

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.path).toBe("/v1/chat/completions");
		expect(requests[0]?.headers["content-type"]).toBe("application/json");
		expect(requests[0]?.headers.authorization).toBe("Bearer secret-key");
		expect(requests[0]?.body).toEqual({
			model: "configured-model",
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: "Which way does the object move?" },
					{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
				],
			}],
			max_tokens: 123,
			temperature: 0,
		});
		expect(answer).toEqual({
			answer: "It moves left to right.",
			model: "served-model",
			finishReason: "stop",
			usage: { promptTokens: 21, completionTokens: 8 },
			warnings: [],
		});
	});

	test("omits authorization and falls back to the configured model", async () => {
		const { baseUrl, requests } = await startServer(() => completionResponse({
			model: "",
			usage: undefined,
		}));
		const answer = await new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl)));

		expect(requests[0]?.headers.authorization).toBeUndefined();
		expect(answer).toEqual({
			answer: "It moves left to right.",
			model: "configured-model",
			finishReason: "stop",
			warnings: [],
		});
	});

	const statusCases: Array<[number, VideoUnderstandErrorCode]> = [
		[400, "backend_rejected_video"],
		[401, "backend_authentication_failed"],
		[403, "backend_authentication_failed"],
		[404, "backend_rejected_video"],
		[409, "backend_rejected_video"],
		[413, "backend_rejected_video"],
		[415, "backend_rejected_video"],
		[422, "backend_rejected_video"],
		[500, "backend_unreachable"],
		[503, "backend_unreachable"],
	];
	test.each(statusCases)("maps HTTP %i to %s without retrying", async (status, code) => {
		const { baseUrl, requests } = await startServer(() => new Response(
			"secret-key data:video/mp4;base64,AAAA must not leak",
			{ status },
		));
		const promise = new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl, "secret-key")));

		await expect(promise).rejects.toMatchObject({ name: "VideoUnderstandError", code });
		await promise.catch((error: unknown) => {
			expect(error).toBeInstanceOf(VideoUnderstandError);
			if (error instanceof VideoUnderstandError) {
				expect(error.message).not.toContain("secret-key");
				expect(error.message).not.toContain("data:video");
			}
		});
		expect(requests).toHaveLength(1);
	});

	const protocolCases: Array<[string, unknown]> = [
		["invalid JSON", "not-json"],
		["a non-object response", []],
		["missing choices", {}],
		["empty choices", { choices: [] }],
		["a malformed first choice", { choices: [null] }],
		["missing content", { choices: [{ message: {} }] }],
		["non-string content", { choices: [{ message: { content: ["answer"] } }] }],
		["an empty answer", { choices: [{ message: { content: "  \n" } }] }],
		["a truncated answer", { choices: [{ message: { content: "partial" }, finish_reason: "length" }] }],
		["invalid usage", { choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: "21" } }],
		["an invalid response model", { choices: [{ message: { content: "answer" } }], model: 4 }],
	];
	test.each(protocolCases)("rejects %s as a protocol error", async (_description, responseBody) => {
		const { baseUrl } = await startServer(() => typeof responseBody === "string"
			? new Response(responseBody)
			: Response.json(responseBody));
		const promise = new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl)));
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_protocol_error",
		});
	});

	test("classifies a reasoning-only length response as truncated", async () => {
		const { baseUrl } = await startServer(() => Response.json({
			choices: [{ message: { content: null, reasoning: "unfinished" }, finish_reason: "length" }],
		}));
		const promise = new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl)));
		await expect(promise).rejects.toMatchObject({
			code: "backend_protocol_error",
			message: "Backend answer was truncated because it reached the output token limit",
		});
	});

	test("enforces the response size limit while reading the body", async () => {
		const { baseUrl, requests } = await startServer(() => new Response(" ".repeat(4 * 1024 * 1024 + 1)));
		const promise = new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl)));
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_protocol_error",
		});
		expect(requests).toHaveLength(1);
	});

	test("maps connection failures to backend_unreachable", async () => {
		const { baseUrl } = await startServer(() => completionResponse());
		servers.pop()?.stop(true);
		const promise = new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl, "secret-key")));
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_unreachable",
		});
	});

	test("passes abort errors through unchanged", async () => {
		const { baseUrl, requests } = await startServer(() => completionResponse());
		const controller = new AbortController();
		controller.abort(new DOMException("Cancelled", "AbortError"));
		let thrown: unknown;
		try {
			await new VllmVideoBackend().analyze(makeRequest(makeConfig(baseUrl), controller.signal));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(controller.signal.reason);
		expect(requests).toHaveLength(0);
	});
});

describe("testVllmConnection", () => {
	test("requires an exact configured model in the models response", async () => {
		const { baseUrl, requests } = await startServer(() => Response.json({
			data: [{ id: "configured-model-extra" }, { id: "configured-model" }],
		}));
		await testVllmConnection(makeConfig(baseUrl), new AbortController().signal);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.path).toBe("/v1/models");
		expect(requests[0]?.body).toBeUndefined();
		expect(requests[0]?.headers.authorization).toBeUndefined();
	});

	test("sends configured authentication and rejects a missing model", async () => {
		const { baseUrl, requests } = await startServer(() => Response.json({ data: [{ id: "other-model" }] }));
		const config = makeConfig(baseUrl, "secret-key");
		const promise = testVllmConnection(config, new AbortController().signal);
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_protocol_error",
		});
		expect(requests[0]?.headers.authorization).toBe("Bearer secret-key");
	});

	test("maps connection authentication failures and does not retry", async () => {
		const { baseUrl, requests } = await startServer(() => new Response("denied", { status: 403 }));
		const promise = testVllmConnection(makeConfig(baseUrl), new AbortController().signal);
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_authentication_failed",
		});
		expect(requests).toHaveLength(1);
	});

	test("rejects malformed model entries", async () => {
		const { baseUrl } = await startServer(() => Response.json({ data: [{ id: 42 }] }));
		const promise = testVllmConnection(makeConfig(baseUrl), new AbortController().signal);
		await expect(promise).rejects.toMatchObject({
			name: "VideoUnderstandError",
			code: "backend_protocol_error",
		});
	});
});
