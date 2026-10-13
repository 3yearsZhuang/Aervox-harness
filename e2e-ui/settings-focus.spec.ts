/**
 * Aervox｜思隅 UI E2E — 设置弹层焦点归还
 *
 * 回归：点击顶栏「打开设置」按钮（WorkbenchHeader.vue，aria-label="打开设置"）
 * 打开设置弹层（SettingsModal → AervoxNavDialog → ElDialog，title="设置"），
 * 按 Escape 关闭后焦点归还到触发按钮。
 */
import { test, expect, openWorkbench } from "./fixtures";

test.describe("设置弹层焦点归还", () => {
  test("打开设置 → Escape 关闭 → 焦点回到「打开设置」按钮", async ({
    page,
    servers,
  }) => {
    await openWorkbench(page, servers.webUrl);

    const trigger = page.getByRole("button", { name: "打开设置" });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
