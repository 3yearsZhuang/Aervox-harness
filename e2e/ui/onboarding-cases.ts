import { test, expect } from './fixtures';

export function registerOnboardingTests(platform: 'web' | 'mobile') {
  test.use({ onboarding: true, platform });
  test('completes shared first-run setup and replays without overwriting unsaved names', async ({ page, servers }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(servers.webUrl);
    const flow = page.locator('.onboarding');
    await expect(flow).toBeVisible();
    await expect(flow.locator('.aervox-companion-avatar')).toHaveAttribute('data-model-id', 'mizuki-default');
    await expect(flow.locator('.aervox-live2d-pet')).toHaveAttribute('data-status', 'ready', { timeout: 45000 });
    await flow.getByRole('button', { name: '认识彼此', exact: true }).click();
    await flow.getByLabel('角色的名字', { exact: true }).fill('小晴');
    await flow.getByLabel('我该怎么称呼你', { exact: true }).fill('阿年');
    await flow.getByRole('button', { name: '保存名字并继续', exact: true }).click();
    await flow.getByRole('button', { name: '稍后接入，保留已有配置', exact: true }).click();
    await flow.getByRole('button', { name: '开始相处', exact: true }).click();
    await expect(flow).toHaveCount(0);
    await page.reload();
    await expect(flow).toHaveCount(0);
    await expect(page.locator('.aervox-live2d-pet')).toHaveAttribute('data-status', 'ready', { timeout: 45000 });
    const apiOwner = await page.evaluateHandle(() => (window as Window & { aervoxLive2D?: unknown }).aervoxLive2D);
    expect(await apiOwner.evaluate(owner => Boolean(owner))).toBe(true);
    const composer = page.getByRole('textbox').first();
    await composer.fill('尚未发送的原会话草稿');
    const composerElement = await composer.elementHandle();
    expect(await page.evaluate(() => localStorage.getItem('aervox.onboarding.completed.v1'))).toBe('true');
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    if (platform === 'web') {
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '通用', exact: true }).click();
      await page.getByRole('group', { name: '设置页面' }).getByRole('button', { name: '外观', exact: true }).click();
    }
    await page.getByRole('button', { name: '打开引导', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeHidden();
    await expect(flow).toBeVisible();
    const sessionWrites: string[] = [];
    const recordSessionWrites = (request: { method(): string; url(): string }) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/sessions') sessionWrites.push(request.url());
    };
    page.on('request', recordSessionWrites);
    for (const modifier of ['Control', 'Meta']) {
      await page.keyboard.press(`${modifier}+k`);
      await page.keyboard.press(`${modifier}+n`);
    }
    await expect(page.getByPlaceholder('搜索功能、项目或会话... (↑↓ 导航，回车执行)')).toBeHidden();
    expect(sessionWrites).toEqual([]);
    page.off('request', recordSessionWrites);
    await flow.getByRole('button', { name: '认识彼此', exact: true }).click();
    await flow.getByLabel('角色的名字', { exact: true }).fill('未保存名字');
    await flow.getByRole('button', { name: '退出设置', exact: true }).click();
    await expect(flow).toHaveCount(0);
    await expect(composer).toHaveValue('尚未发送的原会话草稿');
    expect(await composer.evaluate((element, original) => element === original, composerElement)).toBe(true);
    expect(await page.evaluate(owner => (window as Window & { aervoxLive2D?: unknown }).aervoxLive2D === owner, apiOwner)).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aervox-settings') || '{}'))).toMatchObject({ companionName: '小晴', userAddress: '阿年' });
  });

}
