import type { Locator, Page } from '@playwright/test';
import type { LLMConfigResponse, LLMPresetListResponse, PersonaListResponse, VoicePresetListResponse } from '@aervox/contracts';
import { test, expect, openWorkbench } from './fixtures';

const configuration: LLMConfigResponse = {
  enabled: true, providerType: 'openai', baseUrl: 'https://example.invalid/v1',
  apiKey: '', modelId: 'fixture-model', temperature: .7, maxTokens: 4096, settings: {},
};
const modelPresets: LLMPresetListResponse = {
  activeId: 'model_phone_0',
  presets: Array.from({ length: 4 }, (_, index) => ({ ...configuration, id: `model_phone_${index}`,
    name: `手机长名称模型预设 ${index + 1} · ${'LongModelName'.repeat(3)}`, isActive: index === 0 })),
};
const voicePresets: VoicePresetListResponse = {
  activeId: 'voice_phone_0',
  presets: Array.from({ length: 2 }, (_, index) => ({ id: `voice_phone_${index}`,
    name: `手机语音预设 ${index + 1} · ${'LongVoiceName'.repeat(3)}`, isActive: index === 0,
    local: null, remote: null, input: null })),
};
const personas: PersonaListResponse = {
  active: null,
  personas: Array.from({ length: 2 }, (_, index) => ({
    id: `persona_phone_${index}`, workspaceId: 'fixture_workspace', subjectUserId: 'fixture_user',
    name: `手机长名称角色 ${index + 1} · ${'LongPersonaName'.repeat(3)}`,
    description: '用于检验手机非空列表排版的角色说明。'.repeat(3), source: 'user_created', status: 'active',
    reviewStatus: 'draft', reviewNotes: '', reviewedAt: null, currentRevisionId: `revision_phone_${index}`,
    createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
  })),
};

/** GET-only projections keep real controls and long records without changing configuration. */
async function settingsFixtures(page: Page): Promise<string[]> {
  const writes: string[] = [];
  const payloads = new Map<string, unknown>([
    ['/v1/llm/config', configuration], ['/v1/llm/presets', modelPresets],
    ['/v1/voice/presets', voicePresets], ['/v1/personas', personas],
  ]);
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && /^\/v1\/(llm|voice|personas)(\/|$)/.test(new URL(request.url()).pathname)) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route(/\/v1\/(?:llm\/(?:config|presets)|voice\/presets|personas)(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(payloads.get(new URL(route.request().url()).pathname)) });
  });
  return writes;
}

async function nativeBounds(dialog: Locator) {
  return dialog.evaluate(el => {
    const bounds = el.shadowRoot?.querySelector('dialog')?.getBoundingClientRect();
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, bottom: bounds.bottom }
      : { x: 0, y: 0, width: 0, height: 0, bottom: 0 };
  });
}

async function expectNoHorizontalOverflow(panel: Locator) {
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

test.use({ platform: 'mobile' });
test.setTimeout(60_000);

test('keeps categories fixed, shares narrow record layouts and preserves the edited model draft', async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('aervox-theme', 'dark'));
  const writes = await settingsFixtures(page);
  await page.goto(servers.webUrl);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.locator('md-dialog.mobile-settings-dialog');
  const panel = dialog.locator('.mobile-settings-panel');
  const tabs = dialog.getByRole('tablist', { name: '设置分类' });
  await expect(dialog).toHaveClass(/is-mobile-fullscreen/);
  await expect.poll(async () => Math.round((await nativeBounds(dialog)).width)).toBe(390);
  await expect.poll(async () => Math.round((await nativeBounds(dialog)).height)).toBe(844);
  await expect(dialog.locator('.avx-material-dialog-headline').getByRole('tablist', { name: '设置分类' })).toBeVisible();
  await expect(dialog.locator('.llm-preset-card')).toHaveCount(4);
  const tabTop = (await tabs.boundingBox())!.y;
  const baseUrl = dialog.getByRole('textbox', { name: '服务基址', exact: true });
  await baseUrl.fill('https://draft.example.invalid/phone');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).scrollIntoViewIfNeeded();
  expect(await panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect((await tabs.boundingBox())!.y).toBeCloseTo(tabTop, 0);
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(panel);
  await page.screenshot({ path: '/tmp/aervox-mobile-settings-dark.png', fullPage: true });

  await page.setViewportSize({ width: 320, height: 720 });
  for (const category of [
    { label: '角色', cards: '.persona-card', grid: '.persona-card-grid', count: 2 },
    { label: '语音', cards: '.voice-preset-card', grid: '.voice-preset-grid', count: 2 },
    { label: '模型服务', cards: '.llm-preset-card', grid: '.llm-preset-grid', count: 4 },
  ]) {
    await dialog.getByRole('tab', { name: category.label, exact: true }).click();
    await expect(dialog.locator(category.cards)).toHaveCount(category.count);
    await expectNoHorizontalOverflow(panel);
    expect(await dialog.locator(category.grid).evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    const panelBounds = (await panel.boundingBox())!;
    for (const card of await dialog.locator(category.cards).all()) {
      const bounds = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(panelBounds.x - 1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width + 1);
    }
    if (category.label === '角色') {
      await dialog.getByRole('button', { name: '创建人格', exact: true }).click();
      const editor = page.locator('md-dialog.persona-edit-dialog');
      await expect(page.getByRole('dialog', { name: '创建新人格', exact: true })).toBeVisible();
      await expect(editor).toHaveClass(/is-mobile-fullscreen/);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect(editor.getByRole('alert').filter({ hasText: '请输入人格名称' })).toBeVisible();
      expect(writes).toEqual([]);
      await editor.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(dialog.getByRole('tab', { name: '角色', exact: true })).toHaveAttribute('aria-selected', 'true');
      await dialog.getByRole('button', { name: '创建人格', exact: true }).click();
      await expect(editor).toBeVisible();
      await page.goBack();
      await expect(editor).toBeHidden();
      await expect(dialog.getByRole('tab', { name: '角色', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.locator('.persona-card')).toHaveCount(2);
    }
    await page.screenshot({ path: `/tmp/aervox-mobile-settings-320-${category.label}.png`, fullPage: true });
  }
  await expect(baseUrl).toHaveValue('https://draft.example.invalid/phone');
  expect(writes).toEqual([]);
});

test('fits the visual keyboard viewport and closes one settings layer without discarding its draft', async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const writes = await settingsFixtures(page);
  await page.goto(servers.webUrl);
  const openSettings = page.getByRole('button', { name: '打开设置', exact: true });
  await openSettings.click();
  const dialog = page.locator('md-dialog.mobile-settings-dialog');
  const baseUrl = dialog.getByRole('textbox', { name: '服务基址', exact: true });
  await baseUrl.fill('https://draft.example.invalid/keyboard');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => Math.round((await nativeBounds(dialog)).height)).toBe(400);
  expect((await nativeBounds(dialog)).bottom).toBeLessThanOrEqual(401);
  await baseUrl.scrollIntoViewIfNeeded();
  const field = (await baseUrl.boundingBox())!;
  expect(field.y).toBeGreaterThanOrEqual(0);
  expect(field.y + field.height).toBeLessThanOrEqual(401);
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/aervox-mobile-settings-keyboard.png', fullPage: true });
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, 'height');
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.proactive-companion')).toBeVisible();
  await openSettings.click();
  await expect(baseUrl).toHaveValue('https://draft.example.invalid/keyboard');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(openSettings).toBeFocused();
  expect(writes).toEqual([]);
});

test('validates a preset prompt and cancels nested prompts and deletion without writing settings', async ({ page, servers }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const writes = await settingsFixtures(page);
  await page.goto(servers.webUrl);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.locator('md-dialog.mobile-settings-dialog');
  const baseUrl = settings.getByRole('textbox', { name: '服务基址', exact: true });
  await baseUrl.fill('https://draft.example.invalid/prompt');
  await settings.getByRole('button', { name: '新建预设', exact: true }).click();
  // A role locator finds the native shadow dialog; its slotted form controls
  // belong to the md-dialog host's light DOM rather than that DOM subtree.
  const prompt = page.locator('md-dialog.avx-dialog-prompt').filter({ hasText: '新建模型预设' });
  await expect(page.getByRole('dialog', { name: '新建模型预设', exact: true })).toBeVisible();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('textbox').fill('   ');
  await prompt.getByRole('button', { name: '创建', exact: true }).click();
  await expect(prompt.getByText('名称不能为空', { exact: true })).toBeVisible();
  await expect(prompt).toBeVisible();
  expect(writes).toEqual([]);
  await page.goBack();
  await expect(prompt).toBeHidden();
  await expect(baseUrl).toHaveValue('https://draft.example.invalid/prompt');
  await settings.getByRole('button', { name: '新建预设', exact: true }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(baseUrl).toHaveValue('https://draft.example.invalid/prompt');

  // Discarding this test-only edit exposes the actual deletion confirmation.
  await settings.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(baseUrl).toHaveValue(configuration.baseUrl);
  await settings.locator('.llm-preset-card').nth(1).getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.locator('md-dialog.avx-dialog-prompt').filter({ hasText: '删除确认' });
  await expect(page.getByRole('dialog', { name: '删除确认', exact: true })).toBeVisible();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(settings.locator('.llm-preset-card')).toHaveCount(4);
  expect(writes).toEqual([]);
});

test('uses the same phone shell when settings are opened from the complete workbench', async ({ page, servers }) => {
  await page.setViewportSize({ width: 360, height: 752 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const writes = await settingsFixtures(page);
  await openWorkbench(page, servers.webUrl);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.locator('md-dialog.settings-dialog');
  await expect(dialog).toHaveClass(/is-mobile-fullscreen/);
  await expect.poll(async () => Math.round((await nativeBounds(dialog)).width)).toBe(360);
  await expect.poll(async () => Math.round((await nativeBounds(dialog)).height)).toBe(752);
  await dialog.getByRole('button', { name: '模型服务', exact: false }).first().click();
  const field = dialog.getByRole('textbox', { name: '服务基址', exact: true });
  await expect(field).toHaveValue(configuration.baseUrl);
  await expectNoHorizontalOverflow(dialog.locator('.aervox-nav-detail'));
  await dialog.getByRole('button', { name: '保存配置', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await page.screenshot({ path: '/tmp/aervox-mobile-settings-workbench.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(writes).toEqual([]);
});
