import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveVideoAttachment } from "../src/attachments";
import { ConcurrencyLimiter } from "../src/concurrency";
import { sanitizeErrorText } from "../src/errors";

function attachmentContext(entries: unknown[]): ExtensionContext {
	return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

describe("current-session attachments", () => {
	test("resolves only the matching user-owned hidden video source on the branch", () => {
		const ctx = attachmentContext([
			{ type: "message", message: { role: "custom", customType: "video-attachment", display: false, attribution: "user", details: { index: 1, path: "/tmp/one.mp4" } } },
			{ type: "message", message: { role: "custom", customType: "image-attachment", display: false, attribution: "user", details: { index: 2, path: "/tmp/image.png" } } },
			{ type: "message", message: { role: "custom", customType: "video-attachment", display: false, attribution: "agent", details: { index: 3, path: "/tmp/injected.mp4" } } },
		]);
		expect(resolveVideoAttachment("1", ctx)).toBe("/tmp/one.mp4");
		expect(resolveVideoAttachment("[Video #1]", ctx)).toBe("/tmp/one.mp4");
		expect(() => resolveVideoAttachment("2", ctx)).toThrow("not present");
		expect(() => resolveVideoAttachment("3", ctx)).toThrow("not present");
		expect(() => resolveVideoAttachment("../../one", ctx)).toThrow("must identify");
	});
});

describe("resource controls and redaction", () => {
	test("excess concurrency fails and release restores capacity", () => {
		const limiter = new ConcurrencyLimiter();
		const release = limiter.acquire(1);
		expect(() => limiter.acquire(1)).toThrow("limit");
		release();
		release();
		expect(limiter.active).toBe(0);
		expect(() => limiter.acquire(1)).not.toThrow();
	});

	test("removes secrets and complete data URLs from diagnostics", () => {
		const sanitized = sanitizeErrorText("key=secret-value data:video/mp4;base64,AAECAwQ= failed", ["secret-value"]);
		expect(sanitized).not.toContain("secret-value");
		expect(sanitized).not.toContain("AAECAwQ");
		expect(sanitized).toContain("[redacted-secret]");
		expect(sanitized).toContain("[redacted-data-url]");
	});
});
