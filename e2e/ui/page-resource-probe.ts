import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import type { Page } from "@playwright/test";

// This disposable transport evaluates a proposal, never production composition.
// It uses the real browser boundary/Bearer hooks and the unchanged Page CSP.
type ProbeRequest = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"] };
interface ProbeReply { code(status: number): ProbeReply; send(body: unknown): void }
type ProbeHook = (request: ProbeRequest, reply: ProbeReply) => Promise<void>;
interface Hooks {
  createAuthHook(config: { mode: "token"; token: string }): ProbeHook;
  createBrowserBoundaryHook(config: { mode: "token" }): ProbeHook;
  isOpaquePageResourceRequest(request: ProbeRequest): boolean;
  isPageResourceRequest(request: ProbeRequest): boolean;
}
let pageCsp = "";
let hooks: Hooks;
let loading: Promise<void> | undefined;
function loadProductionPolicy() {
  return loading ??= (async () => {
    const routeSource = await readFile(resolve("packages/host-runtime/src/modules/ecosystem/plugins/config-routes.ts"), "utf8");
    const policies = [...routeSource.matchAll(/\.header\("Content-Security-Policy", "([^"]+)"\)/g)];
    if (policies.length !== 1) throw new Error("probe needs exactly one literal production Page CSP");
    pageCsp = policies[0]![1]!;
    const hooksBuild = await build({
      stdin: { contents: 'export * from "./auth.ts"; export * from "./browser-boundary.ts";',
        resolveDir: resolve("packages/host-runtime/src/shared") },
      bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
    });
    const module = { exports: {} as Hooks };
    // Only repository-owned hook code is evaluated, without generated files.
    new Function("require", "module", "exports", hooksBuild.outputFiles[0]!.text)(createRequire(resolve("package.json")), module, module.exports);
    hooks = module.exports;
  })();
}

export type SameSite = "Strict" | "Lax" | "None";
export type Generation = "lifecycle" | "page" | "bundle" | "document";
interface Identity { lifecycle: string; page: string; bundle: string; document: string }
interface Session { identity: Identity; plugin: string; expires: number; revoked: boolean }
export interface ResourceEvent { method: string; path: string; destination: string; origin: string | null; status: number; cookie: boolean; bearer: boolean }
const mime: Record<string, string> = { html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2" };

export const moduleSource = `import { label } from './child.mjs';
document.querySelector('#module').textContent = label;
document.querySelector('#module').dataset.url = import.meta.url;
window.probeModule = true;`;
const childSource = "export const label = 'nested module loaded';";
const classicSource = "document.querySelector('#classic').textContent = 'classic loaded'; window.probeClassic = true;";
const styleSource = "@import './nested/palette.css'; @font-face {font-family: Probe; src: url('./probe.woff2')} #font {font-family: Probe} #styled {border-width: 3px; border-style: solid}";
const paletteSource = "#styled {border-color: rgb(17, 34, 51)}";
const imageSource = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="7"><rect width="9" height="7" fill="#123"/></svg>';
const assetBodies: Record<string, string | Buffer> = {
  "classic.js": classicSource, "nested/main.mjs": moduleSource, "nested/child.mjs": childSource,
  "style.css": styleSource, "nested/palette.css": paletteSource, "image.svg": imageSource,
  // The unchanged CSP blocks this request before any font bytes are read.
  "probe.woff2": Buffer.from("synthetic-font-network-sentinel"),
  "late.js": "window.probeLate = true;",
};

function bodyMarkup() {
  return '<p id="classic">not loaded</p><p id="module">not loaded</p><p id="styled">styled</p><p id="font">font probe</p><img id="image" alt="probe"><output id="ticks">0</output>';
}
function inlineObserver() {
  return `<script>window.probeViolations = []; window.probeTicks = 0;
  document.addEventListener('securitypolicyviolation', e => window.probeViolations.push(e.effectiveDirective));
  setInterval(() => { document.querySelector('#ticks').textContent = String(++window.probeTicks); }, 20);
  window.probeLateLoad = () => { const script = document.createElement('script'); script.src = './late.js'; document.body.append(script); };</script>`;
}
function documentBody(credentialed: boolean, foreignClassic?: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head><body>${bodyMarkup()}
  ${inlineObserver()}<script src="${foreignClassic ?? "./classic.js"}"></script>
  <script type="module" ${credentialed ? 'crossorigin="use-credentials"' : ""} src="./nested/main.mjs"></script>
  <script>document.querySelector('#image').src = './image.svg';</script></body></html>`;
}
const freshIdentity = (): Identity => ({ lifecycle: "l1", page: "p1", bundle: "b1", document: "d1" });
function prefix(plugin: string, identity: Identity) {
  return `/v1/plugins/${plugin}/pages/probe/assets/${identity.lifecycle}/${identity.page}/${identity.bundle}/${identity.document}/`;
}
function parseCookies(header: string | undefined) {
  return new Map((header ?? "").split(";").map(item => item.trim().split("=", 2)).filter(pair => pair.length === 2) as [string, string][]);
}
function matches(left: Identity, right: Identity) { return Object.keys(left).every(key => left[key as Generation] === right[key as Generation]); }
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

export class ResourceProbe {
  readonly events: ResourceEvent[] = [];
  readonly identities = new Map<string, Identity>();
  private readonly bearer = randomBytes(32).toString("hex");
  private readonly sessions = new Map<string, Session>();
  private auth!: ProbeHook;
  private boundary!: ProbeHook;
  private readonly api = createServer((request, response) => { void this.handle(request, response).catch(() => this.send(response, 500, "probe error")); });
  private readonly host = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    // The host has its own policy. Each srcdoc also receives the actual Page CSP.
    response.end('<!doctype html><html><body><main id="frames"></main></body></html>');
  });
  apiOrigin = "";
  hostOrigin = "";
  private clockOffset = 0;
  private credentialed = true;
  private foreignClassic: string | undefined;
  private bearerOnly = false;

  async start() {
    await loadProductionPolicy();
    this.auth = hooks.createAuthHook({ mode: "token", token: this.bearer });
    this.boundary = hooks.createBrowserBoundaryHook({ mode: "token" });
    this.apiOrigin = await listen(this.api); this.hostOrigin = await listen(this.host);
  }
  async stop() { await Promise.all([close(this.api), close(this.host)]); this.sessions.clear(); }
  useBearerOnly() { this.bearerOnly = true; }
  useDefaultModuleCredentials() { this.credentialed = false; }
  useForeignClassic(url: string) { this.foreignClassic = url; }
  resourceUrl(plugin = "one") { return `${this.apiOrigin}${prefix(plugin, this.identities.get(plugin) ?? freshIdentity())}index.html`; }
  assetUrl(plugin: string, asset: string) { return this.resourceUrl(plugin).replace(/index\.html$/, asset); }
  rotate(plugin: string, generation: Generation) {
    const current = this.identities.get(plugin)!;
    this.identities.set(plugin, { ...current, [generation]: `${current[generation]}-next` });
  }
  revoke(plugin: string) { for (const session of this.sessions.values()) if (session.plugin === plugin) session.revoked = true; }
  expire() { this.clockOffset += 61_000; }

  async openHost(page: Page) { await page.goto(this.hostOrigin); }
  async issue(page: Page, sameSite: SameSite = "None", secure = true, plugin = "one") {
    const status = await page.evaluate(async ({ apiOrigin, credential, sameSite, secure, plugin }) => {
      const response = await fetch(`${apiOrigin}/probe/issue`, { method: "POST", credentials: "include",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sameSite, secure, plugin }) });
      return response.status;
    }, { apiOrigin: this.apiOrigin, credential: this.bearer, sameSite, secure, plugin });
    if (status !== 204) throw new Error(`probe issuance rejected: ${status}`);
  }
  async mount(page: Page, plugin = "one") {
    const url = this.resourceUrl(plugin);
    await page.evaluate(url => {
      const frame = document.createElement("iframe"); frame.id = "probe-frame";
      frame.sandbox.add("allow-scripts", "allow-forms", "allow-downloads");
      frame.src = url; document.querySelector("#frames")!.append(frame);
    }, url);
    return page.frameLocator("#probe-frame");
  }
  async mountPreloaded(page: Page, bundle: boolean) {
    const identity = freshIdentity();
    this.identities.set("one", identity);
    // A trusted host performs the authenticated preload; only bytes reach Page JS.
    const files = bundle ? ["index.html", "classic.js", "nested/main.mjs", "nested/child.mjs", "style.css", "nested/palette.css", "image.svg"] : ["index.html"];
    const received = await page.evaluate(async ({ apiOrigin, credential, path, files }) => Promise.all(files.map(async file => {
      const response = await fetch(`${apiOrigin}${path}${file}`, { headers: { Authorization: `Bearer ${credential}` } });
      return { file, status: response.status, body: response.ok ? await response.text() : "" };
    })), { apiOrigin: this.apiOrigin, credential: this.bearer, path: prefix("one", identity), files });
    if (received.some(file => file.status !== 200)) throw new Error("authenticated preload rejected");
    const assets = Object.fromEntries(received.map(file => [file.file, file.body]));
    let markup = assets["index.html"]!;
    if (bundle) {
      const built = await build({ stdin: { contents: assets["nested/main.mjs"]!, sourcefile: "main.mjs", resolveDir: "/probe" },
        plugins: [{ name: "memory-graph", setup(plugin) {
          plugin.onResolve({ filter: /^\.\/child\.mjs$/ }, () => ({ path: "child.mjs", namespace: "probe" }));
          plugin.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ contents: assets["nested/child.mjs"]!, loader: "js" }));
        } }], bundle: true, write: false, format: "esm", logLevel: "silent" });
      const code = built.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
      markup = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pageCsp}">
        <style>${assets["style.css"]!.replace("@import './nested/palette.css';", assets["nested/palette.css"]!)}</style></head><body>${bodyMarkup()}${inlineObserver()}
        <script>${assets["classic.js"]}</script><script type="module">${code}</script>
        <script>document.querySelector('#image').src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(assets["image.svg"]!).toString("base64")}`)};</script></body></html>`;
    } else {
      markup = markup.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pageCsp}">`);
    }
    await page.evaluate(markup => {
      const frame = document.createElement("iframe"); frame.id = "probe-frame";
      frame.sandbox.add("allow-scripts", "allow-forms", "allow-downloads");
      frame.srcdoc = markup; document.querySelector("#frames")!.append(frame);
    }, markup);
    return page.frameLocator("#probe-frame");
  }
  async bearerStatus(path: string) { return (await fetch(`${this.apiOrigin}${path}`, { headers: { Authorization: `Bearer ${this.bearer}` } })).status; }

  private send(response: ServerResponse, status: number, body: string | Buffer) {
    if (response.writableEnded) return;
    response.statusCode = status; response.end(body);
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url!, this.apiOrigin).pathname;
    const event = { method: request.method ?? "", path, destination: String(request.headers["sec-fetch-dest"] ?? ""),
      origin: request.headers.origin ?? null, status: 0, cookie: Boolean(request.headers.cookie), bearer: Boolean(request.headers.authorization) };
    this.events.push(event);
    response.on("finish", () => { event.status = response.statusCode; });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reply = { code(status: number) { response.statusCode = status; return this; }, send(body: unknown) { response.end(JSON.stringify(body)); } };
    const req = { method: request.method, url: request.url, headers: request.headers };
    await this.boundary(req, reply);
    if (response.writableEnded) return;
    if (request.headers.origin === this.hostOrigin) {
      response.setHeader("Access-Control-Allow-Origin", this.hostOrigin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
    } else if (hooks.isOpaquePageResourceRequest(req)) {
      response.setHeader("Access-Control-Allow-Origin", "null");
      // Proposal-only change, restricted to the actual read-only resource predicate.
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (request.method === "OPTIONS") {
      if (request.headers.origin !== this.hostOrigin) return this.send(response, 403, "origin denied");
      response.setHeader("Access-Control-Allow-Methods", "POST, GET");
      response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      return this.send(response, 204, "");
    }
    if (path === "/probe/issue") {
      await this.auth(req, reply);
      if (response.writableEnded) return;
      if (request.method !== "POST" || request.headers.origin !== this.hostOrigin) return this.send(response, 403, "issuance origin denied");
      let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 4096) return this.send(response, 413, "too large"); }
      const { sameSite, secure, plugin } = JSON.parse(body);
      if (!["Strict", "Lax", "None"].includes(sameSite) || typeof secure !== "boolean" || !["one", "two"].includes(plugin)) return this.send(response, 400, "invalid probe policy");
      const identity = this.identities.get(plugin) ?? freshIdentity(); this.identities.set(plugin, identity);
      const credential = randomBytes(32).toString("hex");
      this.sessions.set(credential, { plugin, identity: { ...identity }, expires: Date.now() + this.clockOffset + 60_000, revoked: false });
      response.setHeader("Set-Cookie", `probe_resource=${credential}; Path=${prefix(plugin, identity)}; Max-Age=60; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`);
      return this.send(response, 204, "");
    }
    const resource = /^\/v1\/plugins\/(one|two)\/pages\/probe\/assets\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (!resource || this.bearerOnly || request.headers.authorization) {
      await this.auth(req, reply);
      if (response.writableEnded) return;
      if (!resource) return this.send(response, 200, "protected JSON");
    } else {
      if (!hooks.isPageResourceRequest(req)) return this.send(response, 403, "resource destination denied");
      const session = this.sessions.get(parseCookies(request.headers.cookie).get("probe_resource") ?? "");
      if (!session || session.expires <= Date.now() + this.clockOffset) return this.send(response, 401, "resource session expired or missing");
      const requested: Identity = { lifecycle: resource[2]!, page: resource[3]!, bundle: resource[4]!, document: resource[5]! };
      if (session.revoked || session.plugin !== resource[1] || !matches(session.identity, requested) || !matches(session.identity, this.identities.get(session.plugin)!)) return this.send(response, 409, "resource session retired");
    }
    const asset = resource![6]!;
    const content = asset === "index.html" ? documentBody(this.credentialed, this.foreignClassic) : assetBodies[asset];
    if (content === undefined) return this.send(response, 404, "asset absent");
    response.setHeader("Content-Type", `${mime[asset.split(".").at(-1)!] ?? "application/octet-stream"}; charset=utf-8`);
    response.setHeader("Content-Security-Policy", pageCsp);
    return this.send(response, 200, content);
  }
}
