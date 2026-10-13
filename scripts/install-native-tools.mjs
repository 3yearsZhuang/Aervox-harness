import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../mise.toml", import.meta.url), "utf8");
const version = config.match(/^rust = "(\d+\.\d+\.\d+)"$/mu)?.[1];
if (!version) throw new Error("Missing pinned Rust version in mise.toml");
execFileSync("rustup", ["component", "add", "--toolchain", version, "rustfmt", "clippy"], { stdio: "inherit" });
