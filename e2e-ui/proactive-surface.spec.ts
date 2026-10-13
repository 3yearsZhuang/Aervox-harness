import { test, expect, openWorkbench } from "./fixtures";

test("explicit proactive selection persists and returns to the default workbench", async ({ page, servers }) => {
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
  await expect(page.locator(".proactive-companion")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".pc-choice")).toHaveCount(2);
  await expect(page.locator(".pc-whisper-input")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".proactive-companion")).toBeVisible();
  await page.getByTitle("回到完整工作台").click();
  await expect(page.locator(".aervox-workbench")).toBeVisible({ timeout: 90_000 });
  await openWorkbench(page, servers.webUrl);
  await expect(page.locator(".proactive-companion")).toHaveCount(0);
});
