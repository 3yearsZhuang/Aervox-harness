/**
 * Aervox｜思隅 @aervox/host-agent — 阶段 6c DSH 参考源复核测试
 *
 * 覆盖 ADR-010 TC-CONTRACT-STREAM-001「固定 SHA 复核」真实化：
 * - 父仓库 gitlink 复核：reference/deepseek-harness 的 gitlink 与 reference-design-transfer
 *   §1.1 登记的固定 SHA（DSH_REFERENCE_SHA）一致 → ready true + manifest（MIT 白名单）；
 * - 未初始化/目录缺失 → reason=submodule_missing（带指引）；
 * - gitlink 缺失（非 git 仓库路径）→ reason=submodule_missing。
 * 注：参考仓库为 pnpm monorepo，真实 Turn 需 `pnpm install && pnpm build:lib:host`，
 * 本阶段不在测试中构建（见 §16.19/ADR-010 实施进展），仅做准入复核的真实化。
 */
import { describe, expect, it } from "vitest";
import { probeDSHReference } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("阶段 6c probeDSHReference（固定 SHA 复核真实化）", () => {
  it("子模块就绪：gitlink 匹配登记 SHA → ready + MIT manifest（许可证白名单）", () => {
    const result = probeDSHReference(repoRoot);
    expect(result.ready).toBe(true);
    expect(result.manifest).toMatchObject({
      adapterId: "dsh",
      license: "MIT",
      terminationPolicy: "any",
    });
    expect(result.manifest?.sha256).toBe(
      "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    );
  });

  it("目录未初始化/不存在 → submodule_missing + 重建指引（不抛错）", () => {
    const missing = probeDSHReference(repoRoot, "reference/does-not-exist");
    expect(missing.ready).toBe(false);
    expect(missing.reason).toContain("submodule_missing");
  });

  it("非 git 仓库根 → 无法读 gitlink → submodule_missing（fail-closed）", () => {
    const notRepo = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
    const result = probeDSHReference(notRepo, "deepseek-harness");
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("submodule_missing");
  });
});