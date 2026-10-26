import { randomUUID } from "node:crypto";
import type { APIRequestContext, FrameLocator, Page } from "@playwright/test";
import { test, expect, openWorkbench } from "./fixtures";

test.use({ platform: "web" });

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Page lifecycle probe</title></head><body>
  <p id="ready">connecting</p>
  <label>Configuration value <input id="value"></label>
  <button id="read" type="button">Read configuration</button>
  <button id="save" type="button">Save configuration</button>
  <button id="notify" type="button">Notify host</button>
  <button id="close" type="button">Close Page</button>
  <output id="result" data-state="idle"></output>
  <script src="/v1/plugin-pages/bridge.js"></script>
  <script>
    const bridge = window.AervoxPluginPageBridge;
    const result = document.querySelector('#result');
    bridge.ready().then(() => { document.querySelector('#ready').textContent = 'ready'; });
    async function run(method) {
      result.dataset.state = 'pending';
      result.textContent = '';
      try {
        const value = method === 'getConfig' ? await bridge.getConfig()
          : method === 'saveConfig' ? await bridge.saveConfig({ values: { value: document.querySelector('#value').value } })
          : method === 'notify' ? await bridge.notify({ message: document.querySelector('#value').value })
          : await bridge.close();
        result.textContent = JSON.stringify({ ok: true, value });
        result.dataset.state = 'success';
      } catch (error) {
        result.textContent = JSON.stringify({ ok: false, error: error.message });
        result.dataset.state = 'error';
      }
    }
    document.querySelector('#read').addEventListener('click', () => { void run('getConfig'); });
    document.querySelector('#save').addEventListener('click', () => { void run('saveConfig'); });
    document.querySelector('#notify').addEventListener('click', () => { void run('notify'); });
    document.querySelector('#close').addEventListener('click', () => { void run('close'); });
  </script>
</body></html>`;

interface Probe {
  pluginId: string;
  pluginPath: string;
  configPath: string;
  api(path: string): string;
  register(capabilities?: string[]): Promise<string>;
  identity(): Promise<{ lifecycle: string; page: string }>;
}
const capabilities = ["config.read", "config.write", "host.notify", "host.close"];

async function createProbe(request: APIRequestContext, apiUrl: string): Promise<Probe> {
  const pluginId = `page-lifecycle-${randomUUID()}`;
  const pluginPath = `/v1/plugins/${pluginId}`;
  const configPath = `${pluginPath}/config`;
  const api = (path: string) => `${apiUrl}${path}`;
  const installed = await request.post(api("/v1/plugins"), {
    data: { id: pluginId, publisher: "synthetic-e2e", version: "1.0.0", installSource: "local" },
  });
  expect(installed.status(), await installed.text()).toBe(201);
  const schema = await request.put(api(`${configPath}/schema`), {
    data: { apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1,
      fields: [{ key: "value", type: "string", label: "Value", default: "initial" }] },
  });
  expect(schema.status(), await schema.text()).toBe(200);
  const register = async (grants = capabilities): Promise<string> => {
    const response = await request.post(api(`${pluginPath}/pages`), {
      data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities: grants },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).pageGeneration as string;
  };
  await register();
  const assets = await request.post(api(`${pluginPath}/pages/probe/assets`), {
    data: { files: [{ path: "index.html", contentBase64: Buffer.from(PAGE_HTML).toString("base64") }] },
  });
  expect(assets.status(), await assets.text()).toBe(201);
  return { pluginId, pluginPath, configPath, api, register,
    async identity() {
      const plugins = await request.get(api("/v1/plugins"));
      expect(plugins.status()).toBe(200);
      const lifecycle = (await plugins.json()).items.find((plugin: { id: string }) => plugin.id === pluginId).lifecycleGeneration as string;
      const pages = await request.get(api(`${pluginPath}/pages?${new URLSearchParams({ expectedLifecycleGeneration: lifecycle })}`));
      expect(pages.status()).toBe(200);
      return { lifecycle, page: (await pages.json()).pages.find((page: { id: string }) => page.id === "probe").pageGeneration as string };
    },
  };
}

const pageTests = test.extend<{ probe: Probe }>({
  probe: async ({ request, servers }, use) => {
    const probe = await createProbe(request, servers.apiUrl);
    try { await use(probe); }
    finally {
      const removed = await request.delete(probe.api(probe.pluginPath));
      expect(removed.status(), await removed.text()).toBe(204);
    }
  },
});

async function openPluginPage(page: Page, pluginId: string): Promise<FrameLocator> {
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: /^扩展插件/ }).click();
  const card = settings.locator(".plugin-card").filter({ has: page.getByText(pluginId, { exact: true }) });
  await expect(card).toBeVisible();
  await card.getByTitle("打开插件页面", { exact: true }).click();
  return readyFrame(page);
}

async function readyFrame(page: Page): Promise<FrameLocator> {
  const frame = page.frameLocator("iframe.plugin-page-frame");
  await expect(frame.locator("#ready")).toHaveText("ready");
  return frame;
}

async function refreshPage(page: Page): Promise<FrameLocator> {
  await page.locator(".plugin-page-toolbar").getByRole("button", { name: "刷新", exact: true }).click();
  return readyFrame(page);
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  value?: { revision: number; values: { value: string } };
}
async function callConfig(page: Page, frame: FrameLocator, configPath: string, method: "GET" | "PUT") {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === configPath
    && response.request().method() === method);
  await frame.getByRole("button", { name: method === "GET" ? "Read configuration" : "Save configuration", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(frame.locator("#result")).toHaveAttribute("data-state", "success");
  const result = JSON.parse((await frame.locator("#result").textContent())!) as BridgeResult;
  expect(result.ok).toBe(true);
  return { response, result };
}

pageTests("real Bridge carries captured identity, rejects config races and explicitly reopens fresh Page declarations", async ({ page, request, servers, probe }) => {
  const { configPath, api } = probe;
  const initial = await probe.identity();
  await openWorkbench(page, servers.webUrl);
  let frame = await openPluginPage(page, probe.pluginId);
  const read = await callConfig(page, frame, configPath, "GET");
  const query = new URL(read.response.url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({ expectedLifecycleGeneration: initial.lifecycle,
    expectedPageId: "probe", expectedPageGeneration: initial.page });
  expect(read.result.value).toMatchObject({ revision: 0, values: { value: "initial" } });
  await frame.locator("#value").fill("committed configuration");
  const saved = await callConfig(page, frame, configPath, "PUT");
  expect(saved.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: initial.lifecycle,
    expectedPageId: "probe", expectedPageGeneration: initial.page, revision: 0 });
  expect(saved.result.value).toMatchObject({ revision: 1, values: { value: "committed configuration" } });

  // A real PUT reaches HTTP after the Bridge probe; an independent client removes
  // and restores the Page grant before the configuration transaction starts.
  const oldFrame = await page.locator("iframe.plugin-page-frame").elementHandle();
  await page.route(api(configPath), async route => {
    if (route.request().method() === "PUT") { await probe.register([]); await probe.register(); }
    await route.continue();
  });
  try {
    await frame.locator("#value").fill("stale write");
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === configPath && response.request().method() === "PUT");
    await frame.getByRole("button", { name: "Save configuration", exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
    expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(false);
    const unchanged = await request.get(api(configPath));
    expect(await unchanged.json()).toMatchObject({ revision: 1, values: { value: "committed configuration" } });
    const oldReset = await request.post(api(`${configPath}/reset?${query}`));
    expect(oldReset.status()).toBe(409);
  } finally { await page.unroute(api(configPath)); }

  frame = await refreshPage(page);
  const fresh = await probe.identity();
  expect(fresh.lifecycle).toBe(initial.lifecycle);
  expect(fresh.page).not.toBe(initial.page);
  const refreshedRead = await callConfig(page, frame, configPath, "GET");
  expect(new URL(refreshedRead.response.url()).searchParams.get("expectedPageGeneration")).toBe(fresh.page);

  // The real GET also carries the captured declaration through a successful
  // preflight; replacement before HTTP admission cannot disclose configuration.
  await page.route(`${api(configPath)}?*`, async route => {
    if (route.request().method() === "GET") await probe.register();
    await route.continue();
  });
  try {
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === configPath && response.request().method() === "GET");
    await frame.getByRole("button", { name: "Read configuration", exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(409);
    expect(new URL(response.url()).searchParams.get("expectedPageGeneration")).toBe(fresh.page);
    expect(JSON.stringify(await response.json())).not.toContain("committed configuration");
    await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
  } finally { await page.unroute(`${api(configPath)}?*`); }

  frame = await refreshPage(page);
  const currentRead = await callConfig(page, frame, configPath, "GET");
  const currentQuery = new URL(currentRead.response.url()).searchParams;
  const reset = await request.post(api(`${configPath}/reset?${currentQuery}`));
  expect(reset.status()).toBe(200);
  expect(await reset.json()).toMatchObject({ revision: 2, values: { value: "initial" } });
  const persisted = await request.get(api(configPath));
  expect(await persisted.json()).toMatchObject({ revision: 2, values: { value: "initial" } });
  await frame.locator("#value").fill("current Page notification");
  await frame.getByRole("button", { name: "Notify host", exact: true }).click();
  await expect(page.getByText("current Page notification", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Close Page", exact: true }).click();
  await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
});

for (const change of ["plugin lifecycle", "Page declaration"] as const) {
  pageTests(`quiet Page is removed after external ${change} changes and cannot revive without an explicit fresh reopen`, async ({ page, request, servers, probe }) => {
    const before = await probe.identity();
    await openWorkbench(page, servers.webUrl);
    let frame = await openPluginPage(page, probe.pluginId);
    const oldFrame = await page.locator("iframe.plugin-page-frame").elementHandle();
    const configurationCalls: string[] = [];
    const capture = (req: import("@playwright/test").Request) => {
      if (new URL(req.url()).pathname === probe.configPath) configurationCalls.push(req.method());
    };
    page.on("request", capture);
    try {
      // No Bridge call follows ready(): the host must observe this external change.
      if (change === "plugin lifecycle") {
        for (const enabled of [false, true]) {
          const response = await request.patch(probe.api(probe.pluginPath), { data: { enabled } });
          expect(response.status()).toBe(200);
        }
      } else { await probe.register([]); await probe.register(); }
      await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(false);
      expect(configurationCalls).toEqual([]);
      await expect(page.locator(".plugin-page-toolbar")).toBeVisible();
      const current = await probe.identity();
      expect(change === "plugin lifecycle" ? current.lifecycle : current.page)
        .not.toBe(change === "plugin lifecycle" ? before.lifecycle : before.page);
      // Focus/visibility resumes cannot recover a latched document, even though
      // the external client has already restored an enabled, writable declaration.
      await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
      await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
      expect(configurationCalls).toEqual([]);
      frame = await refreshPage(page);
      const read = await callConfig(page, frame, probe.configPath, "GET");
      const query = new URL(read.response.url()).searchParams;
      expect(query.get("expectedLifecycleGeneration")).toBe(current.lifecycle);
      expect(query.get("expectedPageGeneration")).toBe(current.page);
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(false);
    } finally { page.off("request", capture); }
  });
}
