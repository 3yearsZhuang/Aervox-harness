import { test as base, expect, type FrameLocator } from "@playwright/test";
import { ResourceProbe, type Generation } from "./page-resource-probe";

// Traces/HAR/video can capture synthetic Authorization/Set-Cookie. Disable them
// rather than redact a persisted credential after the test has already failed.
const test = base.extend<{ probe: ResourceProbe }>({
  probe: async ({}, use) => {
    const probe = new ResourceProbe(); await probe.start();
    try { await use(probe); } finally { await probe.stop(); }
  },
});
test.use({ trace: "off", video: "off", screenshot: "off" });

async function loaded(frame: FrameLocator) {
  await expect(frame.locator("#classic")).toHaveText("classic loaded");
  await expect(frame.locator("#module")).toHaveText("nested module loaded");
  await expect(frame.locator("#styled")).toHaveCSS("border-top-color", "rgb(17, 34, 51)");
  await expect.poll(() => frame.locator("#image").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(9);
}
async function opaque(frame: FrameLocator) {
  expect(await frame.locator("body").evaluate(() => window.origin)).toBe("null");
  expect(await frame.locator("body").evaluate(() => { try { return document.cookie; } catch { return "unavailable"; } })).toBe("unavailable");
}
async function fontBlocked(frame: FrameLocator, probe: ResourceProbe) {
  await expect.poll(() => frame.locator("body").evaluate(() => (window as unknown as { probeViolations: string[] }).probeViolations)).toContain("font-src");
  expect(probe.events.filter(event => event.path.endsWith("probe.woff2"))).toHaveLength(0);
}

test("current Bearer-only Page navigation rejects an iframe without credentials", async ({ page, probe }) => {
  probe.useBearerOnly(); await probe.openHost(page);
  const response = page.waitForResponse(response => response.url() === probe.resourceUrl());
  await probe.mount(page);
  expect((await response).status()).toBe(401);
  expect(probe.events.some(event => event.destination === "iframe" && !event.bearer)).toBe(true);
});

for (const sameSite of ["Strict", "Lax"] as const) {
  test(`${sameSite} cookie loads initial HTML but opaque nested resources lack its credential`, async ({ page, probe }) => {
    await probe.openHost(page); await probe.issue(page, sameSite, false);
    const frame = await probe.mount(page);
    await expect(frame.locator("#ticks")).not.toHaveText("0"); await opaque(frame);
    await expect.poll(() => probe.events.filter(event => event.path.endsWith("classic.js")).map(event => event.status)).toEqual([401]);
    expect(probe.events.find(event => event.path.endsWith("index.html"))?.status).toBe(200);
    expect(probe.events.filter(event => event.status === 401).every(event => !event.cookie)).toBe(true);
    // CSS itself was denied, so @font-face was never parsed.
    expect(probe.events.filter(event => event.path.endsWith("probe.woff2"))).toHaveLength(0);
  });
}

test("SameSite=None without Secure is rejected by the real browser", async ({ page, context, probe }) => {
  await probe.openHost(page); await probe.issue(page, "None", false);
  expect((await context.cookies()).some(cookie => cookie.name === "probe_resource")).toBe(false);
  const response = page.waitForResponse(response => response.url() === probe.resourceUrl());
  await probe.mount(page); expect((await response).status()).toBe(401);
});

test("None/Secure supports classic/CSS/image but default module credentials omit the cookie", async ({ page, probe }) => {
  probe.useDefaultModuleCredentials(); await probe.openHost(page); await probe.issue(page);
  const frame = await probe.mount(page); await opaque(frame);
  await expect(frame.locator("#classic")).toHaveText("classic loaded");
  await expect(frame.locator("#styled")).toHaveCSS("border-top-color", "rgb(17, 34, 51)");
  await expect.poll(() => probe.events.filter(event => event.path.endsWith("nested/main.mjs")).map(event => event.status)).toEqual([401]);
  await expect(frame.locator("#module")).toHaveText("not loaded");
  await fontBlocked(frame, probe);
});

test("None/Secure plus use-credentials loads the nested module graph under the unchanged CSP", async ({ page, context, probe }) => {
  await probe.openHost(page); await probe.issue(page);
  const cookiePolicy = (await context.cookies()).filter(cookie => cookie.name === "probe_resource")
    .map(({ httpOnly, secure, sameSite, path, expires }) => ({ httpOnly, secure, sameSite, path, expires: expires > Date.now() / 1000 }));
  expect(cookiePolicy).toEqual([{ httpOnly: true, secure: true, sameSite: "None",
    path: new URL(probe.resourceUrl()).pathname.replace(/index\.html$/, ""), expires: true }]);
  const frame = await probe.mount(page); await loaded(frame); await opaque(frame); await fontBlocked(frame, probe);
  expect(probe.events.filter(event => event.path.endsWith(".mjs"))).toHaveLength(2);
  expect(probe.events.filter(event => event.path.endsWith(".mjs")).every(event => event.cookie && event.origin === "null" && event.status === 200)).toBe(true);
  expect(probe.events.filter(event => event.path.includes("/assets/")).every(event => !event.bearer)).toBe(true);
  expect(await probe.bearerStatus("/probe/json")).toBe(200);
  expect((await context.request.get(`${probe.apiOrigin}/probe/json`)).status()).toBe(401);
});

test("third-party-cookie restrictions break an otherwise compatible resource session", async ({ page, context, probe }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCookieControls", { enableThirdPartyCookieRestriction: true });
  await probe.openHost(page); await probe.issue(page);
  const frame = await probe.mount(page);
  await expect(frame.locator("#ticks")).not.toHaveText("0");
  await expect.poll(() => probe.events.filter(event => event.path.endsWith("classic.js")).map(event => event.status)).toEqual([401]);
  await expect(frame.locator("#classic")).toHaveText("not loaded");
  await cdp.detach();
});

for (const invalidation of ["revoke", "expiry", "lifecycle", "page", "bundle", "document"] as const) {
  test(`${invalidation} rejects new asset reads while already executing code survives until host disposal`, async ({ page, probe }) => {
    await probe.openHost(page); await probe.issue(page); const frame = await probe.mount(page); await loaded(frame);
    const before = await frame.locator("#ticks").textContent();
    if (invalidation === "revoke") probe.revoke("one");
    else if (invalidation === "expiry") probe.expire();
    else probe.rotate("one", invalidation as Generation);
    const response = page.waitForResponse(response => response.url().endsWith("late.js"));
    await frame.locator("body").evaluate(() => (window as unknown as { probeLateLoad(): void }).probeLateLoad());
    expect((await response).status()).toBe(invalidation === "expiry" ? 401 : 409);
    expect(await frame.locator("body").evaluate(() => Boolean((window as unknown as { probeLate?: boolean }).probeLate))).toBe(false);
    await expect(frame.locator("#ticks")).not.toHaveText(before!);
    const old = await page.locator("#probe-frame").elementHandle();
    await page.locator("#probe-frame").evaluate(frame => frame.remove());
    expect(await old!.evaluate(frame => frame.isConnected)).toBe(false);
    await expect(page.locator("#probe-frame")).toHaveCount(0);
  });
}

test("HttpOnly path scoping cannot distinguish an opaque second Page requesting the first Page's resource", async ({ page, probe }) => {
  await probe.openHost(page); await probe.issue(page, "None", true, "one");
  const foreignAsset = probe.assetUrl("one", "classic.js");
  probe.useForeignClassic(foreignAsset); await probe.issue(page, "None", true, "two");
  const frame = await probe.mount(page, "two"); await opaque(frame);
  await expect(frame.locator("#classic")).toHaveText("classic loaded");
  const foreignRead = probe.events.filter(event => event.path === new URL(foreignAsset).pathname);
  expect(foreignRead.map(({ status, cookie }) => ({ status, cookie }))).toEqual([{ status: 200, cookie: true }]);
  // This is a counterexample, not a passing isolation design. Path scopes the
  // destination cookie; neither Origin:null nor Fetch Metadata identifies caller.
});

test("raw authenticated preload into srcdoc loses relative nested resource routing", async ({ page, probe }) => {
  await probe.openHost(page); const frame = await probe.mountPreloaded(page, false); await opaque(frame);
  await expect(frame.locator("#ticks")).not.toHaveText("0");
  await expect(frame.locator("#classic")).toHaveText("not loaded");
  await expect(frame.locator("#module")).toHaveText("not loaded");
  expect(probe.events.filter(event => event.method === "GET" && event.path.includes("/assets/")).map(event => event.destination)).toEqual(["empty"]);
});

test("static trusted preload can inline the finite module/CSS/image graph but changes module URL semantics", async ({ page, probe }) => {
  await probe.openHost(page); const frame = await probe.mountPreloaded(page, true); await loaded(frame); await opaque(frame);
  await fontBlocked(frame, probe);
  const moduleUrl = await frame.locator("#module").getAttribute("data-url");
  expect(moduleUrl).toBe(`${probe.hostOrigin}/`);
  const relativeImage = await frame.locator("#module").evaluate(module => new URL("./image.svg", module.getAttribute("data-url")!).href);
  expect(relativeImage).toBe(`${probe.hostOrigin}/image.svg`);
  expect(relativeImage).not.toBe(probe.assetUrl("one", "image.svg"));
  const reads = probe.events.filter(event => event.method === "GET" && event.path.includes("/assets/"));
  expect(reads).toHaveLength(7);
  expect(reads.every(event => event.destination === "empty" && event.bearer && !event.cookie && event.status === 200)).toBe(true);
});
