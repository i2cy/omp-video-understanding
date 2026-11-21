import path from "node:path";
import { VideoUnderstandError } from "./errors";
import {
	CONFIG_SCHEMA_VERSION,
	type BackendConfig,
	type VideoLimits,
	type VideoPluginConfig,
	type VideoSourcesConfig,
} from "./types";

const KNOWN_KEYS: Record<string, true> = {
	schemaVersion: true,
	enabled: true,
	backendType: true,
	baseUrl: true,
	model: true,
	apiKey: true,
	timeoutSeconds: true,
	maxMediaBytes: true,
	maxDurationSeconds: true,
	maxOutputTokens: true,
	concurrency: true,
	allowLocalFiles: true,
	localRoots: true,
	allowRemoteUrls: true,
	allowedRemoteDomains: true,
};

const DEFAULTS = {
	schemaVersion: 1,
	enabled: false,
	backendType: "vllm-video-url",
	baseUrl: "",
	model: "",
	apiKey: "",
	timeoutSeconds: 180,
	maxMediaBytes: 67_108_864,
	maxDurationSeconds: 600,
	maxOutputTokens: 1024,
	concurrency: 1,
	allowLocalFiles: true,
	localRoots: "",
	allowRemoteUrls: false,
	allowedRemoteDomains: "",
} as const;

function invalid(message: string): never {
	throw new VideoUnderstandError("not_configured", message);
}

function readString(raw: Record<string, unknown>, key: keyof typeof DEFAULTS): string {
	const value = raw[key] === undefined ? DEFAULTS[key] : raw[key];
	if (typeof value !== "string") invalid(`${key} must be a string`);
	return value;
}

function readBoolean(raw: Record<string, unknown>, key: keyof typeof DEFAULTS): boolean {
	const value = raw[key] === undefined ? DEFAULTS[key] : raw[key];
	if (typeof value !== "boolean") invalid(`${key} must be a boolean`);
	return value;
}

function readNumber(
	raw: Record<string, unknown>,
	key: keyof typeof DEFAULTS,
	min: number,
	max: number,
): number {
	const value = raw[key] === undefined ? DEFAULTS[key] : raw[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		invalid(`${key} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function readStringArray(value: string, key: string): string[] {
	if (!value.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		invalid(`${key} must be a JSON array of strings`);
	}
	if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !item.trim())) {
		invalid(`${key} must be a JSON array of non-empty strings`);
	}
	return [...new Set((parsed as string[]).map(item => item.trim()))];
}

function normalizeBaseUrl(value: string): string {
	if (!value.trim()) return "";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		invalid("baseUrl must be an absolute HTTP(S) URL");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
		invalid("baseUrl must be HTTP(S) without credentials, query, or fragment");
	}
	return url.toString().replace(/\/+$/, "");
}

function normalizeRoots(value: string): readonly string[] {
	const roots = readStringArray(value, "localRoots");
	for (const root of roots) {
		if (!path.isAbsolute(root) || root.includes("\0")) {
			invalid("localRoots entries must be absolute paths without NUL bytes");
		}
	}
	return Object.freeze(roots);
}

function normalizeDomains(value: string): readonly string[] {
	const domains = readStringArray(value, "allowedRemoteDomains");
	return Object.freeze(domains.map(domain => {
		let url: URL;
		try {
			url = new URL(`https://${domain}`);
		} catch {
			invalid("allowedRemoteDomains entries must be valid hostnames");
		}
		if (url.hostname !== domain.toLowerCase() || url.port || url.pathname !== "/" || domain.includes("*")) {
			invalid("allowedRemoteDomains entries must be exact hostnames without ports or wildcards");
		}
		return url.hostname;
	}));
}

/** Parse the flat OMP manifest settings into an immutable per-call snapshot. */
export function parsePluginConfig(
	raw: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): VideoPluginConfig {
	const unknown = Object.keys(raw).filter(key => !KNOWN_KEYS[key]);
	if (unknown.length) invalid(`Unknown plugin setting(s): ${unknown.sort().join(", ")}`);

	const schemaVersion = readNumber(raw, "schemaVersion", 1, 1);
	if (schemaVersion !== CONFIG_SCHEMA_VERSION) invalid(`Unsupported configuration schemaVersion ${schemaVersion}`);
	const backendType = readString(raw, "backendType");
	if (backendType !== "vllm-video-url") {
		throw new VideoUnderstandError("unsupported_backend", `Unsupported backend type: ${backendType}`);
	}

	const backend: BackendConfig = Object.freeze({
		type: backendType,
		baseUrl: normalizeBaseUrl(readString(raw, "baseUrl")),
		model: readString(raw, "model").trim(),
		apiKey: raw.apiKey === undefined ? (env.OMP_VIDEO_API_KEY ?? "") : readString(raw, "apiKey"),
	});
	const limits: VideoLimits = Object.freeze({
		timeoutSeconds: readNumber(raw, "timeoutSeconds", 1, 3600),
		maxMediaBytes: readNumber(raw, "maxMediaBytes", 1024, 536_870_912),
		maxDurationSeconds: readNumber(raw, "maxDurationSeconds", 1, 3600),
		maxOutputTokens: readNumber(raw, "maxOutputTokens", 1, 8192),
		concurrency: readNumber(raw, "concurrency", 1, 8),
	});
	const sources: VideoSourcesConfig = Object.freeze({
		allowLocalFiles: readBoolean(raw, "allowLocalFiles"),
		localRoots: normalizeRoots(readString(raw, "localRoots")),
		allowRemoteUrls: readBoolean(raw, "allowRemoteUrls"),
		allowedRemoteDomains: normalizeDomains(readString(raw, "allowedRemoteDomains")),
	});
	return Object.freeze({ schemaVersion: CONFIG_SCHEMA_VERSION, enabled: readBoolean(raw, "enabled"), backend, limits, sources });
}

export function requireConfigured(config: VideoPluginConfig, requireEnabled = true): void {
	if (requireEnabled && !config.enabled) {
		throw new VideoUnderstandError("disabled", "Native video understanding is disabled");
	}
	if (!config.backend.baseUrl || !config.backend.model) {
		throw new VideoUnderstandError("not_configured", "Configure backend baseUrl and model before running video requests");
	}
}

export function resolveMaxOutputTokens(requested: number | undefined, config: VideoPluginConfig): number {
	if (requested === undefined) return config.limits.maxOutputTokens;
	if (!Number.isInteger(requested) || requested < 1) {
		throw new VideoUnderstandError("not_configured", "maxOutputTokens must be a positive integer");
	}
	return Math.min(requested, config.limits.maxOutputTokens);
}

export const manifestDefaults: Readonly<Record<string, unknown>> = DEFAULTS;
