import { afterAll, describe, expect, mock, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { lookup as originalLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as originalDns from "node:dns/promises";
import * as originalHttps from "node:https";
import { VideoUnderstandError } from "../src/errors";
import type { AcquiredMedia, VideoPluginConfig } from "../src/types";

const fixturePath = path.resolve("fixtures/native-motion.mp4");
const fixtureBytes = await readFile(fixturePath);
const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
const temporaryDirectories = new Set<string>();
const requestedPaths: string[] = [];
const sockets = new Set<Socket>();
let slowResponseStarted = Promise.withResolvers<void>();
let fakeServerPort = 0;

const fakeServer = createServer((request, response) => {
	const requestPath = request.url ?? "/";
	requestedPaths.push(requestPath);
	if (requestPath === "/video") {
		response.writeHead(200, { "Content-Length": fixtureBytes.length, "Content-Type": "video/mp4" });
		response.end(fixtureBytes);
		return;
	}
	if (requestPath === "/redirect") {
		response.writeHead(302, { Location: "https://media.example/video" });
		response.end();
		return;
	}
	if (requestPath === "/declared-too-large") {
		response.writeHead(200, { "Content-Length": fixtureBytes.length + 1 });
		response.end(fixtureBytes);
		return;
	}
	if (requestPath === "/chunked-too-large") {
		response.writeHead(200);
		response.end(fixtureBytes);
		return;
	}
	if (requestPath === "/invalid") {
		response.writeHead(200);
		response.end("not a video");
		return;
	}
	if (requestPath === "/slow") {
		response.writeHead(200, { "Content-Type": "video/mp4" });
		response.write(fixtureBytes.subarray(0, 64));
		slowResponseStarted.resolve();
		return;
	}
	response.writeHead(404);
	response.end();
});
fakeServer.on("connection", (socket) => {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
});
const listening = Promise.withResolvers<void>();
fakeServer.listen(0, "127.0.0.1", () => listening.resolve());
await listening.promise;
const address = fakeServer.address();
if (!address || typeof address === "string") throw new Error("Fake media server did not bind to a TCP port");
fakeServerPort = address.port;

async function fakeLookup(hostname: string, options: LookupOptions): Promise<LookupAddress[]> {
	if (hostname.endsWith(".example")) return [{ address: "93.184.216.34", family: 4 }];
	if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
	return originalLookup(hostname, { ...options, all: true });
}

function fakeHttpsRequest(
	options: HttpsRequestOptions,
	callback?: (response: IncomingMessage) => void,
): ClientRequest {
	const forwarded: HttpRequestOptions = {
		...options,
		protocol: "http:",
		hostname: "127.0.0.1",
		port: fakeServerPort,
	};
	delete forwarded.lookup;
	return httpRequest(forwarded, callback);
}

// DNS still returns a public address, while the HTTPS transport is connected to
// the local fake server. This exercises acquireMedia's public API without any
// Internet access or relaxation of its private-address checks.
mock.module("node:dns/promises", () => ({ ...originalDns, lookup: fakeLookup }));
mock.module("node:https", () => ({ ...originalHttps, request: fakeHttpsRequest }));
// Deliberately load after module mocking: a static import would capture the real DNS/HTTPS bindings.
const { acquireMedia } = await import("../src/media.ts");

afterAll(async () => {
	for (const socket of sockets) socket.destroy();
	const closed = Promise.withResolvers<void>();
	fakeServer.close(() => closed.resolve());
	await closed.promise;
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	mock.module("node:dns/promises", () => originalDns);
	mock.module("node:https", () => originalHttps);
});

function makeConfig(options: {
	localRoots?: readonly string[];
	allowLocalFiles?: boolean;
	allowRemoteUrls?: boolean;
	allowedRemoteDomains?: readonly string[];
	maxMediaBytes?: number;
	maxDurationSeconds?: number;
	timeoutSeconds?: number;
} = {}): VideoPluginConfig {
	return {
		schemaVersion: 1,
		enabled: true,
		backend: { type: "vllm-video-url", baseUrl: "https://backend.example/v1", model: "video-model", apiKey: "" },
		limits: {
			timeoutSeconds: options.timeoutSeconds ?? 10,
			maxMediaBytes: options.maxMediaBytes ?? fixtureBytes.length,
			maxDurationSeconds: options.maxDurationSeconds ?? 10,
			maxOutputTokens: 128,
			concurrency: 1,
		},
		sources: {
			allowLocalFiles: options.allowLocalFiles ?? true,
			localRoots: options.localRoots ?? [],
			allowRemoteUrls: options.allowRemoteUrls ?? false,
			allowedRemoteDomains: options.allowedRemoteDomains ?? [],
		},
	};
}

function remoteConfig(maxMediaBytes = fixtureBytes.length, timeoutSeconds = 10): VideoPluginConfig {
	return makeConfig({
		allowRemoteUrls: true,
		allowedRemoteDomains: ["media.example"],
		maxMediaBytes,
		timeoutSeconds,
	});
}

async function makeTestDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "video-media-test-"));
	temporaryDirectories.add(directory);
	return directory;
}

async function remoteTempEntries(): Promise<string[]> {
	return (await readdir(tmpdir()))
		.filter((entry) => entry.startsWith("omp-video-understanding-"))
		.sort();
}

async function expectErrorCode(operation: Promise<AcquiredMedia>, code: VideoUnderstandError["code"]): Promise<void> {
	try {
		await operation;
		throw new Error(`Expected media acquisition to fail with ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(VideoUnderstandError);
		expect((error as VideoUnderstandError).code).toBe(code);
	}
}

describe("local and attachment media security", () => {
	test("allows a canonical file inside a root and identifies it by signature, not extension", async () => {
		const root = await makeTestDirectory();
		const mediaPath = path.join(root, "motion.data");
		await writeFile(mediaPath, fixtureBytes);
		const media = await acquireMedia(
			{ kind: "file", path: "motion.data" },
			makeConfig({ localRoots: [root] }),
			root,
			new AbortController().signal,
		);
		expect(media.path).toBe(mediaPath);
		expect(media.mimeType).toBe("video/mp4");
		expect(media.sizeBytes).toBe(fixtureBytes.length);
		expect(media.sha256).toBe(fixtureHash);
		expect(media.durationMs).toBeGreaterThan(0);
		expect(media.width).toBeGreaterThan(0);
		expect(media.height).toBeGreaterThan(0);
		await media.cleanup();
		await media.cleanup();
		await access(mediaPath);
	});

	test("accepts a parent-resolved attachment without applying localRoots", async () => {
		const media = await acquireMedia(
			{ kind: "attachment", path: fixturePath },
			makeConfig({ allowLocalFiles: false }),
			tmpdir(),
			new AbortController().signal,
		);
		expect(media.sha256).toBe(fixtureHash);
		await media.cleanup();
	});

	test("rejects disabled files, absolute paths outside roots, .. escapes, and prefix siblings", async () => {
		const base = await makeTestDirectory();
		const root = path.join(base, "root");
		const nested = path.join(root, "nested");
		const sibling = `${root}-evil`;
		await mkdir(nested, { recursive: true });
		await mkdir(sibling);
		const outside = path.join(base, "outside.mp4");
		await writeFile(outside, fixtureBytes);
		await writeFile(path.join(sibling, "outside.mp4"), fixtureBytes);
		const signal = new AbortController().signal;
		await expectErrorCode(
			acquireMedia({ kind: "file", path: fixturePath }, makeConfig({ allowLocalFiles: false, localRoots: [root] }), base, signal),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia({ kind: "file", path: outside }, makeConfig({ localRoots: [root] }), base, signal),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia({ kind: "file", path: "../../outside.mp4" }, makeConfig({ localRoots: [root] }), nested, signal),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia({ kind: "file", path: path.join(sibling, "outside.mp4") }, makeConfig({ localRoots: [root] }), base, signal),
			"permission_denied",
		);
	});

	test("rejects a symlink that escapes an allowed root", async () => {
		const base = await makeTestDirectory();
		const root = path.join(base, "root");
		await mkdir(root);
		const outside = path.join(base, "outside.mp4");
		await writeFile(outside, fixtureBytes);
		await symlink(outside, path.join(root, "linked.mp4"));
		await expectErrorCode(
			acquireMedia({ kind: "file", path: "linked.mp4" }, makeConfig({ localRoots: [root] }), root, new AbortController().signal),
			"permission_denied",
		);
	});

	test("enforces size and duration limits", async () => {
		await expectErrorCode(
			acquireMedia(
				{ kind: "attachment", path: fixturePath },
				makeConfig({ maxMediaBytes: fixtureBytes.length - 1 }),
				tmpdir(),
				new AbortController().signal,
			),
			"media_too_large",
		);
		await expectErrorCode(
			acquireMedia(
				{ kind: "attachment", path: fixturePath },
				makeConfig({ maxDurationSeconds: 1 }),
				tmpdir(),
				new AbortController().signal,
			),
			"media_too_long",
		);
	});

	test("rejects invalid content even when its extension is .mp4", async () => {
		const directory = await makeTestDirectory();
		const invalidPath = path.join(directory, "invalid.mp4");
		await writeFile(invalidPath, "this is not an MP4 container");
		await expectErrorCode(
			acquireMedia({ kind: "file", path: invalidPath }, makeConfig({ localRoots: [directory] }), directory, new AbortController().signal),
			"invalid_media",
		);
	});
});

describe("remote media security", () => {
	test("rejects remote URLs by default, HTTP, non-allowlisted hosts, and userinfo", async () => {
		const signal = new AbortController().signal;
		await expectErrorCode(
			acquireMedia({ kind: "url", url: "https://media.example/video" }, makeConfig(), tmpdir(), signal),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia({ kind: "url", url: "http://media.example/video" }, remoteConfig(), tmpdir(), signal),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia(
				{ kind: "url", url: "https://other.example/video" },
				makeConfig({ allowRemoteUrls: true, allowedRemoteDomains: ["media.example"] }),
				tmpdir(),
				signal,
			),
			"permission_denied",
		);
		await expectErrorCode(
			acquireMedia({ kind: "url", url: "https://user:secret@media.example/video" }, remoteConfig(), tmpdir(), signal),
			"permission_denied",
		);
	});

	test("rejects private, loopback, link-local, CGNAT, documentation, reserved, and mapped addresses", async () => {
		const hosts = [
			"127.0.0.1",
			"10.0.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"192.0.2.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"240.0.0.1",
			"[::1]",
			"[::ffff:127.0.0.1]",
			"[fd00::1]",
			"[fe80::1]",
			"[2001:db8::1]",
		];
		for (const host of hosts) {
			const url = `https://${host}/video`;
			const config = makeConfig({
				allowRemoteUrls: true,
				allowedRemoteDomains: [new URL(url).hostname],
			});
			await expectErrorCode(acquireMedia({ kind: "url", url }, config, tmpdir(), new AbortController().signal), "permission_denied");
		}
	});

	test("does not follow redirects", async () => {
		requestedPaths.length = 0;
		await expectErrorCode(
			acquireMedia({ kind: "url", url: "https://media.example/redirect" }, remoteConfig(), tmpdir(), new AbortController().signal),
			"permission_denied",
		);
		expect(requestedPaths).toEqual(["/redirect"]);
	});

	test("downloads with a 0600 temporary file and idempotently removes it on cleanup", async () => {
		const before = await remoteTempEntries();
		const media = await acquireMedia(
			{ kind: "url", url: "https://media.example/video" },
			remoteConfig(),
			tmpdir(),
			new AbortController().signal,
		);
		expect(media.mimeType).toBe("video/mp4");
		expect(media.sizeBytes).toBe(fixtureBytes.length);
		expect(media.sha256).toBe(fixtureHash);
		expect(media.durationMs).toBeGreaterThan(0);
		expect((await stat(media.path)).mode & 0o777).toBe(0o600);
		expect((await remoteTempEntries()).length).toBe(before.length + 1);
		await media.cleanup();
		await media.cleanup();
		expect(await remoteTempEntries()).toEqual(before);
	});

	test("rejects excessive Content-Length and actual streamed bytes without residue", async () => {
		for (const route of ["declared-too-large", "chunked-too-large"]) {
			const before = await remoteTempEntries();
			await expectErrorCode(
				acquireMedia(
					{ kind: "url", url: `https://media.example/${route}` },
					remoteConfig(fixtureBytes.length - 1),
					tmpdir(),
					new AbortController().signal,
				),
				"media_too_large",
			);
			expect(await remoteTempEntries()).toEqual(before);
		}
	});

	test("removes temporary media after container validation fails", async () => {
		const before = await remoteTempEntries();
		await expectErrorCode(
			acquireMedia({ kind: "url", url: "https://media.example/invalid" }, remoteConfig(), tmpdir(), new AbortController().signal),
			"invalid_media",
		);
		expect(await remoteTempEntries()).toEqual(before);
	});

	test("aborts an active download and removes its temporary file", async () => {
		const before = await remoteTempEntries();
		const controller = new AbortController();
		slowResponseStarted = Promise.withResolvers<void>();
		const operation = acquireMedia(
			{ kind: "url", url: "https://media.example/slow" },
			remoteConfig(),
			tmpdir(),
			controller.signal,
		);
		await slowResponseStarted.promise;
		controller.abort();
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
		expect(await remoteTempEntries()).toEqual(before);
	});

	test("times out a stalled download and removes its temporary file", async () => {
		vi.useFakeTimers();
		try {
			const before = await remoteTempEntries();
			slowResponseStarted = Promise.withResolvers<void>();
			const operation = acquireMedia(
				{ kind: "url", url: "https://media.example/slow" },
				remoteConfig(fixtureBytes.length, 1),
				tmpdir(),
				new AbortController().signal,
			);
			await slowResponseStarted.promise;
			vi.advanceTimersByTime(1000);
			await expectErrorCode(operation, "timeout");
			expect(await remoteTempEntries()).toEqual(before);
		} finally {
			vi.useRealTimers();
		}
	});
});
