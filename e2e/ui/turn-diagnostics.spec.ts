import { readFile } from "node:fs/promises";
import { test, expect, openWorkbench } from "./fixtures";

// Exercise the real Turn/SSE/API/UI path with a deterministic provider, never a
// live model or a tool with side effects. Other specs retain their default host.
test.use({ loopProvider: "replay" });
for (const { width, theme } of [{ width: 390, theme: "dark" }, { width: 1280, theme: "light" }]) {
  test(`reply diagnostics, export, deletion and focus: ${theme} ${width}px`, async ({ page, request, servers }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => {
      localStorage.setItem("aervox-workbench-mode", "standard");
      localStorage.setItem("aervox-theme", theme);
      localStorage.setItem("aervox-standard-sidebar-collapsed", "true");
    }, theme);
    await page.route("https://cubism.live2d.com/**", route => route.abort());
    await page.route("https://cdn.jsdelivr.net/**", route => route.abort());
    await openWorkbench(page, servers.webUrl);
    const sidebarToggle = page.getByRole("button", { name: "折叠侧边栏" });
    if (await sidebarToggle.isVisible()) await sidebarToggle.click();
    const secret = "SECRET_DIAGNOSTICS_BODY";
    await page.locator("#aervox-composer").fill(secret);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const entry = page.getByRole("button", { name: "运行详情", exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    const dialog = await page.locator("html").getAttribute("data-design-system") === "material3" ? page.locator('md-dialog[data-aria-label="运行详情"]') : page.getByRole("dialog", { name: "运行详情" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeVisible();
    await expect(dialog).toContainText("模型调用");
    await expect(dialog).toContainText("裁剪报告、插件时间线与工具步骤关联暂无记录");
    await expect(dialog).not.toContainText(secret);
    const downloadEvent = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出诊断摘要" }).click();
    const download = await downloadEvent;
    const report = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(report.selectedAttemptId).toBeTruthy();
    expect(report.modelRuns.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.modelRuns[0].id).toMatch(/^mr_/);
    await dialog.locator(".aervox-dialog-body").evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("run-details.png"), animations: "disabled" });
    expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(entry).toBeFocused();
    expect((await request.get(`${servers.apiUrl}/v1/turns/${encodeURIComponent(report.turnId)}/diagnostics?attemptId=${encodeURIComponent(report.selectedAttemptId)}`)).status()).toBe(200);
    expect((await request.delete(`${servers.apiUrl}/v1/sessions/${encodeURIComponent(report.sessionId)}`)).status()).toBe(204);
    await entry.click();
    await expect(page.getByRole("alert")).toContainText("无法读取运行详情");
    await expect(page.getByRole("button", { name: "导出诊断摘要" })).toBeDisabled();
  });
}
