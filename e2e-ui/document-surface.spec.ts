import { test, expect, openWorkbench } from "./fixtures";

for (const viewport of [{ width: 1366, height: 768 }, { width: 460, height: 740 }, { width: 320, height: 700 }]) {
  test(`document surface keeps identity and keyboard input usable at ${viewport.width}px`, async ({ page, servers }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${servers.webUrl}/?surface=document-ui`, { timeout: 90_000 });
    await page.evaluate(() => localStorage.setItem("aervox-settings", JSON.stringify({ companionName: "团子", userAddress: "掌柜" })));
    await page.reload();
    await expect(page.locator(".document-companion")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".dc-name")).toHaveText("团子");
    await expect(page.locator(".dc-dialogue")).toContainText("你好，掌柜，我是团子");
    await expect(page.locator(".dc-choice")).toHaveCount(2);
    const whisper = page.getByRole("button", { name: "对团子说…" });
    await whisper.focus();
    await page.keyboard.press("Enter");
    const input = page.getByPlaceholder("想到什么，直接告诉团子");
    await expect(input).toBeVisible();
    await input.fill("保留这条草稿");
    for (const selector of [".dc-whisper-input", ".dc-whisper-input input", ".dc-whisper-input button"]) {
      for (const element of await page.locator(selector).all()) {
        const bounds = await element.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      }
    }
    await page.getByTitle("收起").click();
    await whisper.click();
    await expect(input).toHaveValue("保留这条草稿");
    await page.getByTitle("回到完整工作台").click();
    await expect(page.locator(".aervox-workbench")).toBeVisible({ timeout: 90_000 });
    expect(new URL(page.url()).searchParams.has("surface")).toBe(false);
    await page.reload();
    await expect(page.locator(".aervox-workbench")).toBeVisible();
  });
}

test("workbench saves both identity fields and restores them after reload", async ({ page, servers }) => {
  await openWorkbench(page, servers.webUrl);
  await page.getByRole("button", { name: "打开设置" }).click();
  const name = page.getByLabel(/TA 的名字/);
  const address = page.getByLabel(/TA 怎么称呼你/);
  await name.fill("阿雾");
  await address.fill("阿庄");
  await name.focus();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("aervox-settings") ?? "{}"))).toMatchObject({ companionName: "阿雾", userAddress: "阿庄" });
  await page.reload();
  await expect(page.locator(".aervox-workbench")).toBeVisible();
  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(name).toHaveValue("阿雾");
  await expect(address).toHaveValue("阿庄");
});
