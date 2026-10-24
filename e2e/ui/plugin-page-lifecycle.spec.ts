import { randomUUID } from "node:crypto";
import type { FrameLocator, Page } from "@playwright/test";
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

async function openPluginPage(page: Page, pluginId: string): Promise<FrameLocator> {
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: /^扩展插件/ }).click();
  const card = settings.locator(".plugin-card").filter({ has: page.getByText(pluginId, { exact: true }) });
  await expect(card).toBeVisible();
  await card.getByTitle("打开插件页面", { exact: true }).click();
  const frame = page.frameLocator("iframe.plugin-page-frame");
  await expect(frame.locator("#ready")).toHaveText("ready");
  return frame;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  value?: { revision: number; values: { value: string } };
}

async function callConfig(
  page: Page,
  frame: FrameLocator,
  configPath: string,
  method: "GET" | "PUT",
  expectedStatus: number,
) {
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === (expectedStatus === 200 ? configPath : configPath.replace(/\/config$/, '/pages'))
      && response.request().method() === (expectedStatus === 200 ? method : 'GET'));
  await frame.getByRole("button", { name: method === "GET" ? "Read configuration" : "Save configuration", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(expectedStatus);
  await expect(frame.locator("#result")).toHaveAttribute("data-state", expectedStatus === 200 ? "success" : "error");
  const result = JSON.parse((await frame.locator("#result").textContent())!) as BridgeResult;
  expect(result.ok).toBe(expectedStatus === 200);
  return { response, result };
}

test("real Page Bridge rejects restored Page generations and old lifecycles, and succeeds after host reload", async ({ page, request, servers }) => {
  const pluginId = `page-lifecycle-${randomUUID()}`;
  const pluginPath = `/v1/plugins/${pluginId}`;
  const configPath = `${pluginPath}/config`;
  const api = (path: string) => `${servers.apiUrl}${path}`;
  const install = await request.post(api("/v1/plugins"), {
    data: { id: pluginId, publisher: "synthetic-e2e", version: "1.0.0", installSource: "local" },
  });
  expect(install.status(), await install.text()).toBe(201);
  try {
    const schema = await request.put(api(`${configPath}/schema`), {
      data: {
        apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1,
        fields: [{ key: "value", type: "string", label: "Value", default: "initial" }],
      },
    });
    expect(schema.status(), await schema.text()).toBe(200);
    const registerPage = await request.post(api(`${pluginPath}/pages`), {
      data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities: ["config.read", "config.write", "host.notify", "host.close"] },
    });
    expect(registerPage.status(), await registerPage.text()).toBe(201);
    const assets = await request.post(api(`${pluginPath}/pages/probe/assets`), {
      data: { files: [{ path: "index.html", contentBase64: Buffer.from(PAGE_HTML).toString("base64") }] },
    });
    expect(assets.status(), await assets.text()).toBe(201);
    const initialPlugins = await request.get(api("/v1/plugins"));
    expect(initialPlugins.status()).toBe(200);
    const initialGeneration = (await initialPlugins.json()).items.find((plugin: { id: string }) => plugin.id === pluginId).lifecycleGeneration as string;
    expect(initialGeneration).toBeTruthy();

    await openWorkbench(page, servers.webUrl);
    let frame = await openPluginPage(page, pluginId);
    let oldFrame = await page.locator("iframe.plugin-page-frame").elementHandle();
    expect(oldFrame).not.toBeNull();
    const initialRead = await callConfig(page, frame, configPath, "GET", 200);
    expect(new URL(initialRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
    expect(initialRead.result.value).toMatchObject({ revision: 0, values: { value: "initial" } });
    await frame.locator("#value").fill("first lifecycle");
    const initialSave = await callConfig(page, frame, configPath, "PUT", 200);
    expect(initialSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: initialGeneration, expectedPageId: "probe", revision: 0 });
    expect(initialSave.result.value).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });
    // Pause the real PUT after the Bridge's successful Page lookup. An independent
    // client removes config.write without changing the plugin lifecycle.
    const saveUrl = api(configPath);
    await page.route(saveUrl, async route => {
      if (route.request().method() === "PUT") {
        const revoked = await request.post(api(`${pluginPath}/pages`), {
          data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities: ["config.read", "host.notify", "host.close"] },
        });
        expect(revoked.status(), await revoked.text()).toBe(201);
      }
      await route.continue();
    });
    try {
      await frame.locator("#value").fill("revoked during save");
      const rejectedSave = page.waitForResponse(response => new URL(response.url()).pathname === configPath && response.request().method() === "PUT");
      await frame.getByRole("button", { name: "Save configuration", exact: true }).click();
      const rejected = await rejectedSave;
      expect(rejected.request().postDataJSON()).toMatchObject({ expectedPageId: "probe", expectedLifecycleGeneration: initialGeneration, revision: 1 });
      expect(rejected.status()).toBe(409);
      await expect(frame.locator("#result")).toHaveAttribute("data-state", "error");
      expect(JSON.parse((await frame.locator("#result").textContent())!)).toMatchObject({ ok: false });
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
      const unchangedAfterRevocation = await request.get(api(configPath));
      expect(unchangedAfterRevocation.status()).toBe(200);
      expect(await unchangedAfterRevocation.json()).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });
      const pluginsAfterRevocation = await request.get(api("/v1/plugins"));
      expect(pluginsAfterRevocation.status()).toBe(200);
      expect((await pluginsAfterRevocation.json()).items.find((plugin: { id: string }) => plugin.id === pluginId).lifecycleGeneration).toBe(initialGeneration);
    } finally {
      await page.unroute(saveUrl);
    }
    const restoreCapability = await request.post(api(`${pluginPath}/pages`), {
      data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities: ["config.read", "config.write", "host.notify", "host.close"] },
    });
    expect(restoreCapability.status(), await restoreCapability.text()).toBe(201);
    const restoredPageGeneration = (await restoreCapability.json()).pageGeneration as string;
    expect(restoredPageGeneration).toBeTruthy();
    expect(restoredPageGeneration).not.toBe(initialSave.response.request().postDataJSON().expectedPageGeneration);
    const restoredConfigRequests: string[] = [];
    const captureRestoredConfig = (req: import('@playwright/test').Request) => {
      if (new URL(req.url()).pathname === configPath) restoredConfigRequests.push(req.method());
    };
    page.on('request', captureRestoredConfig);
    await frame.locator("#value").fill("restored old Page notification");
    for (const name of ["Read configuration", "Save configuration", "Notify host", "Close Page"]) {
      const authorization = page.waitForResponse(response => new URL(response.url()).pathname === `${pluginPath}/pages`);
      await frame.getByRole("button", { name, exact: true }).click();
      expect((await authorization).status()).toBe(200);
      await expect(frame.locator("#result")).toHaveAttribute("data-state", "error");
      expect(JSON.parse((await frame.locator("#result").textContent())!)).toMatchObject({ ok: false, error: "page session is unavailable" });
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
    }
    page.off('request', captureRestoredConfig);
    expect(restoredConfigRequests).toEqual([]);
    await expect(page.getByText("restored old Page notification", { exact: true })).toHaveCount(0);

    // The actual host reload obtains a new Page generation within the same plugin lifecycle.
    await page.reload({ timeout: 90_000 });
    await expect(page.locator(".aervox-workbench")).toBeVisible();
    frame = await openPluginPage(page, pluginId);
    oldFrame = await page.locator("iframe.plugin-page-frame").elementHandle();
    const restoredRead = await callConfig(page, frame, configPath, "GET", 200);
    expect(restoredRead.result.value).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });
    await frame.locator("#value").fill("new Page generation");
    const restoredSave = await callConfig(page, frame, configPath, "PUT", 200);
    expect(restoredSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: initialGeneration, expectedPageGeneration: restoredPageGeneration, revision: 1 });
    expect(restoredSave.result.value).toMatchObject({ revision: 2, values: { value: "new Page generation" } });

    // Also pause a real write after its Page lookup, remove and restore the grant,
    // and prove the old request cannot commit even when current capabilities match.
    await page.route(saveUrl, async route => {
      if (route.request().method() === "PUT") {
        for (const capabilities of [[], ["config.read", "config.write", "host.notify", "host.close"]]) {
          const registered = await request.post(api(`${pluginPath}/pages`), {
            data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities },
          });
          expect(registered.status(), await registered.text()).toBe(201);
        }
      }
      await route.continue();
    });
    try {
      await frame.locator("#value").fill("reauthorized during save");
      const response = page.waitForResponse(response => new URL(response.url()).pathname === configPath && response.request().method() === "PUT");
      await frame.getByRole("button", { name: "Save configuration", exact: true }).click();
      const rejected = await response;
      expect(rejected.status()).toBe(409);
      expect(rejected.request().postDataJSON()).toMatchObject({ expectedPageGeneration: restoredPageGeneration, revision: 2 });
      await expect(frame.locator("#result")).toHaveAttribute("data-state", "error");
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
      const unchanged = await request.get(api(configPath));
      expect(await unchanged.json()).toMatchObject({ revision: 2, values: { value: "new Page generation" } });
      const currentPages = await request.get(api(`${pluginPath}/pages`));
      expect((await currentPages.json()).pages[0].capabilities).toContain("config.write");
      const currentPlugins = await request.get(api("/v1/plugins"));
      expect((await currentPlugins.json()).items.find((plugin: { id: string }) => plugin.id === pluginId).lifecycleGeneration).toBe(initialGeneration);
    } finally {
      await page.unroute(saveUrl);
    }

    // An independent API client changes the saved lifecycle before this host reloads its plugin list.
    const disabled = await request.patch(api(pluginPath), { data: { enabled: false } });
    expect(disabled.status(), await disabled.text()).toBe(200);
    const enabled = await request.patch(api(pluginPath), { data: { enabled: true } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    const currentPlugins = await request.get(api("/v1/plugins"));
    expect(currentPlugins.status()).toBe(200);
    const currentPlugin = (await currentPlugins.json()).items.find((plugin: { id: string }) => plugin.id === pluginId);
    const currentGeneration = currentPlugin.lifecycleGeneration as string;
    expect(currentPlugin.enabled).toBe(1);
    expect(currentGeneration).toBeTruthy();
    expect(currentGeneration).not.toBe(initialGeneration);
    expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);

    const blockedConfigRequests: string[] = [];
    const captureConfig = (req: import('@playwright/test').Request) => {
      if (new URL(req.url()).pathname === configPath) blockedConfigRequests.push(req.method());
    };
    page.on('request', captureConfig);
    const oldRead = await callConfig(page, frame, configPath, "GET", 409);
    expect(new URL(oldRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
    expect(oldRead.result.error).toContain("lifecycle changed");
    await frame.locator("#value").fill("late old lifecycle write");
    const oldSave = await callConfig(page, frame, configPath, "PUT", 409);
    expect(new URL(oldSave.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
    expect(oldSave.result.error).toContain("lifecycle changed");
    page.off('request', captureConfig);
    expect(blockedConfigRequests).toEqual([]);
    await frame.locator("#value").fill("revoked Page notification");
    for (const name of ["Notify host", "Close Page"]) {
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `${pluginPath}/pages`);
      await frame.getByRole("button", { name, exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(409);
      expect(new URL(response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
      await expect(frame.locator("#result")).toHaveAttribute("data-state", "error");
      expect(JSON.parse((await frame.locator("#result").textContent())!)).toMatchObject({ ok: false, error: expect.stringContaining("lifecycle changed") });
      expect(await oldFrame!.evaluate(element => element.isConnected)).toBe(true);
    }
    await expect(page.getByText("revoked Page notification", { exact: true })).toHaveCount(0);
    const unchanged = await request.get(api(configPath));
    expect(unchanged.status()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ revision: 2, values: { value: "new Page generation" } });

    // Reload through the actual host UI, which obtains the current PluginSummary and opens a new Page.
    await page.reload({ timeout: 90_000 });
    await expect(page.locator(".aervox-workbench")).toBeVisible();
    const currentFrame = await openPluginPage(page, pluginId);
    const currentRead = await callConfig(page, currentFrame, configPath, "GET", 200);
    expect(new URL(currentRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(currentGeneration);
    expect(currentRead.result.value).toMatchObject({ revision: 2, values: { value: "new Page generation" } });
    await currentFrame.locator("#value").fill("current lifecycle");
    const currentSave = await callConfig(page, currentFrame, configPath, "PUT", 200);
    expect(currentSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: currentGeneration, expectedPageId: "probe", revision: 2 });
    expect(currentSave.result.value).toMatchObject({ revision: 3, values: { value: "current lifecycle" } });
    const persisted = await request.get(api(configPath));
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({ revision: 3, values: { value: "current lifecycle" } });
    await currentFrame.locator("#value").fill("new lifecycle notification");
    await currentFrame.getByRole("button", { name: "Notify host", exact: true }).click();
    await expect(currentFrame.locator("#result")).toHaveAttribute("data-state", "success");
    await expect(page.getByText("new lifecycle notification", { exact: true })).toBeVisible();
    const closeAuthorization = page.waitForResponse(response => new URL(response.url()).pathname === `${pluginPath}/pages`);
    await currentFrame.getByRole("button", { name: "Close Page", exact: true }).click();
    expect((await closeAuthorization).status()).toBe(200);
    await expect(page.locator("iframe.plugin-page-frame")).toHaveCount(0);
  } finally {
    const removed = await request.delete(api(pluginPath));
    expect(removed.status(), await removed.text()).toBe(204);
  }
});
