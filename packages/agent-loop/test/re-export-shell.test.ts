import { describe, expect, it } from "vitest";
import * as shell from "../src/index.js";
import * as core from "@aervox/core";

describe("agent-loop re-export 壳（ADR-021）", () => {
  it("壳的导出面与 @aervox/core 完全一致", () => {
    const shellKeys = Object.keys(shell).sort();
    const coreKeys = Object.keys(core).sort();
    expect(shellKeys).toEqual(coreKeys);
    expect(shellKeys.length).toBeGreaterThan(0);
  });

  it("关键内核符号可从壳解析且与 core 同引用", () => {
    expect(shell.ControlContext).toBe(core.ControlContext);
    expect(shell.executeTurn).toBe(core.executeTurn);
    expect(shell.AutoApprovalPolicy).toBe(core.AutoApprovalPolicy);
    expect(shell.CliInteractiveApprovalPolicy).toBe(core.CliInteractiveApprovalPolicy);
    expect(shell.HostToolRuntime).toBe(core.HostToolRuntime);
  });
});
