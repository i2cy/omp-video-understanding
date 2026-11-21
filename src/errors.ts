import type { VideoUnderstandErrorCode } from "./types";

const DATA_URL_PATTERN = /data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+;base64,[a-z0-9+/=\s]+/gi;

export function sanitizeErrorText(value: string, secrets: readonly string[] = []): string {
	let text = value.replace(DATA_URL_PATTERN, "[redacted-data-url]");
	for (const secret of secrets) {
		if (secret) text = text.replaceAll(secret, "[redacted-secret]");
	}
	return text.slice(0, 500);
}

export class VideoUnderstandError extends Error {
	readonly code: VideoUnderstandErrorCode;

	constructor(code: VideoUnderstandErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "VideoUnderstandError";
		this.code = code;
	}
}

export function publicError(error: unknown, secrets: readonly string[] = []): VideoUnderstandError {
	if (error instanceof VideoUnderstandError) {
		return new VideoUnderstandError(
			error.code,
			sanitizeErrorText(error.message, secrets),
		);
	}
	if (error instanceof Error && error.name === "AbortError") {
		return new VideoUnderstandError("cancelled", "Operation cancelled");
	}
	const message = error instanceof Error ? error.message : "Unknown video understanding error";
	return new VideoUnderstandError(
		"backend_protocol_error",
		sanitizeErrorText(message, secrets),
	);
}
