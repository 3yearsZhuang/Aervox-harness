import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
const targets = (process.env.AERVOX_NATIVE_BUILD_TARGETS ?? "host").split(",");
const platformTargets = { "x86_64-apple-darwin": ["darwin", "x64"], "aarch64-apple-darwin": ["darwin", "arm64"] };
for (const target of targets) {
  if (target !== "host" && (!platformTargets[target] || platformTargets[target][0] !== process.platform)) throw new Error("Unsupported native packaging target");
  const args = ["build", "--release", "--locked", "--jobs", "2", "--manifest-path", "native/Cargo.toml"];
  if (target !== "host") args.push("--target", target);
  execFileSync("cargo", args, { cwd: root, stdio: "inherit" });
  const [platform, arch] = target === "host" ? [process.platform, process.arch] : platformTargets[target];
  const name = platform === "win32" ? "aervox-native.exe" : "aervox-native";
  const directory = join(root, "dist", "bin", `${platform}-${arch}`);
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, name);
  copyFileSync(join(root, "native", "target", ...(target === "host" ? [] : [target]), "release", name), binary);
  writeFileSync(join(directory, "artifact.json"), JSON.stringify({ protocol: 1, version: "0.1.0", platform,
    arch, binary: name, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }, null, 2) + "\n");
}
