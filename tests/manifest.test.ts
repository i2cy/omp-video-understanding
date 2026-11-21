import { describe, expect, test } from "bun:test";
import { parsePluginConfig } from "../src/config";
import manifest from "../package.json";

describe("OMP plugin manifest", () => {
	test("published defaults are safe and match the runtime parser", () => {
		const settings = manifest.omp.settings;
		const defaults = Object.fromEntries(Object.entries(settings).map(([key, schema]) => [key, "default" in schema ? schema.default : undefined]));
		const config = parsePluginConfig(defaults, {});
		expect(config.enabled).toBe(false);
		expect(config.sources.allowRemoteUrls).toBe(false);
		expect(config.sources.localRoots).toEqual([]);
		expect(settings.apiKey.secret).toBe(true);
	});

});
