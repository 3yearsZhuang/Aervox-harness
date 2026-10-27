import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect, openWorkbench } from './fixtures';

test.use({ platform: 'mobile', loopProvider: 'replay' });
const statePath = '/v1/plugins/flowcampus/state';
interface CampusSnapshot {
  revision: number;
  lifecycleGeneration: string;
  state: {
    version: number;
    places: { id: string; name: string; address: string }[];
    events: { id: string; title: string; startAt: string; endAt: string; placeId: string; status: string }[];
    tasks: { id: string; title: string; estimatedMinutes: number; priority: string; status: string }[];
    routes: { originId: string; destinationId: string; durationSeconds: number; source: string; observedAt: string }[];
    settings: { originId: string | null; bufferMinutes: number; timezone: string };
  };
}
async function read(request: APIRequestContext, apiUrl: string): Promise<CampusSnapshot> {
  const response = await request.get(apiUrl + statePath);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function write(request: APIRequestContext, apiUrl: string, snapshot: CampusSnapshot) {
  const response = await request.put(apiUrl + statePath, { data: { state: snapshot.state,
    expectedRevision: snapshot.revision, expectedLifecycleGeneration: snapshot.lifecycleGeneration } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<CampusSnapshot>;
}
test.beforeEach(async ({ request, servers }) => {
  const enabled = await request.patch(`${servers.apiUrl}/v1/plugins/flowcampus`, { data: { enabled: true } });
  expect(enabled.status(), await enabled.text()).toBe(200);
  const snapshot = await read(request, servers.apiUrl);
  snapshot.state = { version: 1, places: [], events: [], tasks: [], routes: [],
    settings: { originId: null, bufferMinutes: 5, timezone: 'Asia/Shanghai' } };
  await write(request, servers.apiUrl, snapshot);
});
async function openCampus(page: Page, webUrl: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webUrl}/?surface=proactive-ui`, { timeout: 90_000 });
  const card = page.locator('.campus-home-card');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.getByRole('button', { name: '查看与管理', exact: true }).click();
  const dialog = page.locator('.campus-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '重新加载', exact: true })).toBeEnabled();
  return dialog;
}
async function category(dialog: Locator, name: string) {
  await dialog.getByRole('button', { name, exact: true }).click();
}
async function saveItem(page: Page, dialog: Locator) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === statePath && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存条目', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog.locator('.campus-editor')).toHaveCount(0);
}
async function addPlace(page: Page, dialog: Locator, name: string) {
  await category(dialog, '地点');
  await dialog.getByRole('button', { name: '添加地点', exact: true }).click();
  await dialog.getByLabel('地点名称', { exact: true }).fill(name);
  await saveItem(page, dialog);
}

test('mobile manages a durable campus plan and shares its budget across tasks', async ({ page, request, servers }, testInfo) => {
  const initial = await read(request, servers.apiUrl);
  expect(initial.state.places).toEqual([]);
  const dialog = await openCampus(page, servers.webUrl);
  await expect(dialog).toContainText('暂无待出发行程');
  await addPlace(page, dialog, '宿舍');
  await addPlace(page, dialog, '教学楼');
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await category(dialog, '课表与日程');
  await dialog.getByRole('button', { name: '添加课程或日程', exact: true }).click();
  await dialog.getByLabel('课程或日程名称', { exact: true }).fill('线性代数');
  await dialog.getByLabel('开始时间', { exact: true }).fill(`${tomorrow}T08:30`);
  await dialog.getByLabel('结束时间', { exact: true }).fill(`${tomorrow}T10:00`);
  const places = (await read(request, servers.apiUrl)).state.places;
  const dorm = places.find(p => p.name === '宿舍')!;
  const classroom = places.find(p => p.name === '教学楼')!;
  await dialog.getByRole('combobox', { name: '目的地点', exact: true }).selectOption(classroom.id);
  await saveItem(page, dialog);
  await category(dialog, '路线耗时');
  await dialog.getByRole('button', { name: '添加路线', exact: true }).click();
  await dialog.getByRole('combobox', { name: '起点', exact: true }).selectOption(dorm.id);
  await dialog.getByRole('combobox', { name: '终点', exact: true }).selectOption(classroom.id);
  await dialog.getByLabel('预计耗时（分钟）', { exact: true }).fill('14');
  await saveItem(page, dialog);
  await category(dialog, '出发设置');
  await dialog.getByRole('combobox', { name: '当前出发地点', exact: true }).selectOption(dorm.id);
  const settingsResponse = page.waitForResponse(r => new URL(r.url()).pathname === statePath && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存出发设置', exact: true }).click();
  expect((await settingsResponse).status()).toBe(200);
  await category(dialog, '空档任务');
  for (const [title, minutes, priority] of [['背单词', '10', 'high'], ['预习', '8', 'medium'], ['整理笔记', '6', 'low']]) {
    await dialog.getByRole('button', { name: '添加任务', exact: true }).click();
    await dialog.getByLabel('任务名称', { exact: true }).fill(title!);
    await dialog.getByLabel('预计用时（分钟）', { exact: true }).fill(minutes!);
    await dialog.getByRole('combobox', { name: '优先程度', exact: true }).selectOption(priority!);
    await saveItem(page, dialog);
  }
  const response = await request.get(`${servers.apiUrl}/v1/plugins/flowcampus/plan`, { params: { at: `${tomorrow}T07:55:00+08:00` } });
  expect(response.status()).toBe(200);
  const { plan } = await response.json();
  expect(Date.parse(plan.departureAt)).toBe(Date.parse(`${tomorrow}T08:11:00+08:00`));
  expect(plan.freeMinutes).toBe(16);
  expect(plan.recommendedTasks.map((t: { title: string }) => t.title)).toEqual(['背单词', '整理笔记']);
  await category(dialog, '出发计划');
  await expect(dialog.locator('.campus-departure')).toContainText('08:11');
  await page.screenshot({ path: testInfo.outputPath('campus-mobile-plan.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('.campus-home-card')).toContainText('线性代数');
  await page.locator('.campus-home-card').getByRole('button', { name: '查看与管理', exact: true }).click();
  await category(dialog, '课表与日程');
  await dialog.locator('.campus-list li').filter({ hasText: '线性代数' }).getByRole('button', { name: '已到达', exact: true }).click();
  await expect(dialog).toContainText('已到达');
  await category(dialog, '出发计划');
  await expect(dialog).toContainText('暂无待出发行程');
  await page.keyboard.press('Escape');
  await openWorkbench(page, servers.webUrl);
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  await expect(page.locator('.campus-home-card')).toBeVisible();
  await page.locator('.campus-home-card').getByRole('button', { name: '查看与管理', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: '统一任务中心', exact: true })).not.toBeVisible();
});

test('editing a route preserves whole seconds through native form validation', async ({ page, request, servers }) => {
  const snapshot = await read(request, servers.apiUrl);
  snapshot.state.places = [
    { id: 'dorm', name: '宿舍', address: '' },
    { id: 'classroom', name: '教学楼', address: '' },
  ];
  snapshot.state.routes = [{ originId: 'dorm', destinationId: 'classroom', durationSeconds: 841,
    source: 'manual', observedAt: '2026-10-27T00:00:00Z' }];
  await write(request, servers.apiUrl, snapshot);
  const dialog = await openCampus(page, servers.webUrl);
  await category(dialog, '路线耗时');
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  const minutes = dialog.getByLabel('预计耗时（分钟）', { exact: true });
  expect(await minutes.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await saveItem(page, dialog);
  expect((await read(request, servers.apiUrl)).state.routes[0]!.durationSeconds).toBe(841);
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await minutes.fill('14.05');
  expect(await minutes.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await saveItem(page, dialog);
  expect((await read(request, servers.apiUrl)).state.routes[0]!.durationSeconds).toBe(843);
});

test('an independent HTTP writer triggers a real CAS conflict while the editor keeps its draft', async ({ page, request, servers }) => {
  const dialog = await openCampus(page, servers.webUrl);
  await addPlace(page, dialog, '原地点');
  await dialog.locator('.campus-list li').filter({ hasText: '原地点' }).getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByLabel('地点名称', { exact: true }).fill('保留的草稿');
  // Commit the independent writer only after the browser has sent its stale
  // snapshot, so periodic plan refresh cannot detect the conflict first.
  const stateRoute = '**' + statePath;
  await page.route(stateRoute, async route => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    const remote = await read(request, servers.apiUrl);
    expect(route.request().postDataJSON().expectedRevision).toBe(remote.revision);
    remote.state.places.push({ id: 'remote-place', name: '另一页面的地点', address: '' });
    await write(request, servers.apiUrl, remote);
    await route.continue();
  });
  const failed = page.waitForResponse(r => new URL(r.url()).pathname === statePath && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存条目', exact: true }).click();
  expect((await failed).status()).toBe(409);
  await page.unroute(stateRoute);
  await expect(dialog.getByLabel('地点名称', { exact: true })).toHaveValue('保留的草稿');
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出校园数据', exact: true }).click();
  const file = await downloaded;
  const exported = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(exported.format).toBe('aervox-flowcampus');
  expect(exported.state.places.map((p: { name: string }) => p.name)).toEqual(['原地点', '另一页面的地点']);
  await expect(dialog.getByLabel('地点名称', { exact: true })).toHaveValue('保留的草稿');
  await dialog.getByRole('button', { name: '重新加载并保留草稿', exact: true }).click();
  await expect(dialog).toContainText('另一页面的地点');
  await expect(dialog.getByLabel('地点名称', { exact: true })).toHaveValue('保留的草稿');
  await saveItem(page, dialog);
  expect((await read(request, servers.apiUrl)).state.places.map(p => p.name)).toEqual(['保留的草稿', '另一页面的地点']);
});

test('a committed write with a lost response keeps a stable ID after explicit reload', async ({ page, request, servers }) => {
  const dialog = await openCampus(page, servers.webUrl);
  await category(dialog, '空档任务');
  await dialog.getByRole('button', { name: '添加任务', exact: true }).click();
  await dialog.getByLabel('任务名称', { exact: true }).fill('未知结果任务');
  let committed = false;
  await page.route(`**${statePath}`, async route => {
    if (route.request().method() !== 'PUT' || committed) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(dialog).toContainText('保存结果尚未确认');
  const before = await read(request, servers.apiUrl);
  expect(before.state.tasks).toHaveLength(1);
  await page.unroute(`**${statePath}`);
  await dialog.getByRole('button', { name: '重新加载并保留草稿', exact: true }).click();
  await expect(dialog).toContainText('重新加载发现此草稿已保存');
  await saveItem(page, dialog);
  const after = await read(request, servers.apiUrl);
  expect(after.state.tasks).toHaveLength(1);
  expect(after.state.tasks[0]!.id).toBe(before.state.tasks[0]!.id);
});

test('short mobile view preserves back layers and disabling removes the plugin while retaining its data', async ({ page, request, servers }, testInfo) => {
  const dialog = await openCampus(page, servers.webUrl);
  await addPlace(page, dialog, '保留地点');
  await page.setViewportSize({ width: 320, height: 360 });
  await dialog.getByRole('button', { name: '添加地点', exact: true }).click();
  await dialog.getByLabel('地点名称', { exact: true }).fill('未保存草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('campus-short-editor.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.campus-editor')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.campus-home-card').getByRole('button', { name: '查看与管理', exact: true })).toBeFocused();
  const old = await read(request, servers.apiUrl);
  const disabled = await request.patch(`${servers.apiUrl}/v1/plugins/flowcampus`, { data: { enabled: false } });
  expect(disabled.status()).toBe(200);
  await page.reload();
  await expect(page.locator('.proactive-companion')).toBeVisible();
  await expect(page.locator('.campus-home-card')).toHaveCount(0);
  const stale = await request.put(servers.apiUrl + statePath, { data: { state: old.state,
    expectedRevision: old.revision, expectedLifecycleGeneration: old.lifecycleGeneration } });
  expect(stale.ok()).toBe(false);
  const enabled = await request.patch(`${servers.apiUrl}/v1/plugins/flowcampus`, { data: { enabled: true } });
  expect(enabled.status()).toBe(200);
  const restored = await read(request, servers.apiUrl);
  expect(restored.lifecycleGeneration).not.toBe(old.lifecycleGeneration);
  expect(restored.state.places.map(p => p.name)).toEqual(['保留地点']);
  await page.reload();
  await expect(page.locator('.campus-home-card')).toBeVisible();
});
