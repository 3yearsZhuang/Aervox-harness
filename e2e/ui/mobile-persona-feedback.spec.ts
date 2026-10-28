import type { PersonaDetailResponse, PersonaMutationResponse } from '@aervox/contracts';
import { test, expect } from './fixtures';

test.use({ platform: 'mobile' });

for (const width of [320, 1024]) {
  for (const outcome of ['load failure', 'save success'] as const) {
    test(`keeps ${outcome} feedback in view after closing an editor below a long persona list at ${width}px`, async ({ page, request, servers }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // These records belong to the fixture's disposable database, so both list layout and saving use the real API.
      for (let index = 0; index < 18; index++) {
        const response = await request.post(`${servers.apiUrl}/v1/personas`, { data: {
          name: `长列表角色 ${width}-${outcome}-${index}`,
          description: '用于验证滚动到角色列表底部后，操作反馈仍可见。'.repeat(3),
          config: { systemPromptAppend: 'A deterministic browser fixture persona.' },
        } });
        expect(response.status(), await response.text()).toBe(201);
      }
      await page.goto(servers.webUrl);
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.locator('md-dialog.mobile-settings-dialog');
      await settings.getByRole('tab', { name: '角色', exact: true }).click();
      await expect(settings.locator('.persona-card').last()).toBeAttached();
      const edit = settings.locator('.persona-card').last().getByRole('button', { name: '编辑', exact: true });
      await edit.scrollIntoViewIfNeeded();
      await expect(settings.locator('.settings-heading')).not.toBeInViewport();

      let failedReads = 0;
      if (outcome === 'load failure') {
        await page.route(/\/v1\/personas\/[^/?]+$/, async route => {
          if (route.request().method() !== 'GET') return route.continue();
          failedReads++;
          await route.fulfill({ status: 503, contentType: 'application/problem+json',
            body: JSON.stringify({ title: '详情读取失败', detail: '角色详情暂不可用，请重试', status: 503 }) });
        });
      }
      await edit.click();
      const editor = page.locator('md-dialog.persona-edit-dialog');
      if (outcome === 'save success') {
        await expect(editor).toBeVisible();
        const name = `浏览器保存成功 ${width}`;
        await editor.locator('#persona-name').fill(name);
        const savedResponse = page.waitForResponse(response => response.request().method() === 'PATCH'
          && /\/v1\/personas\/[^/?]+$/.test(new URL(response.url()).pathname));
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        const response = await savedResponse;
        expect(response.status(), await response.text()).toBe(200);
        const saved = await response.json() as PersonaMutationResponse;
        const detail = await request.get(`${servers.apiUrl}/v1/personas/${saved.persona.id}`);
        expect((await detail.json() as PersonaDetailResponse).persona.name).toBe(name);
      } else {
        await expect.poll(() => failedReads).toBe(1);
      }
      await expect(editor).toBeHidden();
      const notice = settings.locator(`.persona-manager > [role="${outcome === 'load failure' ? 'alert' : 'status'}"]`);
      await expect(notice).toContainText(outcome === 'load failure' ? '角色详情暂不可用' : '人格已更新');
      await expect(notice).toBeInViewport({ ratio: 1, timeout: 5000 });
    });
  }
}
