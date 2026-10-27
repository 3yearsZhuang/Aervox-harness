import { test, expect } from './fixtures';

test.use({ platform: 'web' });
  test('does not opt into Android components when opening the same companion surface', async ({ page, servers }) => {
    await page.goto(`${servers.webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
    await expect(page.locator('.proactive-companion')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-design-system', 'material3');
    expect(await page.locator('.pc-quiet-btn').first().evaluate(el => el.tagName)).toBe('BUTTON');
    await expect(page.locator('md-dialog')).toHaveCount(0);
  });
