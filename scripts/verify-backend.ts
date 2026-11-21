import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const baseUrl = process.env.OMP_VIDEO_BASE_URL;
const model = process.env.OMP_VIDEO_MODEL;
if (!baseUrl || !model) {
	throw new Error("Set OMP_VIDEO_BASE_URL and OMP_VIDEO_MODEL before running backend acceptance");
}

const sandbox = await mkdtemp(path.join(tmpdir(), "omp-video-acceptance-"));
try {
	process.env.XDG_DATA_HOME = sandbox;
	// Runtime modules must load after XDG_DATA_HOME is redirected to the disposable profile.
	const { PluginManager } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins");
	const { testConnection, verifyNativeVideo } = await import("../src/actions.ts");
	const manager = new PluginManager(process.cwd());
	await manager.setPluginSetting("omp-video-understanding", "baseUrl", baseUrl);
	await manager.setPluginSetting("omp-video-understanding", "model", model);
	await manager.setPluginSetting("omp-video-understanding", "timeoutSeconds", 90);
	const connection = await testConnection(process.cwd());
	const native = connection.status === "reachable" ? await verifyNativeVideo(process.cwd()) : undefined;
	console.log(JSON.stringify({ connection, native }, null, 2));
	if (native?.status !== "nativeVideoVerified") process.exitCode = 1;
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
