import { test, expect, openWorkbench } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`sidebar loading, failure and empty states: ${theme}, ${width}px`, async ({ page, servers }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      // These checks exercise navigation; external avatar SDK availability is separate.
      await page.route("https://cubism.live2d.com/**", route => route.abort());
      await page.route("https://cdn.jsdelivr.net/gh/dylanNew/**", route => route.abort());
      await page.addInitScript(() => localStorage.setItem("aervox-workbench-mode", "standard"));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let empty = false;
      await page.route("**/v1/sessions*", async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || url.pathname !== "/v1/sessions") return route.continue();
        if (!empty) await gate;
        await route.fulfill({
          status: empty ? 200 : 503, contentType: "application/json",
          body: JSON.stringify(empty ? { items: [] } : { error: "会话列表暂不可用" }),
        });
      });
      const showSidebar = async () => {
        const expand = page.getByRole("button", { name: "展开侧边栏" });
        if (await expand.isVisible()) await expand.click();
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      };
      await openWorkbench(page, servers.webUrl);
      await showSidebar();
      await expect(page.locator(".sidebar-sessions-skeleton")).toBeVisible();
      await expect(page.locator(".empty-sessions")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("loading.png"), animations: "disabled" });
      release();
      await expect(page.locator(".sidebar-error")).toBeVisible();
      await expect(page.locator(".sidebar-error")).toContainText("会话列表加载失败");
      await expect(page.locator(".empty-sessions")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("error.png"), animations: "disabled" });
      empty = true;
      await openWorkbench(page, servers.webUrl);
      await showSidebar();
      await expect(page.locator(".empty-sessions")).toContainText("还没有对话");
      await expect(page.locator(".sidebar-error")).toHaveCount(0);
      await expect(page.locator(".sidebar-sessions-skeleton")).toHaveCount(0);
      await page.locator(".empty-sessions-action").focus();
      await expect(page.locator(".empty-sessions-action")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("empty.png"), animations: "disabled" });
    });
  }
}
