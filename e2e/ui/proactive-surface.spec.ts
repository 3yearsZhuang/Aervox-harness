import { test, expect, openWorkbench } from "./fixtures";

test("mobile model settings preserve an edited draft across pages and input stays reachable on a short screen", async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
  const settings = page.getByRole("button", { name: "打开设置", exact: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const baseUrl = dialog.getByRole("textbox", { name: "服务基址", exact: true });
  await baseUrl.fill("http://127.0.0.1:11434/v1");
  await dialog.getByRole("button", { name: "角色", exact: true }).click();
  await dialog.getByRole("button", { name: "模型服务", exact: true }).click();
  await expect(baseUrl).toHaveValue("http://127.0.0.1:11434/v1");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await page.setViewportSize({ width: 320, height: 360 });
  await page.locator(".pc-whisper-pill").click();
  const input = page.locator(".pc-whisper-input input");
  await expect(input).toBeFocused();
  await input.fill("中文输入草稿");
  await expect(page.locator(".pc-choice")).toHaveCount(0);
  const box = await page.locator(".pc-whisper-input").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.locator(".pc-whisper-pill")).toBeFocused();
});

test("mobile starts in proactive companion and a manual workbench choice survives a plain reload", async ({ page, servers }) => {
  test.skip(process.env.E2E_PLATFORM === "web", "This case targets the mobile build used by the UI fixture.");
  await page.goto(servers.webUrl, { timeout: 90_000 });
  const companion = page.locator(".proactive-companion");
  await expect(companion).toBeVisible({ timeout: 90_000 });
  await expect(companion).toHaveAttribute("data-platform", "mobile");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("aervox.surface.main"))).toBeNull();
  await openWorkbench(page, servers.webUrl);
  await page.goto(servers.webUrl);
  await expect(page.locator(".aervox-workbench")).toBeVisible();
});

test("settings can switch away from an explicit workbench URL", async ({ page, servers }) => {
  await openWorkbench(page, servers.webUrl);
  await page.getByRole("button", { name: "打开设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "通用", exact: false }).click();
  await dialog.getByRole("button", { name: "外观", exact: true }).click();
  await dialog.getByRole("group", { name: "工作台界面" }).getByRole("button", { name: "移动陪伴", exact: true }).click();
  await expect(page.locator(".proactive-companion")).toBeVisible({ timeout: 90_000 });
  await expect(page).toHaveURL(/surface=proactive-ui/);
});

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
