export const PLUGIN_NAME = "omp-video-understanding";
export const CONFIG_SCHEMA_VERSION = 1 as const;
export const MAX_QUESTION_LENGTH = 16_000;

export type VideoSource =
	| { kind: "file"; path: string }
	| { kind: "attachment"; id: string }
	| { kind: "url"; url: string };

export interface VideoUnderstandInput {
	source: VideoSource;
	question: string;
	maxOutputTokens?: number;
}

export type VideoUnderstandPhase =
	| "resolving_source"
	| "validating_media"
	| "dispatching"
	| "waiting_for_backend"
	| "completed";

export interface VideoProvenance {
	mode: "native-video-url";
	backend: "vllm-openai-compatible";
	model: string;
	mediaSha256: string;
}

export interface VideoMediaResult {
	sizeBytes: number;
	durationMs?: number;
	width?: number;
	height?: number;
}

export interface VideoUnderstandResult {
	schemaVersion: 1;
	answer: string;
	provenance: VideoProvenance;
	media: VideoMediaResult;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
	};
	finishReason?: string;
	warnings: string[];
}

export interface VideoUnderstandFailure {
	schemaVersion: 1;
	error: {
		code: VideoUnderstandErrorCode;
		message: string;
	};
}

export type VideoUnderstandDetails =
	| VideoUnderstandResult
	| VideoUnderstandFailure
	| { phase: VideoUnderstandPhase };

export interface BackendConfig {
	type: "vllm-video-url";
	baseUrl: string;
	model: string;
	apiKey: string;
}

export interface VideoLimits {
	timeoutSeconds: number;
	maxMediaBytes: number;
	maxDurationSeconds: number;
	maxOutputTokens: number;
	concurrency: number;
}

export interface VideoSourcesConfig {
	allowLocalFiles: boolean;
	localRoots: readonly string[];
	allowRemoteUrls: boolean;
	allowedRemoteDomains: readonly string[];
}

export interface VideoPluginConfig {
	schemaVersion: 1;
	enabled: boolean;
	backend: BackendConfig;
	limits: VideoLimits;
	sources: VideoSourcesConfig;
}

export interface AcquiredMedia {
	path: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	durationMs?: number;
	width?: number;
	height?: number;
	cleanup: () => Promise<void>;
}

export interface NativeVideoRequest {
	config: VideoPluginConfig;
	media: AcquiredMedia;
	dataUrl: string;
	question: string;
	maxOutputTokens: number;
	signal: AbortSignal;
}

export interface BackendAnswer {
	answer: string;
	model: string;
	finishReason?: string;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
	};
	warnings: string[];
}

export interface NativeVideoBackend {
	analyze(request: NativeVideoRequest): Promise<BackendAnswer>;
}

export type VideoUnderstandErrorCode =
	| "not_configured"
	| "disabled"
	| "permission_denied"
	| "invalid_media"
	| "media_too_large"
	| "media_too_large_after_encoding"
	| "media_too_long"
	| "unsupported_backend"
	| "backend_unreachable"
	| "backend_authentication_failed"
	| "backend_rejected_video"
	| "backend_protocol_error"
	| "timeout"
	| "cancelled"
	| "concurrency_limit";

export interface CapabilityTestResult {
	status: "reachable" | "nativeVideoVerified" | "failed";
	reachable: boolean;
	nativeVideoVerified: boolean;
	lastError?: { code: VideoUnderstandErrorCode; message: string };
	lastCheckedAt: string;
	details?: VideoUnderstandResult;
}
