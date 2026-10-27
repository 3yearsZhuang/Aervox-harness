import { test, expect } from './fixtures';

test.use({ platform: 'mobile', loopProvider: 'replay' });

async function createSession(request: import('@playwright/test').APIRequestContext, api: string, title: string) {
  const response = await request.post(`${api}/v1/sessions`, { data: { title } });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string; title: string };
}

async function selectInitial(page: import('@playwright/test').Page, id: string) {
  await page.addInitScript(id => {
    localStorage.setItem('aervox_active_session_id', id);
    localStorage.setItem('aervox-theme', 'light');
  }, id);
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

test('mobile sessions, independent saved history and per-session drafts stay in the same screen', async ({ page, request, servers }, info) => {
  const a = await createSession(request, servers.apiUrl, '手机会话 A');
  const b = await createSession(request, servers.apiUrl, '手机会话 B');
  const accepted = await request.post(`${servers.apiUrl}/v1/sessions/${a.id}/turns`, {
    headers: { 'Idempotency-Key': `mobile-history-${a.id}` },
    data: { message: { content: '此前已经保存的手机消息', contentType: 'text' }, clientVersion: 'mobile-interaction-e2e' },
  });
  expect(accepted.status()).toBe(201);
  await expect.poll(async () => (await (await request.get(`${servers.apiUrl}/v1/sessions/${a.id}/history`)).json()).items.some((turn: { status: string }) => turn.status === 'Completed')).toBe(true);
  await selectInitial(page, a.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(servers.webUrl);
  const input = page.locator('.pc-whisper-input textarea');
  await expect(input).toBeVisible();
  await expect(page.getByRole('button', { name: '回到完整工作台', exact: true })).toHaveCount(0);
  await input.fill('会话 A 的草稿');
  await input.press('Enter');
  await expect(input).toHaveValue('会话 A 的草稿\n');
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const sessions = page.locator('md-dialog.mobile-sessions-dialog');
  await expect(page.getByRole('dialog', { name: '会话', exact: true })).toBeVisible();
  await sessions.getByRole('button', { name: '手机会话 B 继续对话', exact: true }).click();
  await expect(sessions).toBeHidden();
  await expect(page.locator('.pc-current-session')).toHaveText('手机会话 B');
  await expect(input).toHaveValue('');
  await input.fill('会话 B 的草稿');
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await sessions.getByRole('button', { name: '回看「手机会话 A」', exact: true }).click();
  const history = page.locator('md-dialog.mobile-history-dialog');
  await expect(page.getByRole('dialog', { name: '对话回看', exact: true })).toBeVisible();
  await expect(history).toContainText('此前已经保存的手机消息');
  await expect(history).toContainText('已完成');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('aervox_active_session_id'))).toBe(b.id);
  await page.evaluate(() => window.history.back());
  await expect(history).toBeHidden();
  await expect(page.getByRole('dialog', { name: '会话', exact: true })).toBeVisible();
  await sessions.getByRole('button', { name: '手机会话 A 继续对话', exact: true }).click();
  await expect(page.locator('.pc-current-session')).toHaveText('手机会话 A');
  await expect(input).toHaveValue('会话 A 的草稿\n');
  await page.reload();
  await expect(input).toHaveValue('会话 A 的草稿\n');
  await input.fill('重新打开的多行草稿\n第二行\n第三行');
  await page.reload();
  await expect(input).toHaveValue('重新打开的多行草稿\n第二行\n第三行');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThanOrEqual(72);
  await page.setViewportSize({ width: 320, height: 360 });
  await input.click();
  await expect.poll(async () => { const box = await input.boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: info.outputPath('mobile-drafts-short.png') });
});

test('back dismisses only the top mobile layer while live observation and draft remain owned', async ({ page, request, servers }) => {
  const a = await createSession(request, servers.apiUrl, '运行中的手机会话');
  await createSession(request, servers.apiUrl, '稍后切换的会话');
  await selectInitial(page, a.id);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') calls.push(request.url()); });
  await page.route(`**/v1/sessions/${a.id}/turns`, route => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ turnId: 'turn_mobile_held' }) }));
  await page.route('**/v1/turns/turn_mobile_held/events', async route => {
    await held;
    await route.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: [
      { turnId: 'turn_mobile_held', sequence: 1, eventType: 'delta', data: { text: '原会话的回复继续抵达。' } },
      { turnId: 'turn_mobile_held', sequence: 2, eventType: 'done', data: {} },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  try {
    await page.goto(servers.webUrl);
    const input = page.locator('.pc-whisper-input textarea');
    await input.fill('正在发送的消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('下一条消息的草稿');
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const sessions = page.locator('md-dialog.mobile-sessions-dialog');
    await expect(sessions.getByRole('button', { name: '新对话', exact: true })).toBeDisabled();
    await expect(sessions.getByRole('status')).toContainText('回复尚未结束');
    await expect(sessions.getByRole('button', { name: '回看「稍后切换的会话」', exact: true })).toBeEnabled();
    await page.evaluate(() => window.history.back());
    await expect(sessions).toBeHidden();
    await expect(input).toHaveValue('下一条消息的草稿');
    await page.evaluate(() => window.history.back());
    await expect(page.locator('.proactive-companion')).toBeFocused();
    expect(calls.some(path => path.endsWith('/cancel'))).toBe(false);
    finish();
    await expect(page.locator('.pc-dialogue-text')).toContainText('原会话的回复继续抵达');
    await expect(input).toHaveValue('下一条消息的草稿');
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    await expect(sessions.getByRole('button', { name: '新对话', exact: true })).toBeEnabled();
  } finally { finish(); }
});

test('retrying an uncertain mobile submission uses the original request and preserves a newer draft', async ({ page, request, servers }) => {
  const a = await createSession(request, servers.apiUrl, '回执恢复');
  await selectInitial(page, a.id);
  const keys: string[] = [];
  let acknowledge!: () => void;
  const receipt = new Promise<void>(resolve => { acknowledge = resolve; });
  await page.route(`**/v1/sessions/${a.id}/turns`, async route => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{}' });
    else { await receipt; await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify({ turnId: 'turn_mobile_recovered' }) }); }
  });
  await page.route('**/v1/turns/turn_mobile_recovered/events', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ turnId: 'turn_mobile_recovered', sequence: 1, eventType: 'done', data: {} })}\n\n` }));
  try {
    await page.goto(servers.webUrl);
    const input = page.locator('.pc-whisper-input textarea');
    await input.fill('回执未确认的原消息'); await page.getByRole('button', { name: '发送', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试发送', exact: true });
    await expect(retry).toBeVisible(); await input.fill(''); await expect(retry).toBeEnabled(); await retry.click();
    await expect.poll(() => keys.length).toBe(2);
    await input.fill('恢复期间编辑的新草稿'); acknowledge();
    await expect(page.locator('.pc-feedback')).toContainText('本次回复已完成');
    await expect(input).toHaveValue('恢复期间编辑的新草稿');
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/); expect(keys[1]).toBe(keys[0]);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  } finally { acknowledge(); }
});


test('reloading an owned mobile input retires the prior history guard before restoring a new one', async ({ page, request, servers }) => {
  const session = await createSession(request, servers.apiUrl, '重载后的返回');
  await selectInitial(page, session.id);
  await page.goto(servers.webUrl);
  const input = page.locator('.pc-whisper-input textarea');
  await input.fill('返回也要保留的草稿'); await input.focus();
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.__aervoxMobileBack))).toBe(true);
  const length = await page.evaluate(() => history.length);
  for (let index = 0; index < 2; index++) {
    await page.reload();
    await expect(input).toHaveValue('返回也要保留的草稿');
    await expect.poll(() => page.evaluate(() => history.state?.__aervoxMobileBack?.kind)).toBe('guard');
    expect(await page.evaluate(() => history.length)).toBe(length);
    expect(await page.evaluate(() => Boolean(history.state.__aervoxMobileBack.original?.__aervoxMobileBack))).toBe(false);
  }
  await page.evaluate(() => history.back());
  await expect(page.locator('.proactive-companion')).toBeFocused();
  await expect(input).toHaveValue('返回也要保留的草稿');
  expect(await page.evaluate(() => Boolean(history.state?.__aervoxMobileBack))).toBe(false);
});
