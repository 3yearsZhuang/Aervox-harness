import { test, expect } from './fixtures';

test.use({ platform: 'web' });
test('retains the ordinary dialog on a narrow browser window', async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await expect(page.locator('.el-dialog.mobile-settings-dialog')).toBeVisible();
  await expect(page.locator('md-dialog')).toHaveCount(0);
  await expect(page.locator('.is-mobile-fullscreen')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.el-dialog.mobile-settings-dialog')).toBeHidden();
});
