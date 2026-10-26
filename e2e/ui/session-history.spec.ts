import type { SessionHistoryPage } from '@aervox/contracts';
import { test, expect, openWorkbench } from './fixtures';

// Real SQLite/API/browser reads with a deterministic local model fixture.
test.use({ loopProvider: 'replay', platform: 'web' });

for (const width of [390, 1280]) {
  test(`saved history survives a fresh workbench, pages and clears deletion: ${width}px`, async ({ page, request, servers }, testInfo) => {
    const session = await request.post(`${servers.apiUrl}/v1/sessions`, { data: { title: `持久回看 ${width}` } });
    expect(session.status()).toBe(201);
    const { id: sessionId } = await session.json() as { id: string };
    const inputs = [`重新打开之前的第一轮 ${width}`, `重新打开之前的第二轮 ${width}`];
    for (const [index, content] of inputs.entries()) {
      const accepted = await request.post(`${servers.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        headers: { 'Idempotency-Key': `history-${sessionId}-${index}` },
        data: { message: { content, contentType: 'text' }, clientVersion: 'history-browser-e2e', references: [] },
      });
      expect(accepted.status()).toBe(201);
      await expect.poll(async () => {
        const response = await request.get(`${servers.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/history`);
        expect(response.status()).toBe(200);
        const value = await response.json() as SessionHistoryPage;
        return value.items.filter(turn => turn.status === 'Completed' && turn.isComplete && turn.messages.some(message => message.role === 'assistant')).length;
      }).toBe(index + 1);
    }

    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((id: string) => {
      localStorage.setItem('aervox_active_session_id', id);
      localStorage.setItem('aervox-workbench-mode', 'companion');
      localStorage.setItem('aervox-theme', 'light');
    }, sessionId);
    await page.route('https://cubism.live2d.com/**', route => route.abort());
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    const browserTurns: string[] = [];
    page.on('request', value => {
      if (value.method() === 'POST' && /\/turns(?:\?|$)/.test(value.url())) browserTurns.push(value.url());
    });
    await openWorkbench(page, servers.webUrl);
    await expect(page.locator('.aervox-workbench')).not.toContainText(inputs[0]!);
    await page.getByRole('button', { name: '展开菜单', exact: true }).click();
    await page.getByRole('button', { name: '工具管理', exact: true }).click();
    const tools = page.getByRole('dialog', { name: '工具管理', exact: true });
    await expect(tools).toBeVisible();
    await tools.getByRole('button', { name: /对话回看/ }).click();
    await tools.getByRole('button', { name: '打开已保存的对话记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '对话回看', exact: true });
    await expect(history).toBeVisible();
    await expect(history).toContainText(inputs[0]!);
    await expect(history).toContainText(inputs[1]!);
    await expect(history.locator('.history-turn')).toHaveCount(2);
    await expect(history.locator('.vn-history-line.assistant')).toHaveCount(2);
    await expect(history.locator('.history-turn-status').first()).toHaveText('已完成');
    await expect(history).not.toContainText('我是');

    await history.getByRole('combobox', { name: '历史每页轮数' }).selectOption('1');
    await expect(history.locator('.history-turn')).toHaveCount(1);
    await expect(history).toContainText(inputs[1]!);
    await expect(history).not.toContainText(inputs[0]!);
    await history.getByRole('button', { name: '更早一页', exact: true }).click();
    await expect(history).toContainText(inputs[0]!);
    await expect(history).not.toContainText(inputs[1]!);
    await expect(history.locator('.history-turn')).toHaveCount(1);
    await history.getByRole('button', { name: '回到最新记录', exact: true }).click();
    await expect(history).toContainText(inputs[1]!);
    await expect(history).not.toContainText(inputs[0]!);
    expect(await history.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`saved-history-${width}.png`), animations: 'disabled' });

    expect((await request.delete(`${servers.apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}`)).status()).toBe(204);
    await history.getByRole('button', { name: '刷新最新记录', exact: true }).click();
    await expect(history.getByRole('alert')).toContainText('记录可能已删除');
    await expect(history).not.toContainText(inputs[0]!);
    await expect(history).not.toContainText(inputs[1]!);
    await expect(history.locator('.history-turn')).toHaveCount(0);
    expect(browserTurns).toEqual([]);
  });
}
