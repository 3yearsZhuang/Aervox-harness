import type { SessionHistoryPage } from '@aervox/contracts';
import { test, expect, openWorkbench } from './fixtures';

// Real SQLite/API/browser reads with a deterministic local model fixture.
test.use({ loopProvider: 'replay', platform: 'web' });

test('restores a page-external selection with 100 real workbench session menus', async ({ page, servers }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const rows = Array.from({ length: 103 }, (_, index) => ({
    id: `workbench-page-${index}`, title: `保存会话 ${index}`,
    createdAt: '2026-11-06', updatedAt: '2026-11-06',
  }));
  const selected = rows[102]!;
  const reads: string[] = [];
  const writes: string[] = [];
  await page.route('**/v1/sessions**', async route => {
    const request = route.request();
    if (request.method() === 'POST') writes.push(request.url());
    if (request.method() !== 'GET') { await route.continue(); return; }
    const url = new URL(request.url());
    reads.push(url.pathname + url.search);
    const body = url.pathname === '/v1/sessions'
      ? { items: rows.slice(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('offset') ?? 0) + Number(url.searchParams.get('limit') ?? 100)) }
      : url.pathname.endsWith('/history')
        ? { sessionId: selected.id, nextCursor: null, items: [{
          turnId: 'page-external-turn', status: 'Completed', isComplete: true, createdAt: '2026-11-06', messages: [{
            messageId: 'page-external-message', versionId: 'page-external-version', version: 1,
            role: 'assistant', contentKind: 'message', content: '这是第一页之外原会话保存的正文。',
            visibility: 'available', legacy: false, readOnly: false, createdAt: '2026-11-06',
          }],
        }] } satisfies SessionHistoryPage
        : rows.find(row => url.pathname === `/v1/sessions/${row.id}`);
    await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(id => {
    localStorage.setItem('aervox_active_session_id', id);
    localStorage.setItem('aervox-workbench-mode', 'standard');
  }, selected.id);
  await openWorkbench(page, servers.webUrl);
  await expect(page.locator('.session-select')).toHaveCount(100);
  await expect(page.locator('.session-select').first()).toBeVisible();
  await expect(page.locator('.session-active-title')).toHaveText(selected.title);
  await expect(page.locator('.standard-conversation')).toContainText('这是第一页之外原会话保存的正文。');
  await expect(page.locator('.session-identity-notice')).toHaveCount(0);
  expect(reads).toContain('/v1/sessions?limit=100&offset=0');
  expect(reads).toContain(`/v1/sessions/${selected.id}`);
  expect(writes).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`selected conversations refill saved text without submitting after reload: ${width}px`, async ({ page, request, servers }, testInfo) => {
    const saved: Array<{ id: string; title: string; content: string }> = [];
    for (const suffix of ['A', 'B']) {
      const title = `接着上次 ${suffix} ${width}`;
      const session = await request.post(`${servers.apiUrl}/v1/sessions`, { data: { title } });
      expect(session.status()).toBe(201);
      const { id } = await session.json() as { id: string };
      const content = `整理这份材料 ${suffix} ${width}`;
      const accepted = await request.post(`${servers.apiUrl}/v1/sessions/${id}/turns`, {
        headers: { 'Idempotency-Key': `continuity-${id}` },
        data: { message: { content, contentType: 'text' }, clientVersion: 'continuity-browser-e2e' },
      });
      expect(accepted.status()).toBe(201);
      await expect.poll(async () => {
        const response = await request.get(`${servers.apiUrl}/v1/sessions/${id}/history`);
        const value = await response.json() as SessionHistoryPage;
        return value.items.some(turn => turn.status === 'Completed' && turn.isComplete);
      }).toBe(true);
      saved.push({ id, title, content });
    }
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((id: string) => {
      // Initial selection is seeded once so reload also exercises the user's
      // persisted selection after choosing the other conversation.
      if (!localStorage.getItem('aervox_active_session_id')) localStorage.setItem('aervox_active_session_id', id);
      localStorage.setItem('aervox-workbench-mode', 'standard');
    }, saved[0]!.id);
    const browserTurns: string[] = [];
    page.on('request', value => {
      if (value.method() === 'POST' && /\/turns(?:\?|$)/.test(value.url())) browserTurns.push(value.url());
    });
    await openWorkbench(page, servers.webUrl);
    const conversation = page.locator('.standard-conversation');
    await expect(conversation).toContainText(saved[0]!.content);
    await expect(conversation).not.toContainText(saved[1]!.content);
    await expect(conversation.locator('.standard-message.assistant')).not.toHaveCount(0);
    const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.session-select').filter({ hasText: saved[1]!.title }).click();
    await expect(conversation).toContainText(saved[1]!.content);
    await expect(conversation).not.toContainText(saved[0]!.content);
    await page.reload();
    await expect(conversation).toContainText(saved[1]!.content);
    await expect(conversation).not.toContainText(saved[0]!.content);
    expect(browserTurns).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`session-continuity-${width}.png`), animations: 'disabled' });
  });

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
