import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/generate-native-protocol.mjs", import.meta.url)), "--check"], { cwd: root, stdio: "inherit" });
execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
