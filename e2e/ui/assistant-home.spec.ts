import { test, expect } from './fixtures';

test('restores an older selection, pages read-only history, and keeps per-session drafts through home navigation', async ({ page, servers, platform }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(platform === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const rows = Array.from({ length: 103 }, (_, i) => ({ id: `home_s${i}`, title: `已保存会话 ${i}`, createdAt: '2026-11-06', updatedAt: '2026-11-06' }));
  let writes = 0;
  const reads: string[] = [];
  await page.route('**/v1/sessions**', async route => {
    const request = route.request();
    if (request.method() !== 'GET' && request.method() !== 'OPTIONS') writes++;
    if (request.method() !== 'GET') { await route.continue(); return; }
    const url = new URL(request.url());
    reads.push(url.pathname + url.search);
    let body: unknown;
    if (url.pathname.endsWith('/history')) {
      body = { sessionId: 'home_s102', nextCursor: url.searchParams.has('cursor') ? null : 'earlier', items: url.searchParams.has('cursor') ? [{
        turnId: 'home_saved_turn', status: 'Completed', isComplete: true, createdAt: '2026-11-06', messages: [{
          messageId: 'home_saved_message', versionId: 'home_saved_version', version: 1, role: 'assistant', contentKind: 'message',
          content: '这是原会话中已保存的结果。', visibility: 'available', legacy: false, readOnly: false, createdAt: '2026-11-06',
        }],
      }] : [] };
    } else if (url.pathname === '/v1/sessions') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      body = { items: rows.slice(offset, offset + limit) };
    } else body = rows.find(row => url.pathname === `/v1/sessions/${row.id}`);
    await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => localStorage.setItem('aervox_active_session_id', 'home_s102'));
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
  const nav = page.getByRole('navigation', { name: '首页入口' });
  await expect(nav.getByRole('button')).toHaveCount(4);
  await expect(nav.getByRole('button', { name: /接着上次/ })).toBeEnabled();
  await expect(page.locator('.pc-current-session')).toHaveText('已保存会话 102');
  for (const button of await nav.getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 });
  const input = page.locator('.pc-whisper-input').locator(platform === 'mobile' ? 'textarea' : 'input');
  await input.fill('原会话未发送的草稿');
  await expect(page.locator('.pc-dialogue-text')).toContainText('想聊什么，直接告诉我。');
  await page.screenshot({ path: `/tmp/aervox-assistant-home-${platform}.png` });
  await nav.getByRole('button', { name: /接着上次/ }).click();
  const history = page.locator('.mobile-history-dialog');
  await expect(page.getByRole('dialog', { name: '对话回看', exact: true })).toBeVisible();
  await expect(history).toContainText('这一页暂无可显示的对话记录。');
  await history.getByRole('button', { name: '更早一页', exact: true }).click();
  await expect(history).toContainText('这是原会话中已保存的结果。');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('原会话未发送的草稿');
  await nav.getByRole('button', { name: /今日/ }).click();
  await expect(page.getByRole('dialog', { name: '今日', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '学习规划', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '学习规划', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '学习能力', exact: true })).toBeVisible();
  const topic = page.getByRole('textbox', { name: '学习主题', exact: true });
  await topic.fill('先保留这份学习主题');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '学习规划', exact: true }).click();
  await expect(topic).toHaveValue('先保留这份学习主题');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: /日记/ }).click();
  if (platform === 'mobile') await expect(page.locator('.pc-deck-slide').last()).toBeInViewport();
  else { await expect(page.getByRole('dialog', { name: '日记', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); }
  await nav.getByRole('button', { name: /记录/ }).click();
  const list = page.locator('.mobile-sessions-dialog');
  await expect(list.locator('.mobile-session-list > li')).toHaveCount(100);
  await list.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await expect(list.locator('.mobile-session-list > li')).toHaveCount(103);
  const search = list.getByRole('searchbox', { name: '搜索已加载会话', exact: true });
  await search.fill('已保存会话 0');
  await list.locator('.mobile-session-select').click();
  await expect(input).toHaveValue('');
  await input.fill('另一会话的草稿');
  await nav.getByRole('button', { name: /记录/ }).click();
  await search.fill('已保存会话 102');
  await list.locator('.mobile-session-select').click();
  await expect(input).toHaveValue('原会话未发送的草稿');
  await page.reload();
  await expect(input).toHaveValue('原会话未发送的草稿');
  await expect(page.locator('.pc-current-session')).toHaveText('已保存会话 102');
  expect(reads).toContain('/v1/sessions?limit=100&offset=100');
  expect(reads.some(path => path === '/v1/sessions/home_s102')).toBe(true);
  expect(reads.some(path => path.includes('cursor=earlier'))).toBe(true);
  expect(writes).toBe(0);
});
