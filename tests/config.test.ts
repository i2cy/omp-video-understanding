import { describe, expect, test } from "bun:test";
import { parsePluginConfig, requireConfigured, resolveMaxOutputTokens } from "../src/config";
import { VideoUnderstandError } from "../src/errors";

function expectCode(fn: () => unknown, code: VideoUnderstandError["code"]): void {
	try {
		fn();
		throw new Error("expected rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(VideoUnderstandError);
		expect((error as VideoUnderstandError).code).toBe(code);
	}
}

describe("plugin configuration", () => {
	test("safe defaults keep the tool disabled and all sources unconfigured", () => {
		const config = parsePluginConfig({}, {});
		expect(config.enabled).toBe(false);
		expect(config.backend.baseUrl).toBe("");
		expect(config.sources.localRoots).toEqual([]);
		expect(config.sources.allowRemoteUrls).toBe(false);
		expect(config.sources.allowedRemoteDomains).toEqual([]);
		expectCode(() => requireConfigured(config), "disabled");
	});

	test("parses and freezes a complete immutable snapshot", () => {
		const config = parsePluginConfig({
			enabled: true,
			baseUrl: "http://192.168.11.104:18300/v1/",
			model: "qwen3.8-flash-next",
			localRoots: '["/tmp","/srv/media"]',
			allowedRemoteDomains: '["Media.Example.com"]',
			allowRemoteUrls: true,
			maxOutputTokens: 256,
		}, {});
		expect(config.backend.baseUrl).toBe("http://192.168.11.104:18300/v1");
		expect(config.sources.localRoots).toEqual(["/tmp", "/srv/media"]);
		expect(config.sources.allowedRemoteDomains).toEqual(["media.example.com"]);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.backend)).toBe(true);
		expect(Object.isFrozen(config.sources.localRoots)).toBe(true);
		expect(resolveMaxOutputTokens(1024, config)).toBe(256);
		expect(resolveMaxOutputTokens(64, config)).toBe(64);
	});

	test("uses the API key environment fallback only when the stored key is absent", () => {
		expect(parsePluginConfig({}, { OMP_VIDEO_API_KEY: "environment-secret" }).backend.apiKey).toBe("environment-secret");
		expect(parsePluginConfig({ apiKey: "" }, { OMP_VIDEO_API_KEY: "environment-secret" }).backend.apiKey).toBe("");
	});

	test("rejects unknown fields and malformed structured strings", () => {
		expectCode(() => parsePluginConfig({ unexpected: true }, {}), "not_configured");
		expectCode(() => parsePluginConfig({ localRoots: '["relative"]' }, {}), "not_configured");
		expectCode(() => parsePluginConfig({ localRoots: "/tmp" }, {}), "not_configured");
		expectCode(() => parsePluginConfig({ allowedRemoteDomains: '["*.example.com"]' }, {}), "not_configured");
		expectCode(() => parsePluginConfig({ baseUrl: "file:///tmp/backend" }, {}), "not_configured");
		expectCode(() => parsePluginConfig({ backendType: "frames" }, {}), "unsupported_backend");
	});
});
