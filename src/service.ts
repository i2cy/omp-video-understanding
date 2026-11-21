import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { ConcurrencyLimiter } from "./concurrency";
import { parsePluginConfig, requireConfigured, resolveMaxOutputTokens } from "./config";
import { createDeadline, throwIfAborted } from "./deadline";
import { publicError, VideoUnderstandError } from "./errors";
import { acquireMedia, type ResolvedMediaSource } from "./media";
import { MAX_QUESTION_LENGTH, PLUGIN_NAME, type AcquiredMedia,
	type NativeVideoBackend,
	type VideoUnderstandInput,
	type VideoUnderstandPhase,
	type VideoUnderstandResult } from "./types";
import { VllmVideoBackend } from "./vllm";

export interface UnderstandOptions {
	cwd: string;
	signal?: AbortSignal;
	onPhase?: (phase: VideoUnderstandPhase) => void;
	resolveAttachment?: (id: string) => string | Promise<string>;
	requireEnabled?: boolean;
}

export type SettingsLoader = (pluginName: string, cwd: string) => Promise<Record<string, unknown>>;

export class VideoUnderstandingService {
	readonly #backend: NativeVideoBackend;
	readonly #loadSettings: SettingsLoader;
	readonly #limiter: ConcurrencyLimiter;

	constructor(
		backend: NativeVideoBackend = new VllmVideoBackend(),
		loadSettings: SettingsLoader = getPluginSettings,
		limiter = new ConcurrencyLimiter(),
	) {
		this.#backend = backend;
		this.#loadSettings = loadSettings;
		this.#limiter = limiter;
	}

	async understand(input: VideoUnderstandInput, options: UnderstandOptions): Promise<VideoUnderstandResult> {
		if (options.signal) throwIfAborted(options.signal);
		const config = parsePluginConfig(await this.#loadSettings(PLUGIN_NAME, options.cwd));
		requireConfigured(config, options.requireEnabled ?? true);
		if (!input.question.trim() || input.question.length > MAX_QUESTION_LENGTH) {
			throw new VideoUnderstandError("not_configured", `question must contain 1-${MAX_QUESTION_LENGTH} characters`);
		}
		const release = this.#limiter.acquire(config.limits.concurrency);
		const deadline = createDeadline(config.limits.timeoutSeconds, options.signal);
		let media: AcquiredMedia | undefined;
		try {
			throwIfAborted(deadline.signal);
			options.onPhase?.("resolving_source");
			let source: ResolvedMediaSource;
			if (input.source.kind === "url") {
				source = input.source;
			} else if (input.source.kind === "file") {
				source = input.source;
			} else {
				if (!options.resolveAttachment) {
					throw new VideoUnderstandError("permission_denied", "No current-session attachment resolver is available");
				}
				source = { kind: "attachment", path: await options.resolveAttachment(input.source.id) };
			}
			options.onPhase?.("validating_media");
			media = await acquireMedia(source, config, options.cwd, deadline.signal);
			const bytes = await readFile(media.path, { signal: deadline.signal });
			if (bytes.length !== media.sizeBytes || bytes.length > config.limits.maxMediaBytes) {
				throw new VideoUnderstandError("invalid_media", "Media changed or exceeded its validated size before dispatch");
			}
			const actualHash = createHash("sha256").update(bytes).digest("hex");
			if (actualHash !== media.sha256) {
				throw new VideoUnderstandError("invalid_media", "Media changed after validation; no request was dispatched");
			}
			const dataUrl = `data:${media.mimeType};base64,${bytes.toString("base64")}`;
			const encodedBodyBytes = Buffer.byteLength(dataUrl) + Buffer.byteLength(JSON.stringify(input.question)) + 512;
			const encodedBodyLimit = Math.ceil(config.limits.maxMediaBytes / 3) * 4 + MAX_QUESTION_LENGTH * 6 + 4096;
			if (encodedBodyBytes > encodedBodyLimit) {
				throw new VideoUnderstandError("media_too_large_after_encoding", "Encoded video request exceeds the configured memory boundary");
			}
			options.onPhase?.("dispatching");
			const pending = this.#backend.analyze({
				config,
				media,
				dataUrl,
				question: input.question,
				maxOutputTokens: resolveMaxOutputTokens(input.maxOutputTokens, config),
				signal: deadline.signal,
			});
			options.onPhase?.("waiting_for_backend");
			const answer = await pending;
			const result: VideoUnderstandResult = {
				schemaVersion: 1,
				answer: answer.answer,
				provenance: {
					mode: "native-video-url",
					backend: "vllm-openai-compatible",
					model: answer.model,
					mediaSha256: media.sha256,
				},
				media: {
					sizeBytes: media.sizeBytes,
					...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
					...(media.width === undefined ? {} : { width: media.width }),
					...(media.height === undefined ? {} : { height: media.height }),
				},
				...(answer.usage ? { usage: answer.usage } : {}),
				...(answer.finishReason === undefined ? {} : { finishReason: answer.finishReason }),
				warnings: answer.warnings,
			};
			options.onPhase?.("completed");
			return result;
		} catch (error) {
			if (deadline.timedOut()) {
				throw new VideoUnderstandError("timeout", `Video understanding exceeded ${config.limits.timeoutSeconds}s deadline`);
			}
			if (deadline.signal.aborted) throw new VideoUnderstandError("cancelled", "Video understanding was cancelled");
			throw publicError(error, [config.backend.apiKey]);
		} finally {
			if (media) await media.cleanup();
			deadline.dispose();
			release();
		}
	}
}
