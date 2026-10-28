import { readFile } from 'node:fs/promises';
import { test, expect, openWorkbench } from './fixtures';

test.use({ platform: 'mobile' });

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 520 }]) {
  test(`exports disabled plugin data and requires explicit confirmation before uninstalling it (${viewport.width}x${viewport.height})`, async ({ page, servers, request }) => {
    const id = 'retained-data-fixture';
    const pluginUrl = `${servers.apiUrl}/v1/plugins/${id}`;
    expect((await request.post(`${servers.apiUrl}/v1/plugins`, { data: { id, publisher: 'ui-fixture', version: '1.0.0' } })).status()).toBe(201);
    expect((await request.put(`${pluginUrl}/config/schema`, { data: {
      apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
      fields: [{ key: 'note', type: 'string', label: 'Note' }, { key: 'token', type: 'secret', label: 'Token' }],
    } })).status()).toBe(200);
    expect((await request.put(`${pluginUrl}/config`, { data: { revision: 0, values: { note: 'retained personal data' }, secretValues: { token: 'must-not-export' } } })).status()).toBe(200);
    expect((await request.patch(pluginUrl, { data: { enabled: false } })).status()).toBe(200);

    await page.setViewportSize(viewport);
    await openWorkbench(page, servers.webUrl);
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByRole('button', { name: /扩展插件/ }).click();
    const card = page.locator('.plugin-card').filter({ hasText: id });
    await expect(card.getByRole('button', { name: '管理', exact: true })).toBeDisabled();
    const more = card.getByRole('button', { name: `更多操作：${id}`, exact: true });
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.route(`${pluginUrl}/data-export`, route => route.fulfill({
      status: 409, contentType: 'application/problem+json',
      body: JSON.stringify({ status: 409, code: 'plugin_changed', detail: '插件状态已变化，请重新导出。' }),
    }), { times: 1 });
    await more.click();
    await page.getByRole('menuitem', { name: '导出已保存数据', exact: true }).click();
    const notice = page.locator('md-dialog.settings-dialog').getByRole('alert').filter({ hasText: '插件状态已变化，请重新导出。' });
    await expect(notice).toBeVisible();
    await expect(notice).toBeInViewport();
    expect(downloads).toBe(0);
    expect((await request.get(`${pluginUrl}/data-export`)).status()).toBe(200);
    await more.click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '导出已保存数据', exact: true }).click();
    const downloaded = await download;
    await expect(notice).toHaveCount(0);
    expect(downloaded.suggestedFilename()).toBe(`${id}-data.json`);
    const data = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
    expect(data).toEqual({ format: 'aervox-plugin-data/v1', pluginId: id, revision: 1, schemaVersion: 1, values: { note: 'retained personal data' } });

    await more.click();
    await page.getByRole('menuitem', { name: '卸载插件与数据', exact: true }).click();
    const confirmation = page.locator('md-dialog.avx-dialog-prompt').filter({ hasText: '卸载插件与数据' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '保留', exact: true }).click();
    expect((await request.get(`${pluginUrl}/data-export`)).status()).toBe(200);
    await more.click();
    await page.getByRole('menuitem', { name: '卸载插件与数据', exact: true }).click();
    const deleted = page.waitForResponse(response => response.url() === pluginUrl && response.request().method() === 'DELETE');
    await confirmation.getByRole('button', { name: '卸载并删除数据', exact: true }).click();
    expect((await deleted).status()).toBe(204);
    await expect(card).toHaveCount(0);
    expect((await request.get(`${pluginUrl}/data-export`)).status()).toBe(404);
  });
}
