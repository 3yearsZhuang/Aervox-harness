import { test, expect, openWorkbench } from "./fixtures";

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
