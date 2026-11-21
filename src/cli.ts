import { testConnection, verifyNativeVideo } from "./actions";

const command = process.argv[2];
const cwd = process.cwd();

if (command !== "test-connection" && command !== "verify-native") {
	console.error("Usage: bun src/cli.ts <test-connection|verify-native>");
	process.exitCode = 2;
} else {
	const result = command === "test-connection" ? await testConnection(cwd) : await verifyNativeVideo(cwd);
	console.log(JSON.stringify(result, null, 2));
	if (result.status === "failed") process.exitCode = 1;
}
