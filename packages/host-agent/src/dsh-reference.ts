/**
 * Aervox｜思隅 @aervox/host-agent — DSH 参考源复核与探测（阶段 6c）
 *
 * 规则依据：reference-design-transfer §1.1（`DSH-01` 固定 commit MIT + 版本锁定）与
 * ADR-010（TC-CONTRACT-STREAM-001：固定 SHA 复核）。本文件把「固定 SHA 复核」从
 * 模拟器骨架升级为**机器可验证**的真实复核：
 * - 父仓库的 submodule gitlink SHA（`git ls-tree HEAD -- reference/deepseek-harness`）
 *   与参考设计登记 SHA 比对——CLI 与 CI 均可执行，无需子模块工作树落地；
 * - 子模块目录存在时读取 package.json（version/license）+ LICENSE 复核许可证白名单；
 * - 参考仓库为 pnpm monorepo，跑通真实 Turn 需要 `git submodule update --init` +
 *   `pnpm install` + `pnpm build:lib:host`，本模块不隐式构建；未就绪时给出指引而非失败。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAdapterManifest } from "@aervox/agent-loop";
import type { AdapterManifest } from "@aervox/agent-loop";

/** DSH-01 固定参考 commit（reference-design-transfer §1.1 登记） */
export const DSH_REFERENCE_SHA = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";

/** 参考仓库相对父仓库根目录的路径 */
export const DSH_REFERENCE_RELATIVE_PATH = "reference/deepseek-harness";

export interface DSHReferenceProbeResult {
  /** true = 子模块目录就绪 且 gitlink SHA 复核通过 且许可证白名单通过 */
  ready: boolean;
  /** 复核通过后的 manifest（ready=false 时仍可能返回供审计的半成品） */
  manifest?: AdapterManifest;
  /** 未就绪原因（ready=false 时填充）：submodule_missing / sha_mismatch / license_not_allowed / pkg_unreadable */
  reason?: string;
}

/** 读取父仓库登记的子模块 gitlink SHA（无工作树依赖，机器可复核） */
function readGitlinkSha(repoRoot: string, subPath: string): string | undefined {
  try {
    const out = execFileSync("git", ["ls-tree", "-z", "HEAD", "--", subPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 64 * 1024,
    });
    // 格式：<mode> <type> <sha>\t<path>\0
    const entry = out.split("\0")[0];
    if (!entry) return undefined;
    const sha = entry.split(/\s+/)[2];
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * DSH 参考源复核：
 * 1) gitlink SHA（父仓库登记）与 DSH_REFERENCE_SHA 一致；
 * 2) 子模块目录存在且 package.json 可读（版本/许可证）；
 * 3) verifyAdapterManifest 许可证白名单（MIT 等）。
 * 真实 Turn 需参考仓库构建，本函数不触发构建；未就绪时 reason 携带指引。
 */
export function probeDSHReference(
  repoRoot: string,
  relativePath = DSH_REFERENCE_RELATIVE_PATH,
): DSHReferenceProbeResult {
  const gitlinkSha = readGitlinkSha(repoRoot, relativePath);
  if (!gitlinkSha) {
    return { ready: false, reason: "submodule_missing（需 `git submodule update --init reference/deepseek-harness`）" };
  }
  if (gitlinkSha !== DSH_REFERENCE_SHA) {
    return { ready: false, reason: `sha_mismatch: gitlink=${gitlinkSha} expected=${DSH_REFERENCE_SHA}（参考 commit 已漂移，核对 reference-design-transfer §1.1）` };
  }

  const dir = join(repoRoot, relativePath);
  let pkg: { name?: string; version?: string; license?: string };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: string; version?: string; license?: string };
  } catch {
    return { ready: false, reason: "pkg_unreadable（子模块未落地：需 `git submodule update --init reference/deepseek-harness`）" };
  }
  const manifest: AdapterManifest = {
    adapterId: "dsh",
    version: pkg.version ?? "unknown",
    sha256: gitlinkSha,
    license: pkg.license ?? "unknown",
    terminationPolicy: "any",
  };
  const verification = verifyAdapterManifest(manifest, { adapterId: "dsh", sha256: DSH_REFERENCE_SHA });
  if (!verification.ok) {
    const reason =
      verification.error === "sha_mismatch"
        ? `sha_mismatch: gitlink=${gitlinkSha} expected=${DSH_REFERENCE_SHA}`
        : verification.error === "license_not_allowed"
          ? `license_not_allowed: ${manifest.license}`
          : `admission_rejected: ${verification.error}`;
    return { ready: false, reason, manifest };
  }
  return { ready: true, manifest };
}