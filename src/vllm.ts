import { sanitizeErrorText, VideoUnderstandError } from "./errors";
import type {
	BackendAnswer,
	NativeVideoBackend,
	NativeVideoRequest,
	VideoPluginConfig,
	VideoUnderstandErrorCode,
} from "./types";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REJECTED_VIDEO_STATUSES = new Set([400, 404, 409, 413, 415, 422]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
	code: VideoUnderstandErrorCode,
	message: string,
	apiKey: string,
): VideoUnderstandError {
	return new VideoUnderstandError(code, sanitizeErrorText(message, [apiKey]));
}

function isAbortError(error: unknown): error is Error {
	return isObject(error) && error.name === "AbortError";
}

function statusError(status: number, apiKey: string): VideoUnderstandError {
	if (status === 401 || status === 403) {
		return fail("backend_authentication_failed", `Backend authentication failed (HTTP ${status})`, apiKey);
	}
	if (REJECTED_VIDEO_STATUSES.has(status)) {
		return fail("backend_rejected_video", `Backend rejected the video request (HTTP ${status})`, apiKey);
	}
	return fail("backend_unreachable", `Backend returned HTTP ${status}`, apiKey);
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The status error is more useful than a secondary body-cancellation error.
	}
}

async function readLimitedText(response: Response, apiKey: string): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const declaredLength = Number(contentLength);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
			await discardBody(response);
			throw fail("backend_protocol_error", "Backend response exceeded the size limit", apiKey);
		}
	}

	if (response.body === null) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// Preserve the deterministic response-size error.
				}
				throw fail("backend_protocol_error", "Backend response exceeded the size limit", apiKey);
			}
			parts.push(decoder.decode(value, { stream: true }));
		}
		parts.push(decoder.decode());
		return parts.join("");
	} finally {
		reader.releaseLock();
	}
}

async function fetchJson(
	url: string,
	init: RequestInit,
	config: VideoPluginConfig,
): Promise<unknown> {
	const { apiKey } = config.backend;
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (isAbortError(error)) throw error;
		const detail = error instanceof Error ? `: ${error.message}` : "";
		throw fail("backend_unreachable", `Backend request failed${detail}`, apiKey);
	}

	if (!response.ok) {
		await discardBody(response);
		throw statusError(response.status, apiKey);
	}

	let text: string;
	try {
		text = await readLimitedText(response, apiKey);
	} catch (error) {
		if (error instanceof VideoUnderstandError || isAbortError(error)) throw error;
		const detail = error instanceof Error ? `: ${error.message}` : "";
		throw fail("backend_unreachable", `Failed to read backend response${detail}`, apiKey);
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw fail("backend_protocol_error", "Backend returned invalid JSON", apiKey);
	}
}

function readUsage(value: unknown, apiKey: string): BackendAnswer["usage"] {
	if (value === undefined) return undefined;
	if (!isObject(value)) {
		throw fail("backend_protocol_error", "Backend response usage must be an object", apiKey);
	}

	const promptTokens = value.prompt_tokens;
	const completionTokens = value.completion_tokens;
	if (
		promptTokens !== undefined
		&& (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0)
	) {
		throw fail("backend_protocol_error", "Backend response usage contains an invalid token count", apiKey);
	}
	if (
		completionTokens !== undefined
		&& (typeof completionTokens !== "number" || !Number.isSafeInteger(completionTokens) || completionTokens < 0)
	) {
		throw fail("backend_protocol_error", "Backend response usage contains an invalid token count", apiKey);
	}

	if (promptTokens === undefined && completionTokens === undefined) return undefined;
	return {
		...(promptTokens === undefined ? {} : { promptTokens }),
		...(completionTokens === undefined ? {} : { completionTokens }),
	};
}

function parseCompletion(value: unknown, config: VideoPluginConfig): BackendAnswer {
	const { apiKey } = config.backend;
	if (!isObject(value)) {
		throw fail("backend_protocol_error", "Backend response must be a JSON object", apiKey);
	}
	if (!Array.isArray(value.choices) || value.choices.length === 0) {
		throw fail("backend_protocol_error", "Backend response must contain a valid first choice", apiKey);
	}
	const choice: unknown = value.choices[0];
	if (!isObject(choice)) {
		throw fail("backend_protocol_error", "Backend response must contain a valid first choice", apiKey);
	}

	if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
		throw fail("backend_protocol_error", "Backend response finish_reason must be a string", apiKey);
	}
	if (choice.finish_reason === "length") {
		throw fail("backend_protocol_error", "Backend answer was truncated because it reached the output token limit", apiKey);
	}
	if (!isObject(choice.message) || typeof choice.message.content !== "string") {
		throw fail("backend_protocol_error", "Backend response choice must contain string message content", apiKey);
	}
	const answer = choice.message.content;
	if (!answer.trim()) {
		throw fail("backend_protocol_error", "Backend returned an empty answer", apiKey);
	}
	if (value.model !== undefined && typeof value.model !== "string") {
		throw fail("backend_protocol_error", "Backend response model must be a string", apiKey);
	}

	const usage = readUsage(value.usage, apiKey);
	const responseModel = typeof value.model === "string" ? value.model.trim() : "";
	return {
		answer,
		model: responseModel || config.backend.model,
		...(choice.finish_reason == null ? {} : { finishReason: choice.finish_reason }),
		...(usage === undefined ? {} : { usage }),
		warnings: [],
	};
}

export class VllmVideoBackend implements NativeVideoBackend {
	async analyze(request: NativeVideoRequest): Promise<BackendAnswer> {
		const { config } = request;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (config.backend.apiKey) {
			headers.Authorization = `Bearer ${config.backend.apiKey}`;
		}

		const body = {
			model: config.backend.model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: request.question },
						{ type: "video_url", video_url: { url: request.dataUrl } },
					],
				},
			],
			max_tokens: request.maxOutputTokens,
			temperature: 0,
		};
		const json = await fetchJson(`${config.backend.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: request.signal,
		}, config);
		return parseCompletion(json, config);
	}
}

export async function testVllmConnection(config: VideoPluginConfig, signal: AbortSignal): Promise<void> {
	const headers: Record<string, string> = {};
	if (config.backend.apiKey) {
		headers.Authorization = `Bearer ${config.backend.apiKey}`;
	}
	const json = await fetchJson(`${config.backend.baseUrl}/models`, {
		method: "GET",
		headers,
		signal,
	}, config);
	const { apiKey, model } = config.backend;
	if (!isObject(json) || !Array.isArray(json.data)) {
		throw fail("backend_protocol_error", "Backend models response must contain a data array", apiKey);
	}
	for (const entry of json.data) {
		if (!isObject(entry) || typeof entry.id !== "string") {
			throw fail("backend_protocol_error", "Backend models response contains an invalid model entry", apiKey);
		}
	}
	if (!json.data.some(entry => isObject(entry) && entry.id === model)) {
		throw fail("backend_protocol_error", `Configured model is not available: ${model}`, apiKey);
	}
}
