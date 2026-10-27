import { test, expect, openWorkbench } from './fixtures';

test.use({ platform: 'mobile' });

test('cancels and confirms plugin reset above Material settings and persists the resulting configuration', async ({ page, servers, request }) => {
  const pluginId = 'modal-reset-fixture';
  const configUrl = `${servers.apiUrl}/v1/plugins/${pluginId}/config`;
  expect((await request.post(`${servers.apiUrl}/v1/plugins`, {
    data: { id: pluginId, publisher: 'ui-fixture', version: '1.0.0' },
  })).status()).toBe(201);
  expect((await request.put(`${configUrl}/schema`, {
    data: {
      apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
      fields: [{ key: 'label', type: 'string', label: '名称', default: '初始值' }],
    },
  })).status()).toBe(200);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openWorkbench(page, servers.webUrl);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('button', { name: /扩展插件/ }).click();
  const card = page.locator('.plugin-card').filter({ hasText: pluginId });
  await card.getByRole('button', { name: '管理', exact: true }).click();
  const editor = page.locator('md-dialog').filter({ has: page.locator(`.avx-material-dialog-headline[aria-label="${pluginId} 插件能力与设置"]`) });
  const field = editor.getByRole('textbox', { name: '名称', exact: true });
  await expect(field).toHaveValue('初始值');
  await field.fill('已保存配置');
  const saveResponse = page.waitForResponse(response => response.url() === configUrl && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  expect((await saveResponse).status()).toBe(200);
  const saved = await (await request.get(configUrl)).json();
  expect(saved.values).toEqual({ label: '已保存配置' });

  let resets = 0;
  page.on('request', call => { if (call.url().startsWith(`${configUrl}/reset`) && call.method() === 'POST') resets += 1; });
  const trigger = editor.getByRole('button', { name: '恢复默认', exact: true });
  const prompt = page.locator('md-dialog.avx-dialog-prompt').filter({ hasText: '恢复默认配置？' });
  await trigger.click();
  await expect(prompt).toBeVisible();
  await expect(page.locator('.el-message-box')).toHaveCount(0);
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(resets).toBe(0);
  expect(await (await request.get(configUrl)).json()).toEqual(saved);
  await expect(field).toHaveValue('已保存配置');

  await trigger.click();
  const resetResponse = page.waitForResponse(response => response.url().startsWith(`${configUrl}/reset`) && response.request().method() === 'POST');
  await prompt.getByRole('button', { name: '恢复默认', exact: true }).click();
  expect((await resetResponse).status()).toBe(200);
  await expect(prompt).toHaveCount(0);
  await expect(field).toHaveValue('初始值');
  expect(resets).toBe(1);
  const restored = await (await request.get(configUrl)).json();
  expect(restored.values).toEqual({ label: '初始值' });
  expect(restored.revision).toBeGreaterThan(saved.revision);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toBeHidden();
  await card.getByRole('button', { name: '管理', exact: true }).click();
  await expect(field).toHaveValue('初始值');
});
