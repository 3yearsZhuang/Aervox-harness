import { randomUUID } from "node:crypto";
import type { FrameLocator, Page } from "@playwright/test";
import { test, expect, openWorkbench } from "./fixtures";

test.use({ platform: "web" });

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Page lifecycle probe</title></head><body>
  <p id="ready">connecting</p>
  <label>Configuration value <input id="value"></label>
  <button id="read" type="button">Read configuration</button>
  <button id="save" type="button">Save configuration</button>
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
          : await bridge.saveConfig({ values: { value: document.querySelector('#value').value } });
        result.textContent = JSON.stringify({ ok: true, value });
        result.dataset.state = 'success';
      } catch (error) {
        result.textContent = JSON.stringify({ ok: false, error: error.message });
        result.dataset.state = 'error';
      }
    }
    document.querySelector('#read').addEventListener('click', () => { void run('getConfig'); });
    document.querySelector('#save').addEventListener('click', () => { void run('saveConfig'); });
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
    new URL(response.url()).pathname === configPath && response.request().method() === method);
  await frame.getByRole("button", { name: method === "GET" ? "Read configuration" : "Save configuration", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(expectedStatus);
  await expect(frame.locator("#result")).toHaveAttribute("data-state", expectedStatus === 200 ? "success" : "error");
  const result = JSON.parse((await frame.locator("#result").textContent())!) as BridgeResult;
  expect(result.ok).toBe(expectedStatus === 200);
  return { response, result };
}

test("real Page Bridge configuration calls reject an old enabled lifecycle and succeed after host reload", async ({ page, request, servers }) => {
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
      data: { id: "probe", title: "Lifecycle probe", entry: "pages/probe/index.html", capabilities: ["config.read", "config.write"] },
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
    const frame = await openPluginPage(page, pluginId);
    const oldFrame = await page.locator("iframe.plugin-page-frame").elementHandle();
    expect(oldFrame).not.toBeNull();
    const initialRead = await callConfig(page, frame, configPath, "GET", 200);
    expect(new URL(initialRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
    expect(initialRead.result.value).toMatchObject({ revision: 0, values: { value: "initial" } });
    await frame.locator("#value").fill("first lifecycle");
    const initialSave = await callConfig(page, frame, configPath, "PUT", 200);
    expect(initialSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: initialGeneration, revision: 0 });
    expect(initialSave.result.value).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });

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

    const oldRead = await callConfig(page, frame, configPath, "GET", 409);
    expect(new URL(oldRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(initialGeneration);
    expect(await oldRead.response.json()).toMatchObject({ code: "PLUGIN_CONFIG_REVISION_CONFLICT" });
    expect(oldRead.result.error).toContain("lifecycle changed");
    await frame.locator("#value").fill("late old lifecycle write");
    const oldSave = await callConfig(page, frame, configPath, "PUT", 409);
    expect(oldSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: initialGeneration, revision: 1 });
    expect(await oldSave.response.json()).toMatchObject({ code: "PLUGIN_CONFIG_REVISION_CONFLICT" });
    expect(oldSave.result.error).toContain("lifecycle changed");
    const unchanged = await request.get(api(configPath));
    expect(unchanged.status()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });

    // Reload through the actual host UI, which obtains the current PluginSummary and opens a new Page.
    await page.reload({ timeout: 90_000 });
    await expect(page.locator(".aervox-workbench")).toBeVisible();
    const currentFrame = await openPluginPage(page, pluginId);
    const currentRead = await callConfig(page, currentFrame, configPath, "GET", 200);
    expect(new URL(currentRead.response.url()).searchParams.get("expectedLifecycleGeneration")).toBe(currentGeneration);
    expect(currentRead.result.value).toMatchObject({ revision: 1, values: { value: "first lifecycle" } });
    await currentFrame.locator("#value").fill("current lifecycle");
    const currentSave = await callConfig(page, currentFrame, configPath, "PUT", 200);
    expect(currentSave.response.request().postDataJSON()).toMatchObject({ expectedLifecycleGeneration: currentGeneration, revision: 1 });
    expect(currentSave.result.value).toMatchObject({ revision: 2, values: { value: "current lifecycle" } });
    const persisted = await request.get(api(configPath));
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({ revision: 2, values: { value: "current lifecycle" } });
  } finally {
    const removed = await request.delete(api(pluginPath));
    expect(removed.status(), await removed.text()).toBe(204);
  }
});
