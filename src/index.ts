import { resolveVideoAttachment } from "./attachments";
import { publicError } from "./errors";
import { VideoUnderstandingService } from "./service";
import { MAX_QUESTION_LENGTH, type VideoUnderstandDetails, type VideoUnderstandInput } from "./types";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function videoUnderstandingExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	const service = new VideoUnderstandingService();
	const sourceSchema = z.union([
		z.object({ kind: z.literal("file"), path: z.string().min(1).describe("Authorized local video path") }),
		z.object({ kind: z.literal("attachment"), id: z.string().min(1).describe("Current session video id, for example 1 for [Video #1]") }),
		z.object({ kind: z.literal("url"), url: z.string().url().describe("HTTPS URL from the configured hostname allowlist") }),
	]);
	pi.registerTool({
		name: "video_understand",
		label: "Native Video Understanding",
		description: "Understand an authorized local, attached, or allowlisted remote video with the configured native video_url backend. Never falls back to frame extraction. Configuration is operator-controlled and cannot be overridden per call.",
		parameters: z.object({
			source: sourceSchema,
			question: z.string().min(1).max(MAX_QUESTION_LENGTH).describe("Question about the video's content or temporal behavior"),
			maxOutputTokens: z.number().int().positive().optional().describe("Requested response token limit; clamped to the operator-configured limit"),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const result = await service.understand(params as VideoUnderstandInput, {
					cwd: ctx.cwd,
					...(signal ? { signal } : {}),
					resolveAttachment: id => resolveVideoAttachment(id, ctx),
					onPhase: phase => onUpdate?.({
						content: [{ type: "text", text: `video_understand: ${phase}` }],
						details: { phase } satisfies VideoUnderstandDetails,
					}),
				});
				pi.logger.debug("video_understand completed", {
					requestId: toolCallId,
					mediaSha256: result.provenance.mediaSha256,
					mediaSizeBytes: result.media.sizeBytes,
					durationMs: result.media.durationMs,
					backend: result.provenance.backend,
					model: result.provenance.model,
					usage: result.usage,
					finishReason: result.finishReason,
				});
				return { content: [{ type: "text", text: result.answer }], details: result };
			} catch (error) {
				const failure = publicError(error);
				pi.logger.debug("video_understand failed", { requestId: toolCallId, errorCode: failure.code });
				return {
					content: [{ type: "text", text: `video_understand failed [${failure.code}]: ${failure.message}` }],
					details: { schemaVersion: 1, error: { code: failure.code, message: failure.message } } satisfies VideoUnderstandDetails,
					isError: true,
				};
			}
		},
	});
}

export * from "./types";
export { parsePluginConfig } from "./config";
export { VideoUnderstandingService } from "./service";
