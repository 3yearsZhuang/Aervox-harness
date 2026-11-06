import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { PersonaListResponse, PersonaMutationResponse } from '@aervox/contracts';
import { test, expect } from './fixtures';

/** Compare actual Chromium screenshots with and without the rendered canvas.
 * The background and host decorations stay in place, so an empty WebGL canvas
 * cannot satisfy this check. Cubism, Pixi and their GPU factory are never mocked.
 */
async function expectVisibleModel(page: Page, avatar: Locator, info: TestInfo, name: string): Promise<void> {
  await expect(avatar.locator('[data-status="ready"]')).toBeVisible({ timeout: 45_000 });
  const canvas = avatar.locator('canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(100);
  expect(bounds!.height).toBeGreaterThan(100);
  const clip = { x: Math.max(0, bounds!.x), y: Math.max(0, bounds!.y),
    width: Math.min(bounds!.width, page.viewportSize()!.width - Math.max(0, bounds!.x)),
    height: Math.min(bounds!.height, page.viewportSize()!.height - Math.max(0, bounds!.y)) };
  const rendered = await page.screenshot({ clip, animations: 'disabled' });
  let empty: Buffer;
  const previous = await canvas.evaluate(element => {
    const value = element.style.visibility;
    element.style.visibility = 'hidden';
    return value;
  });
  try { empty = await page.screenshot({ clip, animations: 'disabled' }); }
  finally { await canvas.evaluate((element, visibility) => { element.style.visibility = visibility; }, previous); }
  const [visiblePixels, emptyPixels] = await Promise.all([
    sharp(rendered).ensureAlpha().raw().toBuffer(), sharp(empty).ensureAlpha().raw().toBuffer(),
  ]);
  expect(visiblePixels.length).toBe(emptyPixels.length);
  let changedPixels = 0;
  for (let index = 0; index < visiblePixels.length; index += 4) {
    if (Math.abs(visiblePixels[index] - emptyPixels[index])
      + Math.abs(visiblePixels[index + 1] - emptyPixels[index + 1])
      + Math.abs(visiblePixels[index + 2] - emptyPixels[index + 2]) > 40) changedPixels++;
  }
  await info.attach(`${name}-canvas`, { body: rendered, contentType: 'image/png' });
  const evidence = info.outputPath(`${name}-render-evidence.json`);
  await writeFile(evidence, JSON.stringify({ changedPixels, bounds }, null, 2));
  await info.attach(`${name}-render-evidence`, { path: evidence, contentType: 'application/json' });
  expect(changedPixels, 'Mizuki must contribute visible pixels beyond the unchanged background').toBeGreaterThan(1_000);
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await info.attach(name, { path: screenshot, contentType: 'image/png' });
}

test('renders bundled Mizuki with real Cubism and Chromium pixels', async ({ page, servers, platform }, info) => {
  await page.setViewportSize(platform === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: platform === 'mobile' ? 'reduce' : 'no-preference' });
  const assets: Array<{ path: string; status: number }> = [];
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (/\/live2d\/mizuki\/.*(?:model3\.json|moc3|texture_00\.png)$/.test(pathname)) assets.push({ path: pathname, status: response.status() });
  });
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
  const avatar = page.locator('.aervox-companion-avatar');
  await expect(avatar).toHaveAttribute('data-model-id', 'mizuki-default');
  await expect(avatar).toHaveAttribute('data-binding-state', 'default');
  await expectVisibleModel(page, avatar, info, `${platform}-default-mizuki`);
  expect(assets).toEqual(expect.arrayContaining([
    { path: '/live2d/mizuki/mizuki.model3.json', status: 200 },
    { path: '/live2d/mizuki/model/20mizuki_normal_3.0_t04.moc3', status: 200 },
    { path: '/live2d/mizuki/model/20mizuki_normal_3.0_t04.2048/texture_00.png', status: 200 },
  ]));
  await expect(avatar.locator('img, svg, .sprite-pet, .pet-hero')).toHaveCount(0);
});
test.describe('persona bound companion on mobile', () => {
  test('retains a missing reference, saves Mizuki, and applies only the activated revision across windows', async ({ page, request, servers, platform }, info) => {
    test.skip(platform !== 'mobile', 'Persona settings use the mobile Material3 editor.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const createdResponse = await request.post(`${servers.apiUrl}/v1/personas`, { data: {
      name: '浏览器 Live2D 验收', description: '仅保存在可销毁的浏览器测试数据库。',
      config: { systemPromptAppend: 'Browser rendering acceptance persona.', live2dModelId: 'unavailable-browser-model' },
    } });
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await createdResponse.json() as PersonaMutationResponse;
    expect((await request.post(`${servers.apiUrl}/v1/personas/${created.persona.id}/activate`, { data: { revisionId: created.revision.id } })).status()).toBe(200);
    const revisionReads: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === `/v1/personas/${created.persona.id}` && url.searchParams.has('revisionId')) revisionReads.push(url.searchParams.get('revisionId')!);
    });
    await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
    const avatar = page.locator('.aervox-companion-avatar');
    await expect(avatar).toHaveAttribute('data-binding-state', 'missing');
    await expect(avatar).toContainText('绑定的形象不可用，正在使用 Mizuki');
    await expect(avatar.locator('.aervox-companion-avatar__notice')).toBeInViewport({ ratio: 1 });
    await expectVisibleModel(page, avatar, info, 'mobile-missing-reference-mizuki');
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const settings = page.locator('md-dialog.mobile-settings-dialog');
    await settings.getByRole('tab', { name: '角色', exact: true }).click();
    const card = settings.locator('.persona-card').filter({ hasText: created.persona.name });
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.locator('md-dialog.persona-edit-dialog');
    await expect(editor).toBeVisible();
    const selection = editor.getByLabel('Live2D 形象', { exact: true });
    await expect(selection).toHaveValue('unavailable-browser-model');
    expect(await selection.locator('option').evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, disabled: (option as HTMLOptionElement).disabled })))).toEqual([
      { value: '', disabled: false }, { value: 'mizuki-default', disabled: false }, { value: 'unavailable-browser-model', disabled: true },
    ]);
    await selection.selectOption('mizuki-default');
    const savedResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/v1/personas/${created.persona.id}`);
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await (await savedResponse).json() as PersonaMutationResponse;
    expect(saved.revision.config.live2dModelId).toBe('mizuki-default');
    await expect(editor).toBeHidden();
    await expect(card).toContainText('有更新待启用');
    await expect(avatar).toHaveAttribute('data-binding-state', 'missing');
    const beforeActivation = await (await request.get(`${servers.apiUrl}/v1/personas`)).json() as PersonaListResponse;
    expect(beforeActivation.active?.revisionId).toBe(created.revision.id);

    const otherWindow = await page.context().newPage();
    await otherWindow.goto(`${servers.webUrl}/?surface=proactive-ui`);
    await otherWindow.getByRole('button', { name: '打开设置', exact: true }).click();
    const otherSettings = otherWindow.locator('md-dialog.mobile-settings-dialog');
    await otherSettings.getByRole('tab', { name: '角色', exact: true }).click();
    await otherSettings.locator('.persona-card').filter({ hasText: created.persona.name }).getByRole('button', { name: '启用最新修订', exact: true }).click();
    await expect(avatar).toHaveAttribute('data-binding-state', 'bound');
    expect(revisionReads).toContain(created.revision.id);
    expect(revisionReads).toContain(saved.revision.id);
    await otherWindow.close();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expectVisibleModel(page, avatar, info, 'mobile-activated-mizuki');
    await page.reload();
    await expect(avatar).toHaveAttribute('data-binding-state', 'bound');
    await expectVisibleModel(page, avatar, info, 'mobile-reloaded-mizuki');
  });

  test('shows neutral failure and renders the real model after retry', async ({ page, servers, platform }, info) => {
    test.skip(platform !== 'mobile', 'The mobile retry case is covered once across platform runs.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const modelRoute = '**/live2d/mizuki/mizuki.model3.json';
    await page.route(modelRoute, route => route.abort('failed'));
    await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
    const avatar = page.locator('.aervox-companion-avatar');
    await expect(avatar.locator('[data-status="error"]')).toBeVisible();
    await expect(avatar).toContainText('Mizuki 暂时无法加载');
    await expect(avatar.locator('img, svg, canvas, .sprite-pet, .pet-hero')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('mobile-mizuki-failure.png'), animations: 'disabled' });
    const retry = avatar.getByRole('button', { name: '重试加载', exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    const retryBounds = await retry.boundingBox();
    const dialogueBounds = await page.locator('.pc-dialogue-box').first().boundingBox();
    expect(retryBounds!.y + retryBounds!.height, 'The dialogue panel must not visually cover the retry button').toBeLessThanOrEqual(dialogueBounds!.y);
    await page.setViewportSize({ width: 390, height: 360 });
    const input = page.locator('.pc-whisper-input textarea');
    await input.click();
    await input.fill('短屏输入仍然可用');
    await expect(page.locator('.pc-stage')).toBeHidden();
    await expect(input).toBeInViewport({ ratio: 1 });
    await page.setViewportSize({ width: 390, height: 560 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.pc-stage')).toBeVisible();
    await expect(retry).toBeInViewport({ ratio: 1 });
    const restoredRetryBounds = await retry.boundingBox();
    const restoredDialogueBounds = await page.locator('.pc-dialogue-box').first().boundingBox();
    expect(restoredRetryBounds!.y + restoredRetryBounds!.height).toBeLessThanOrEqual(restoredDialogueBounds!.y);
    await expect(input).toHaveValue('短屏输入仍然可用');
    await page.screenshot({ path: info.outputPath('mobile-mizuki-failure-restored-height.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.unroute(modelRoute);
    await retry.click();
    await expectVisibleModel(page, avatar, info, 'mobile-mizuki-retry');
  });
});
