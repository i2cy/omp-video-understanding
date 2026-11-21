import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { VideoUnderstandError } from "./errors";

/** Resolve only a video attachment recorded on the current session branch. */
export function resolveVideoAttachment(id: string, ctx: ExtensionContext): string {
	const match = /^(?:\[Video #([1-9]\d*)\]|Video #([1-9]\d*)|#?([1-9]\d*))$/i.exec(id.trim());
	const index = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
	if (!Number.isSafeInteger(index) || index < 1) {
		throw new VideoUnderstandError("permission_denied", "Attachment id must identify a current [Video #N] attachment");
	}
	const branch = ctx.sessionManager.getBranch();
	for (let position = branch.length - 1; position >= 0; position -= 1) {
		const entry = branch[position];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (
			message.role !== "custom" ||
			message.customType !== "video-attachment" ||
			message.display !== false ||
			message.attribution !== "user"
		) continue;
		const details: unknown = message.details;
		if (typeof details !== "object" || details === null) continue;
		const candidate = details as Record<string, unknown>;
		if (candidate.index === index && typeof candidate.path === "string" && candidate.path) {
			return candidate.path;
		}
	}
	throw new VideoUnderstandError("permission_denied", "Video attachment is not present in the current session");
}
