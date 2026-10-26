import { test, expect, openWorkbench } from './fixtures';

test.use({ platform: 'mobile' });
test.setTimeout(60_000);
  test('uses the actual Material components in both themes and keeps short-screen IME input and dialog focus usable', async ({ page, servers }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(servers.webUrl, { timeout: 90_000 });
    await expect(page.locator('html')).toHaveAttribute('data-design-system', 'material3');
    await expect(page.locator('.proactive-companion')).toHaveAttribute('data-design-system', 'material3');
    await expect.poll(() => page.locator('.pc-whisper-pill').evaluate(el => el.matches(':defined') && Boolean(el.shadowRoot?.querySelector('button')))).toBe(true);
    await expect(page.locator('.pc-quiet-btn').first()).toHaveCSS('height', '48px');
    const lightSurface = await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--md-sys-color-surface').trim());
    await expect(page.locator('.pc-dialogue-text')).toContainText('专注一会儿');
    await page.screenshot({ path: '/tmp/aervox-material3-light.png', fullPage: true });
    await page.locator('.pc-whisper-pill').click();
    const input = page.locator('.pc-whisper-input input');
    await expect(input).toBeFocused();
    await input.fill('中文输入草稿');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await expect(input).toHaveValue('中文输入草稿');
    await page.setViewportSize({ width: 320, height: 360 });
    await expect.poll(async () => { const bounds = await page.locator('.pc-whisper-input').boundingBox(); return bounds!.y + bounds!.height; }).toBeLessThanOrEqual(361);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    await page.screenshot({ path: '/tmp/aervox-material3-short.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = page.getByRole('button', { name: '打开设置', exact: true });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.locator('md-dialog.mobile-settings-dialog')).toHaveCount(1);
    const dialogContent = page.locator('md-dialog.mobile-settings-dialog');
    await expect.poll(() => dialogContent.evaluate(el => (el as HTMLElement & { quick: boolean }).quick)).toBe(true);
    const baseUrl = dialogContent.getByRole('textbox', { name: '服务基址', exact: true });
    await baseUrl.fill('https://example.invalid/v1');
    await dialogContent.getByRole('tab', { name: '角色', exact: true }).click();
    await dialogContent.getByRole('tab', { name: '模型服务', exact: true }).click();
    await expect(baseUrl).toHaveValue('https://example.invalid/v1');
    await page.screenshot({ path: '/tmp/aervox-material3-settings.png', fullPage: true });
    await dialogContent.evaluate(el => {
      const counts = { close: 0, closed: 0 };
      (window as unknown as { dialogLifecycle: typeof counts }).dialogLifecycle = counts;
      el.addEventListener('close', () => counts.close++);
      el.addEventListener('closed', () => counts.closed++);
    });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { dialogLifecycle: { close: number; closed: number } }).dialogLifecycle)).toEqual({ close: 1, closed: 1 });
    await expect(settings).toBeFocused();
    await page.evaluate(() => { localStorage.setItem('aervox-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--md-sys-color-surface').trim())).not.toBe(lightSurface);
    await expect.poll(() => page.locator('.pc-choice--primary').evaluate(el => {
      const expected = document.createElement('div');
      expected.style.backgroundColor = 'var(--md-sys-color-primary-container)';
      document.body.append(expected);
      const settled = getComputedStyle(el).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove(); return settled;
    })).toBe(true);
    await page.screenshot({ path: '/tmp/aervox-material3-dark.png', fullPage: true, animations: 'disabled' });
  });


test('follows the system theme until a user chooses an explicit theme', async ({ page, servers }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(servers.webUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => { localStorage.setItem('aervox-theme', 'light'); document.documentElement.dataset.theme = 'light'; });
  const chosenSurface = await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--md-sys-color-surface').trim());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--md-sys-color-surface').trim())).toBe(chosenSurface);
  await page.evaluate(() => localStorage.removeItem('aervox-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await openWorkbench(page, servers.webUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('aervox-theme'))).toBeNull();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '打开设置' }).click();
  const settings = page.locator('md-dialog[data-aria-label="设置"]');
  await settings.getByRole('button', { name: '通用', exact: false }).click();
  await settings.getByRole('button', { name: '外观', exact: true }).click();
  await expect(settings.getByRole('button', { name: '暗色', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('keeps a real Material switch controlled through existing settings handlers', async ({ page, servers }) => {
  await page.addInitScript(() => localStorage.setItem('aervox-workbench-mode', 'standard'));
  await openWorkbench(page, servers.webUrl);
  await page.getByRole('button', { name: '打开设置' }).click();
  const settings = page.locator('md-dialog[data-aria-label="设置"]');
  await settings.getByRole('button', { name: '通用', exact: false }).click();
  await settings.getByRole('button', { name: '外观', exact: true }).click();
  for (const item of await settings.locator('.aervox-segmented button').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  const control = settings.locator('.settings-choice-row').filter({ hasText: '紧凑布局' }).locator('md-switch');
  await expect(control).toBeVisible();
  const before = await control.evaluate(el => (el as HTMLElement & { selected: boolean }).selected);
  await control.click();
  await expect.poll(() => control.evaluate((el, previous) => (el as HTMLElement & { selected: boolean; checked: boolean }).selected === !previous && (el as HTMLElement & { checked: boolean }).checked === !previous, before)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.getByRole('button', { name: '打开设置' }).click();
  await expect.poll(() => control.evaluate(el => (el as HTMLElement & { selected: boolean }).selected)).toBe(!before);
});


test('renders readable dark questions and sends the chosen answer', async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('aervox-theme', 'dark'));
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route('**/v1/sessions/*/turns', route => route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ turnId: 'turn_material_question' }) }));
  await page.route('**/v1/turns/turn_material_question/events', route => route.fulfill({ contentType: 'text/event-stream', headers: cors,
    body: [
      { turnId: 'turn_material_question', sequence: 1, eventType: 'user_question_required', data: { turnId: 'turn_material_question', step: 1, questions: [{ id: 'topic', header: '学习主题', question: '接下来学习什么？', detail: '选择一个主题，也可以补充说明。', options: [{ label: '变量与类型', description: '从简单例子开始' }, { label: '函数', description: '学习组合与复用' }] }] } },
      { turnId: 'turn_material_question', sequence: 2, eventType: 'done', data: {} },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  }));
  let saved: unknown;
  await page.route('**/v1/turns/turn_material_question/questions/answers', async route => { saved = route.request().postDataJSON(); await route.fulfill({ status: 204, headers: cors }); });
  await page.goto(servers.webUrl);
  await page.locator('.pc-whisper-pill').click();
  await page.locator('.pc-whisper-input input').fill('帮我选择一个主题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const option = page.getByRole('button', { name: '变量与类型 从简单例子开始' });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  const contrast = await option.evaluate(el => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => { const v=value/255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; });
    const l = (color: string) => { const c=rgb(color); return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!; };
    const a=l(getComputedStyle(el.querySelector('.uq-option-label')!).color), b=l(getComputedStyle(el).backgroundColor);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: '/tmp/aervox-material3-question-dark.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '确认并继续' }).click();
  await expect.poll(() => saved).toMatchObject({ answers: [{ id: 'topic', selected: ['变量与类型'] }] });
});


test('preserves accessible pressed state without enabling access until confirmation', async ({ page, servers }) => {
  await page.addInitScript(() => localStorage.setItem('aervox-workbench-mode', 'standard'));
  await openWorkbench(page, servers.webUrl);
  const access = page.getByRole('button', { name: '操作需确认', exact: true, pressed: false });
  await expect(access).toBeVisible();
  await expect(page.getByRole('button', { name: '语音输入', exact: true, pressed: false })).toBeVisible();
  await access.click();
  const dialog = page.locator('md-dialog.permission-confirm-dialog');
  await expect(page.getByRole('dialog', { name: '启用完全访问？', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('aervox-tool-approval-mode'))).not.toBe('full_access');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(access).toBeVisible();
  await expect(access).toBeFocused();
  await expect(page.getByRole('button', { name: '完全访问', exact: true, pressed: true })).toHaveCount(0);
});
