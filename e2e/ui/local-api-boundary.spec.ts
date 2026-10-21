import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { buildHostRuntime } from "../../packages/host-runtime/dist/index.js";
import type { createInMemoryDatabase } from "../../packages/repositories/dist/index.js";

// Exercise API admission independently of browser-version local-network permission prompts.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights"] } });

let root: string;
let app: Awaited<ReturnType<typeof buildHostRuntime>>["app"];
let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let parent: Server;
let apiBase: string;
let parentBase: string;
let sessionId: string;
const completed: Array<{ method: string; url: string; origin?: string; status: number }> = [];

async function api(method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBase}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  // The root Playwright configuration is CommonJS; retain native ESM for runtime artifacts.
  const importRuntime = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
  const { buildHostRuntime } = await importRuntime(pathToFileURL(path.resolve("packages/host-runtime/dist/index.js")).href) as typeof import("../../packages/host-runtime/dist/index.js");
  const { createInMemoryDatabase, createProactiveVaultCipher } = await importRuntime(pathToFileURL(path.resolve("packages/repositories/dist/index.js")).href) as typeof import("../../packages/repositories/dist/index.js");
  root = await mkdtemp(path.join(tmpdir(), "aervox-browser-boundary-"));
  database = await createInMemoryDatabase();
  await mkdir(path.join(root, "builtin"));
  await mkdir(path.join(root, "repo"));
  await writeFile(path.join(root, "repo", "synthetic.txt"), "SYNTHETIC_PRIVATE_FILE");
  const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(7), "browser-test");
  ({ app } = await buildHostRuntime({
    db: database.db, client: database.client, auth: { mode: "open" },
    skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins"),
    attachmentsRoot: path.join(root, "attachments"), builtinPluginsSourceRoot: path.join(root, "builtin"),
    migrationStatePath: path.join(root, "migration.json"), proactiveAccessToken: null, proactiveCipher: cipher,
    botOptions: { start: false, cipher }, mcpOptions: { dshRepoRoot: path.join(root, "repo") },
    modelRuntimeOptions: { modelsDir: path.join(root, "models"), driver: null, metricsIntervalMs: 0 },
  }));
  app.addHook("onResponse", async (req, reply) => {
    completed.push({ method: req.method, url: req.url, origin: req.headers.origin, status: reply.statusCode });
  });
  apiBase = await app.listen({ port: 0, host: "127.0.0.1" });
  expect((await api("POST", "/v1/plugins", { id: "browser-demo", publisher: "synthetic", version: "1.0.0" })).status).toBe(201);
  expect((await api("POST", "/v1/plugins/browser-demo/pages", {
    id: "dashboard", title: "Synthetic Page", entry: "pages/dashboard/index.html", capabilities: [],
  })).status).toBe(201);
  const files = {
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
      <div id="styled">SYNTHETIC_PAGE</div><img id="pixel" src="pixel.png">
      <script src="/v1/plugin-pages/bridge.js"></script><script src="classic.js"></script>
      <script type="module" src="module.mjs"></script></body></html>`,
    "classic.js": "parent.postMessage('CLASSIC_LOADED', '*')",
    "module.mjs": "parent.postMessage('MODULE_LOADED', '*')",
    "style.css": "#styled { color: rgb(12, 34, 56); }",
  };
  expect((await api("POST", "/v1/plugins/browser-demo/pages/dashboard/assets", {
    files: [...Object.entries(files).map(([filePath, content]) => ({ path: filePath, contentBase64: Buffer.from(content).toString("base64") })),
      { path: "pixel.png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=" }],
  })).status).toBe(201);
  const session = await api("POST", "/v1/sessions", { title: "SYNTHETIC_PRIVATE_SESSION" });
  expect(session.status).toBe(201);
  sessionId = (await session.json() as { id: string }).id;
  parent = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><script>window.messages=[];addEventListener('message',e=>messages.push(e.data));</script>
      <iframe sandbox="allow-scripts allow-forms allow-downloads" src="${apiBase}/v1/plugins/browser-demo/pages/dashboard/assets/index.html"></iframe>`);
  });
  await new Promise<void>(resolve => parent.listen(0, "127.0.0.1", resolve));
  parentBase = `http://localhost:${(parent.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  if (parent) await new Promise<void>((resolve, reject) => parent.close(error => error ? reject(error) : resolve()));
  if (app) await app.close();
  if (database) await database.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

test("cross-site sandbox Page loads classic/module scripts, CSS, image and Bridge", async ({ page }) => {
  const responses = new Map<string, number>();
  page.on("response", response => { if (response.url().startsWith(apiBase)) responses.set(new URL(response.url()).pathname, response.status()); });
  await page.goto(parentBase);
  await expect.poll(() => page.evaluate(() => (window as unknown as { messages: string[] }).messages.sort())).toEqual(["CLASSIC_LOADED", "MODULE_LOADED"]);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#styled")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect.poll(() => frame.locator("#pixel").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect.poll(() => responses.get("/v1/plugin-pages/bridge.js")).toBe(200);
  expect(responses.get("/v1/plugins/browser-demo/pages/dashboard/assets/module.mjs")).toBe(200);
  expect(completed.some(request => request.url.endsWith("module.mjs") && request.origin === "null" && request.status === 200)).toBe(true);
});

test("hostile browser Origin cannot read, create, delete or call DSH", async ({ page }) => {
  const origin = "http://attacker.invalid";
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic attacker</title>" }));
  await page.goto(`${origin}/`);
  const results = await page.evaluate(async ({ base, id }) => {
    const attempts = [
      { path: "/v1/sessions", options: {} },
      { path: "/v1/sessions", options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "UNAUTHORIZED_SESSION" }) } },
      { path: `/v1/sessions/${id}`, options: { method: "DELETE" } },
      { path: "/v1/mcp/dsh", options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dsh_read_file", arguments: { path: "synthetic.txt" } } }) } },
    ];
    return Promise.all(attempts.map(async attempt => {
      try { const response = await fetch(`${base}${attempt.path}`, attempt.options); return { readable: response.ok, status: response.status }; }
      catch { return { readable: false }; }
    }));
  }, { base: apiBase, id: sessionId });
  expect(results.every(result => !result.readable)).toBe(true);
  await expect.poll(() => completed.filter(request => request.origin === origin && request.status === 403).length).toBeGreaterThanOrEqual(4);
  const sessions = await (await api("GET", "/v1/sessions")).json() as { items: Array<{ id: string; title: string }> };
  expect(sessions.items).toEqual([expect.objectContaining({ id: sessionId, title: "SYNTHETIC_PRIVATE_SESSION" })]);
  expect(completed.some(request => request.origin === origin && request.status < 400)).toBe(false);
});
