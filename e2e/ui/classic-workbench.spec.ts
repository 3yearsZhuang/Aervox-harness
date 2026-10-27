import type { Locator } from "@playwright/test";
import { test, expect, openWorkbench } from "./fixtures";

test.use({ platform: "web" });

async function expectCenterClickable(action: Locator) {
  await expect.poll(() => action.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === el || el.contains(hit);
  })).toBe(true);
}

test("classic desktop keeps the last tool action clickable above the expanded dialogue on short screens", async ({ page, servers }) => {
  await page.addInitScript(() => {
    localStorage.setItem("aervox-workbench-mode", "companion");
    localStorage.setItem("aervox-side-cards", JSON.stringify(["todo", "timer"]));
  });
  await openWorkbench(page, servers.webUrl);
  const focusOff = page.getByRole("switch", { name: "关闭专注模式", exact: true });
  if (await focusOff.count()) await focusOff.click();
  await expect(page.locator(".timer-card-presets")).toBeAttached();
  await page.locator("#aervox-composer").fill("帮我整理今天的安排");

  for (const viewport of [{ width: 390, height: 360 }, { width: 560, height: 440 }]) {
    await page.setViewportSize(viewport);
    const sideCards = page.locator(".side-cards");
    await sideCards.evaluate(el => { el.scrollTop = el.scrollHeight; });
    // Plugins can append cards after the timer. Check the actual final action
    // at the bottom, then scroll back to exercise the retained timer action.
    await expectCenterClickable(sideCards.getByRole("button").last());
    const reset = page.getByRole("button", { name: "重置", exact: true });
    await reset.scrollIntoViewIfNeeded();
    await expectCenterClickable(reset);
    await reset.click();
    const cards = await page.locator(".side-cards").boundingBox();
    const dialogue = await page.locator(".immersive-console").boundingBox();
    const input = await page.locator("#aervox-composer").boundingBox();
    expect(cards!.y + cards!.height).toBeLessThanOrEqual(dialogue!.y + 1);
    expect(input!.y + input!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  }
});
