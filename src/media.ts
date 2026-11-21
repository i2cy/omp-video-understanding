import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeadline, throwIfAborted } from "./deadline";
import { VideoUnderstandError } from "./errors";
import type { AcquiredMedia, VideoPluginConfig } from "./types";

export type ResolvedMediaSource =
	| { kind: "file" | "attachment"; path: string }
	| { kind: "url"; url: string };

type MediaDetails = Omit<AcquiredMedia, "path" | "cleanup">;

const TEMP_PREFIX = "omp-video-understanding-";
const SIGNATURE_READ_BYTES = 64 * 1024;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

function permissionDenied(message: string): never {
	throw new VideoUnderstandError("permission_denied", message);
}

function invalidMedia(message: string, options?: ErrorOptions): never {
	throw new VideoUnderstandError("invalid_media", message, options);
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalRegularFile(filePath: string): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(filePath);
		const info = await stat(canonical);
		if (!info.isFile()) invalidMedia("Media source must be a regular file");
		return canonical;
	} catch (error) {
		if (error instanceof VideoUnderstandError) throw error;
		invalidMedia("Media source does not resolve to a readable regular file", { cause: error });
	}
}

async function resolveLocalSource(
	source: Extract<ResolvedMediaSource, { kind: "file" | "attachment" }>,
	config: VideoPluginConfig,
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	if (source.kind === "file" && !config.sources.allowLocalFiles) {
		permissionDenied("Local file media sources are disabled");
	}
	const canonical = await canonicalRegularFile(path.resolve(cwd, source.path));
	throwIfAborted(signal);
	if (source.kind === "attachment") return canonical;
	if (config.sources.localRoots.length === 0) {
		permissionDenied("No local media roots are configured");
	}

	let roots: string[];
	try {
		roots = await Promise.all(
			config.sources.localRoots.map(async (root) => realpath(path.resolve(cwd, root))),
		);
	} catch (error) {
		throw new VideoUnderstandError("permission_denied", "A configured local media root cannot be resolved", {
			cause: error,
		});
	}
	throwIfAborted(signal);
	if (!roots.some((root) => isWithinRoot(root, canonical))) {
		permissionDenied("Media file is outside the configured local roots");
	}
	return canonical;
}

function readEbmlDocType(bytes: Buffer): string | undefined {
	for (let index = 0; index + 3 < bytes.length; index += 1) {
		if (bytes[index] !== 0x42 || bytes[index + 1] !== 0x82) continue;
		const sizeOffset = index + 2;
		const first = bytes[sizeOffset];
		if (first === undefined || first === 0) continue;
		let length = 1;
		let marker = 0x80;
		while ((first & marker) === 0 && length < 8) {
			length += 1;
			marker >>= 1;
		}
		if (length === 8 && (first & marker) === 0) continue;
		let size = first & (marker - 1);
		if (sizeOffset + length > bytes.length) continue;
		for (let offset = 1; offset < length; offset += 1) {
			const next = bytes[sizeOffset + offset];
			if (next === undefined) return undefined;
			size = size * 256 + next;
		}
		if (!Number.isSafeInteger(size) || size > 64) continue;
		const valueOffset = sizeOffset + length;
		if (valueOffset + size > bytes.length) continue;
		return bytes.toString("ascii", valueOffset, valueOffset + size).toLowerCase();
	}
	return undefined;
}

async function detectMimeType(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	try {
		const bytes = Buffer.alloc(SIGNATURE_READ_BYTES);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const header = bytes.subarray(0, bytesRead);
		if (
			header.length >= 12 &&
			header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
			header.toString("ascii", 8, 12) === "AVI "
		) {
			return "video/x-msvideo";
		}
		if (
			header.length >= 4 &&
			header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3
		) {
			const docType = readEbmlDocType(header);
			if (docType === "webm") return "video/webm";
			if (docType === "matroska") return "video/x-matroska";
			invalidMedia("Unrecognized EBML video document type");
		}
		if (header.length >= 12 && header.toString("ascii", 4, 8) === "ftyp") {
			return header.toString("ascii", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
		}
		invalidMedia("Unrecognized video container signature");
	} catch (error) {
		if (error instanceof VideoUnderstandError) throw error;
		invalidMedia("Unable to read the video container signature", { cause: error });
	} finally {
		await handle.close();
	}
}

async function hashLocalFile(
	filePath: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ sizeBytes: number; sha256: string }> {
	const hash = createHash("sha256");
	let sizeBytes = 0;
	const input = createReadStream(filePath, { signal });
	for await (const chunk of input) {
		throwIfAborted(signal);
		const bytes = chunk as Buffer;
		sizeBytes += bytes.length;
		if (sizeBytes > maxBytes) {
			throw new VideoUnderstandError("media_too_large", `Media exceeds the ${maxBytes} byte limit`);
		}
		hash.update(bytes);
	}
	throwIfAborted(signal);
	return { sizeBytes, sha256: hash.digest("hex") };
}

interface ProbeOutput {
	streams?: Array<{
		codec_type?: unknown;
		width?: unknown;
		height?: unknown;
		duration?: unknown;
	}>;
	format?: { duration?: unknown };
}

async function probeMedia(
	filePath: string,
	signal: AbortSignal,
): Promise<{ durationMs: number; width?: number; height?: number }> {
	throwIfAborted(signal);
	const child = spawn(
		"ffprobe",
		[
			"-v", "error",
			"-select_streams", "v:0",
			"-show_entries", "stream=codec_type,width,height,duration:format=duration",
			"-of", "json",
			"-i", filePath,
		],
		{ shell: false, stdio: ["ignore", "pipe", "pipe"] },
	);
	const abort = () => {
		child.kill("SIGKILL");
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();

	try {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < PROBE_OUTPUT_LIMIT) stdout += chunk.slice(0, PROBE_OUTPUT_LIMIT - stdout.length);
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < PROBE_OUTPUT_LIMIT) stderr += chunk.slice(0, PROBE_OUTPUT_LIMIT - stderr.length);
		});
		const completion = Promise.withResolvers<void>();
		child.once("error", completion.reject);
		child.once("close", (code) => {
			if (code === 0) completion.resolve();
			else completion.reject(new Error(`ffprobe exited with status ${code ?? "unknown"}`));
		});
		await completion.promise;
		throwIfAborted(signal);
		let output: ProbeOutput;
		try {
			output = JSON.parse(stdout) as ProbeOutput;
		} catch (error) {
			invalidMedia("ffprobe returned invalid media metadata", { cause: error });
		}
		const video = output.streams?.find((stream) => stream.codec_type === "video");
		if (!video) invalidMedia("Media does not contain a video stream");
		const rawDuration = output.format?.duration ?? video.duration;
		const durationSeconds = typeof rawDuration === "string" || typeof rawDuration === "number"
			? Number(rawDuration)
			: Number.NaN;
		if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
			invalidMedia("Media duration is missing or invalid");
		}
		const dimension = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
		const width = dimension(video.width);
		const height = dimension(video.height);
		return {
			durationMs: Math.round(durationSeconds * 1000),
			...(width === undefined ? {} : { width }),
			...(height === undefined ? {} : { height }),
		};
	} catch (error) {
		if (signal.aborted) throwIfAborted(signal);
		if (error instanceof VideoUnderstandError) throw error;
		invalidMedia("ffprobe could not validate the video container", { cause: error });
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

async function validateMedia(
	filePath: string,
	config: VideoPluginConfig,
	signal: AbortSignal,
	knownHash?: { sizeBytes: number; sha256: string },
): Promise<MediaDetails> {
	throwIfAborted(signal);
	let info;
	try {
		info = await stat(filePath);
	} catch (error) {
		invalidMedia("Unable to inspect media file", { cause: error });
	}
	if (!info.isFile()) invalidMedia("Media source must be a regular file");
	if (info.size > config.limits.maxMediaBytes) {
		throw new VideoUnderstandError(
			"media_too_large",
			`Media exceeds the ${config.limits.maxMediaBytes} byte limit`,
		);
	}
	const mimeType = await detectMimeType(filePath);
	throwIfAborted(signal);
	const hashed = knownHash ?? await hashLocalFile(filePath, config.limits.maxMediaBytes, signal);
	const probed = await probeMedia(filePath, signal);
	if (probed.durationMs > config.limits.maxDurationSeconds * 1000) {
		throw new VideoUnderstandError(
			"media_too_long",
			`Media exceeds the ${config.limits.maxDurationSeconds} second duration limit`,
		);
	}
	return { mimeType, ...hashed, ...probed };
}

function ipv4InCidr(address: number, network: number, prefix: number): boolean {
	if (prefix === 0) return true;
	const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
	return (address & mask) === (network & mask);
}

function ipv4Number(address: string): number {
	const parts = address.split(".").map(Number);
	return (((parts[0] ?? 0) * 256 + (parts[1] ?? 0)) * 256 + (parts[2] ?? 0)) * 256 + (parts[3] ?? 0);
}

function isPublicIpv4(address: string): boolean {
	const value = ipv4Number(address);
	const cidr = (network: string, prefix: number) => ipv4InCidr(value, ipv4Number(network), prefix);
	return !(
		cidr("0.0.0.0", 8) ||
		cidr("10.0.0.0", 8) ||
		cidr("100.64.0.0", 10) ||
		cidr("127.0.0.0", 8) ||
		cidr("169.254.0.0", 16) ||
		cidr("172.16.0.0", 12) ||
		cidr("192.0.0.0", 24) ||
		cidr("192.0.2.0", 24) ||
		cidr("192.88.99.0", 24) ||
		cidr("192.168.0.0", 16) ||
		cidr("198.18.0.0", 15) ||
		cidr("198.51.100.0", 24) ||
		cidr("203.0.113.0", 24) ||
		cidr("224.0.0.0", 4) ||
		cidr("240.0.0.0", 4)
	);
}

function ipv6Words(address: string): number[] | undefined {
	let normalized = address.toLowerCase();
	const lastColon = normalized.lastIndexOf(":");
	const tail = normalized.slice(lastColon + 1);
	if (tail.includes(".")) {
		if (!isIP(tail) || !tail.includes(".")) return undefined;
		const ipv4 = ipv4Number(tail);
		normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return undefined;
	const left = (halves[0] ?? "").split(":").filter(Boolean);
	const right = (halves[1] ?? "").split(":").filter(Boolean);
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
	const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
	if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part))) return undefined;
	return parts.map((part) => Number.parseInt(part, 16));
}

function isPublicIpv6(address: string): boolean {
	const words = ipv6Words(address);
	if (!words) return false;
	const first = words[0] ?? 0;
	const second = words[1] ?? 0;
	const third = words[2] ?? 0;
	const fourth = words[3] ?? 0;
	const prefix80 = words.slice(0, 5).every((word) => word === 0);
	const prefix96 = words.slice(0, 6).every((word) => word === 0);
	if (prefix80 && (words[5] ?? 0) === 0xffff) {
		const high = words[6] ?? 0;
		const low = words[7] ?? 0;
		return isPublicIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
	}
	// Unspecified, IPv4-compatible, loopback, discard-only, and transition mechanisms.
	if (prefix96 || (first === 0x64 && second === 0xff9b) || (first === 0x100 && second === 0 && third === 0 && fourth === 0)) {
		return false;
	}
	if ((first & 0xfe00) === 0xfc00) return false; // Unique local.
	if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false; // Link/site local.
	if ((first & 0xff00) === 0xff00) return false; // Multicast.
	if (first === 0x2001 && (second & 0xfe00) === 0) return false; // IETF special use.
	if (first === 0x2001 && second === 0x0db8) return false; // Documentation (2001:db8::/32).
	if (first === 0x2002) return false; // 6to4 transition.
	if (first === 0x3fff && (second & 0xf000) === 0) return false; // Documentation (3fff::/20).
	return true;
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isPublicIpv4(address);
	if (family === 6) return isPublicIpv6(address);
	return false;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(new DOMException("Operation cancelled", "AbortError"));
	signal.addEventListener("abort", onAbort, { once: true });
	operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return promise;
}

async function resolvePublicAddress(url: URL, signal: AbortSignal): Promise<{ address: string; family: number }> {
	const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	let addresses;
	try {
		addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
	} catch (error) {
		if (signal.aborted) throwIfAborted(signal);
		invalidMedia("Unable to resolve remote media host", { cause: error });
	}
	if (addresses.length === 0) invalidMedia("Remote media host has no addresses");
	if (addresses.some((entry) => !isPublicAddress(entry.address))) {
		permissionDenied("Remote media host resolves to a non-public address");
	}
	const selected = addresses[0];
	if (!selected) invalidMedia("Remote media host has no addresses");
	return { address: selected.address, family: selected.family };
}

function contentLength(value: string | string[] | undefined, maxBytes: number): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !/^\d+$/.test(value)) invalidMedia("Invalid remote Content-Length");
	const length = Number(value);
	if (!Number.isSafeInteger(length)) invalidMedia("Invalid remote Content-Length");
	if (length > maxBytes) {
		throw new VideoUnderstandError("media_too_large", `Media exceeds the ${maxBytes} byte limit`);
	}
}

function remoteCleanup(directory: string): () => Promise<void> {
	let operation: Promise<void> | undefined;
	return () => {
		operation ??= rm(directory, { recursive: true, force: true });
		return operation;
	};
}

async function acquireRemoteMedia(
	source: Extract<ResolvedMediaSource, { kind: "url" }>,
	config: VideoPluginConfig,
	signal: AbortSignal,
): Promise<AcquiredMedia> {
	if (!config.sources.allowRemoteUrls) permissionDenied("Remote media sources are disabled");
	let url: URL;
	try {
		url = new URL(source.url);
	} catch (error) {
		throw new VideoUnderstandError("permission_denied", "Remote media URL is invalid", { cause: error });
	}
	if (url.protocol !== "https:") permissionDenied("Remote media requires HTTPS");
	if (url.username || url.password) permissionDenied("Remote media URL userinfo is not allowed");
	if (!config.sources.allowedRemoteDomains.some((domain) => domain.toLowerCase() === url.hostname)) {
		permissionDenied("Remote media hostname is not in the allowlist");
	}
	throwIfAborted(signal);
	const selected = await resolvePublicAddress(url, signal);
	const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
		callback(null, selected.address, selected.family);
	};
	const response = await (async () => {
		try {
			const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
			const request = httpsRequest(
				{
					protocol: "https:",
					hostname,
					port: url.port || 443,
					path: `${url.pathname}${url.search}`,
					method: "GET",
					headers: { Host: url.host, Accept: "video/*, application/octet-stream" },
					servername: hostname,
					lookup: pinnedLookup,
					agent: false,
					signal,
				},
				resolve,
			);
			request.once("error", reject);
			request.end();
			return await promise;
		} catch (error) {
			if (signal.aborted) throwIfAborted(signal);
			invalidMedia("Unable to retrieve remote media", { cause: error });
		}
	})();

	let temporaryDirectory: string | undefined;
	try {
		const status = response.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			response.resume();
			permissionDenied("Remote media redirects are not allowed");
		}
		if (status < 200 || status >= 300) {
			response.resume();
			invalidMedia(`Remote media returned HTTP status ${status}`);
		}
		contentLength(response.headers["content-length"], config.limits.maxMediaBytes);
		throwIfAborted(signal);
		temporaryDirectory = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
		const temporaryPath = path.join(temporaryDirectory, "media");
		const hash = createHash("sha256");
		let sizeBytes = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				sizeBytes += chunk.length;
				if (sizeBytes > config.limits.maxMediaBytes) {
					callback(new VideoUnderstandError(
						"media_too_large",
						`Media exceeds the ${config.limits.maxMediaBytes} byte limit`,
					));
					return;
				}
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		await pipeline(
			response,
			meter,
			createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
			{ signal },
		);
		throwIfAborted(signal);
		const details = await validateMedia(
			temporaryPath,
			config,
			signal,
			{ sizeBytes, sha256: hash.digest("hex") },
		);
		throwIfAborted(signal);
		return {
			path: temporaryPath,
			...details,
			cleanup: remoteCleanup(temporaryDirectory),
		};
	} catch (error) {
		response.destroy();
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function acquireMedia(
	source: ResolvedMediaSource,
	config: VideoPluginConfig,
	cwd: string,
	signal: AbortSignal,
): Promise<AcquiredMedia> {
	const deadline = createDeadline(config.limits.timeoutSeconds, signal);
	try {
		throwIfAborted(deadline.signal);
		if (source.kind === "url") return await acquireRemoteMedia(source, config, deadline.signal);
		const filePath = await resolveLocalSource(source, config, cwd, deadline.signal);
		const details = await validateMedia(filePath, config, deadline.signal);
		throwIfAborted(deadline.signal);
		return { path: filePath, ...details, cleanup: async () => undefined };
	} catch (error) {
		if (deadline.timedOut()) {
			throw new VideoUnderstandError("timeout", "Media acquisition timed out", { cause: error });
		}
		throw error;
	} finally {
		deadline.dispose();
	}
}
