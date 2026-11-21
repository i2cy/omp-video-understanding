import { fileURLToPath } from "node:url";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { parsePluginConfig, requireConfigured } from "./config";
import { createDeadline } from "./deadline";
import { publicError, VideoUnderstandError } from "./errors";
import { VideoUnderstandingService } from "./service";
import { testVllmConnection, VllmVideoBackend } from "./vllm";
import { PLUGIN_NAME, type CapabilityTestResult } from "./types";

const NATIVE_TEST_PATH = fileURLToPath(new URL("../fixtures/native-motion.mp4", import.meta.url));
const NATIVE_TEST_QUESTION = "Answer immediately in one sentence of at most 15 words: which way does the square move horizontally, and what color is it first and later?";

export function verifiesNativeMotionAnswer(answer: string): boolean {
	const normalized = answer.toLowerCase();
	const left = normalized.indexOf("left");
	const right = normalized.indexOf("right");
	const black = normalized.indexOf("black");
	const red = normalized.indexOf("red");
	const rightward = (left >= 0 && right > left) || /\b(?:moves?|moving|shifts?|shifting|travels?)\s+(?:to\s+(?:the\s+)?)?right\b/.test(normalized) || normalized.includes("rightward");
	return rightward && black >= 0 && red > black;
}

function failure(error: unknown, secret = ""): CapabilityTestResult {
	const safe = publicError(error, [secret]);
	return {
		status: "failed",
		reachable: false,
		nativeVideoVerified: false,
		lastError: { code: safe.code, message: safe.message },
		lastCheckedAt: new Date().toISOString(),
	};
}

export async function testConnection(cwd: string, signal?: AbortSignal): Promise<CapabilityTestResult> {
	let apiKey = "";
	try {
		const config = parsePluginConfig(await getPluginSettings(PLUGIN_NAME, cwd));
		apiKey = config.backend.apiKey;
		requireConfigured(config, false);
		const deadline = createDeadline(config.limits.timeoutSeconds, signal);
		try {
			await testVllmConnection(config, deadline.signal);
		} finally {
			deadline.dispose();
		}
		return { status: "reachable", reachable: true, nativeVideoVerified: false, lastCheckedAt: new Date().toISOString() };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError" && !signal?.aborted) {
			return failure(new VideoUnderstandError("timeout", "Connection test exceeded its configured deadline"), apiKey);
		}
		return failure(error, apiKey);
	}
}

export async function verifyNativeVideo(cwd: string, signal?: AbortSignal): Promise<CapabilityTestResult> {
	let apiKey = "";
	try {
		const raw = await getPluginSettings(PLUGIN_NAME, cwd);
		const config = parsePluginConfig(raw);
		apiKey = config.backend.apiKey;
		const service = new VideoUnderstandingService(new VllmVideoBackend(), async () => raw);
		const result = await service.understand(
			{ source: { kind: "attachment", id: "native-self-test" }, question: NATIVE_TEST_QUESTION, maxOutputTokens: Math.min(1024, config.limits.maxOutputTokens) },
			{
				cwd,
				...(signal ? { signal } : {}),
				requireEnabled: false,
				resolveAttachment: () => NATIVE_TEST_PATH,
			},
		);
		if (result.provenance.mode !== "native-video-url" || !verifiesNativeMotionAnswer(result.answer)) {
			throw new VideoUnderstandError("backend_protocol_error", "Backend response did not verify left-to-right motion and black-to-red temporal order");
		}
		return {
			status: "nativeVideoVerified",
			reachable: true,
			nativeVideoVerified: true,
			lastCheckedAt: new Date().toISOString(),
			details: result,
		};
	} catch (error) {
		return failure(error, apiKey);
	}
}
