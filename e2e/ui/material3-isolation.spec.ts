import { test, expect } from './fixtures';

test.use({ platform: 'web' });
  test('does not opt into Android components when opening the same companion surface', async ({ page, servers }) => {
    await page.goto(`${servers.webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
    await expect(page.locator('.proactive-companion')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-design-system', 'material3');
    expect(await page.locator('.pc-quiet-btn').first().evaluate(el => el.tagName)).toBe('BUTTON');
    await expect(page.locator('md-dialog')).toHaveCount(0);
  });

test('keeps ordinary Web preset prompts on the existing Element service', async ({ page, servers }) => {
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('button', { name: '新建预设', exact: true }).click();
  const prompt = page.locator('.el-message-box');
  await expect(prompt).toContainText('新建模型预设');
  await prompt.getByRole('textbox').fill('取消的 Web 预设');
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(page.locator('.llm-preset-card').filter({ hasText: '取消的 Web 预设' })).toHaveCount(0);
  await expect(page.locator('md-dialog')).toHaveCount(0);
});
