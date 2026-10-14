/**
 * Aervox｜思隅 UI E2E — 窄窗口侧栏抽屉
 *
 * 回归：视口 390×844（≤760px 触发 narrowSidebar）时工作台侧栏默认折叠为抽屉；
 * 点击「展开侧边栏」按钮展开为覆盖式抽屉（role=dialog + 背景遮罩），焦点移入抽屉；
 * 按 Escape 关闭抽屉，焦点归还到「展开侧边栏」触发按钮。
 *
 * 实现依据：plugins/workbench-ui/src/AervoxWorkbench.vue（展开按钮 aria-label="展开侧边栏"）、
 * packages/ui/src/components/workbench/WorkbenchSidebar.vue（Escape 关闭 + 焦点归还 watch）。
 */
import { test, expect, openWorkbench } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("窄窗口侧栏抽屉", () => {
  test("展开抽屉 → Escape 关闭 → 焦点归还触发按钮", async ({
    page,
    servers,
  }) => {
    // 工作台默认进入桌宠陪伴模式（无侧栏）；窄屏抽屉属于标准模式，先经存储播种
    await page.addInitScript(() => {
      window.localStorage.setItem("aervox-workbench-mode", "standard");
    });
    await openWorkbench(page, servers.webUrl);

    const sidebar = page.locator("#workbench-sidebar");
    const expandButton = page.getByRole("button", { name: "展开侧边栏" });

    // 初始：窄窗口下侧栏折叠（inert），展开按钮可见
    await expect(expandButton).toBeVisible();
    await expect(sidebar).toHaveClass(/is-collapsed/);
    await expect(sidebar).toHaveAttribute("inert", "");

    // 展开：抽屉以 dialog 形式覆盖，背景遮罩出现，焦点移入抽屉内部
    await expandButton.click();
    await expect(sidebar).not.toHaveClass(/is-collapsed/);
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(sidebar).toHaveAttribute("role", "dialog");
    await expect(page.locator(".sidebar-backdrop")).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "折叠侧边栏" }),
    ).toBeFocused();

    // Escape 关闭抽屉，焦点归还到「展开侧边栏」触发按钮
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveClass(/is-collapsed/);
    await expect(page.locator(".sidebar-backdrop")).toBeHidden();
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toBeFocused();
  });
});
