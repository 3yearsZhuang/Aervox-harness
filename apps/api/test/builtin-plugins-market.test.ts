import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginManifestSchema,
  pluginConfigSchema,
} from "@aervox/contracts";
import { createInMemoryDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_SOURCE_ROOT = path.resolve(__dirname, "../../../plugins");

describe("出厂官方插件集市与全量插件打包验证 (Market & Builtin Plugins Packaging)", () => {
  it("可分发插件的 Manifest 全部通过契约校验，根界面源码不伪装为分发包", async () => {
    const dirNames = await Array.fromAsync(fs.glob("plugins/*/*/plugin.manifest.json", { cwd: PLUGINS_SOURCE_ROOT }));
    const ids = await Promise.all(dirNames.map(async file => JSON.parse(await fs.readFile(path.join(PLUGINS_SOURCE_ROOT, file), "utf8")).metadata.id));
    expect(ids).toContain("ap-tool-home-assistant");
    expect(ids).toContain("ap-sync-xiaomi-health");
    expect(ids).toContain("ap-tool-anki-sync");
    expect(ids).toContain("ap-workflow-diary-distillers");
    expect(ids).toContain("ap-tool-multimodal-ocr");
    expect(ids).toContain("ap-ui-focus-mode");
    expect(ids).toContain("ap-proactive-health-guard");
    expect(ids).toContain("ap-bot-weixin");
    expect(ids).toContain("ap-bot-onebot");

    for (const dirName of dirNames) {
      const manifestPath = path.join(PLUGINS_SOURCE_ROOT, dirName);
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = pluginManifestSchema.safeParse(JSON.parse(raw));
      expect(
        parsed.success,
        `插件 ${dirName} 的 plugin.manifest.json 校验失败: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
      expect(parsed.data?.metadata.id).toMatch(/^ap-(tool|bot|ui|proactive|sync|workflow|theme)-/);
    }
  });

  it("各插件的 config.schema.json 均严格通过 pluginConfigSchema 校验", async () => {
    const entries = await Array.fromAsync(fs.glob("plugins/*/*/config.schema.json", { cwd: PLUGINS_SOURCE_ROOT }));
    for (const entry of entries) {
      const schemaPath = path.join(PLUGINS_SOURCE_ROOT, entry);
      try {
        const raw = await fs.readFile(schemaPath, "utf8");
        const parsed = pluginConfigSchema.safeParse(JSON.parse(raw));
        expect(
          parsed.success,
          `插件 ${entry} 的 config.schema.json 校验失败: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
  });

  it("GET /v1/plugins/market 自发现全部声明插件，包括两个 Bot 适配器", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });
    onTestFinished(async () => { await app.close(); await cleanup(); });

    const res = await app.inject({
      method: "GET",
      url: "/v1/plugins/market",
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBe(10);

    const itemIds = items.map((i: any) => i.id);
    expect(itemIds).not.toContain("workbench-ui");
    expect(itemIds).not.toContain("companion-ui");
    expect(itemIds).toContain("ap-tool-home-assistant");
    expect(itemIds).toContain("ap-sync-xiaomi-health");
    expect(itemIds).toContain("ap-tool-anki-sync");
    expect(itemIds).toContain("ap-workflow-diary-distillers");
    expect(itemIds).toContain("ap-tool-multimodal-ocr");
    const campus = items.find((item: { id: string }) => item.id === "ap-tool-flowcampus");
    expect(campus).toBeDefined();
    expect(campus.displayName).toBe("只争朝夕 · 校园规划");
    expect(campus.capabilities.hasConfig).toBe(true);
    for (const id of ["ap-bot-weixin", "ap-bot-onebot"]) {
      const bot = items.find((item: { id: string }) => item.id === id);
      expect(bot).toBeDefined();
      expect(bot.capabilities.toolsCount).toBe(0);
    }

    // 抽检 home-assistant 能力指标
    const ha = items.find((i: any) => i.id === "ap-tool-home-assistant");
    expect(ha).toBeDefined();
    expect(ha.capabilities.hasConfig).toBe(true);
    expect(ha.capabilities.toolsCount).toBe(2);
    expect(ha.capabilities.sensorsCount).toBe(1);
    expect(ha.capabilities.triggersCount).toBe(1);
    expect(ha.capabilities.skillsCount).toBe(1);

    // 抽检 anki-sync 能力指标
    const anki = items.find((i: any) => i.id === "ap-tool-anki-sync");
    expect(anki).toBeDefined();
    expect(anki.capabilities.hasConfig).toBe(true);
    expect(anki.capabilities.toolsCount).toBe(2);
    expect(anki.capabilities.skillsCount).toBe(1);

    // 抽检 diary-distillers 能力指标
    const diary = items.find((i: any) => i.id === "ap-workflow-diary-distillers");
    expect(diary).toBeDefined();
    expect(diary.capabilities.hasConfig).toBe(true);
    expect(diary.capabilities.toolsCount).toBe(2);
    expect(diary.capabilities.skillsCount).toBe(1);
  });

  it("POST /v1/plugins/market/:id/install 支持从出厂集市一键安装并注册工具与配置", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });
    onTestFinished(async () => { await app.close(); await cleanup(); });

    // 安装 home-assistant
    const resHa = await app.inject({
      method: "POST",
      url: "/v1/plugins/market/ap-tool-home-assistant/install",
    });
    expect(resHa.statusCode).toBe(201);
    expect(resHa.json().id).toBe("ap-tool-home-assistant");
    expect(resHa.json().version).toBe("1.0.0");

    // 验证配置 Schema 是否就绪
    const configRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/ap-tool-home-assistant/config",
    });
    expect(configRes.statusCode).toBe(200);
    expect(configRes.json().schemaVersion).toBe(1);

    // 安装 anki-sync
    const resAnki = await app.inject({
      method: "POST",
      url: "/v1/plugins/market/ap-tool-anki-sync/install",
    });
    expect(resAnki.statusCode).toBe(201);
    expect(resAnki.json().id).toBe("ap-tool-anki-sync");

    // 验证插件列表包含已安装项
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const installedIds = listRes.json().items.map((p: any) => p.id);
    expect(installedIds).toContain("ap-tool-home-assistant");
    expect(installedIds).toContain("ap-tool-anki-sync");
  });

  it("GET /v1/plugins/:id/export 导出的 .aervox-plugin 分发包支持 POST /v1/plugins/inspect-package 安全预检", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });
    onTestFinished(async () => { await app.close(); await cleanup(); });

    // 分发包由产品自身的导出端点现场生成，不依赖 dist/plugins/ 下的本地构建产物：
    // 该目录已由 .gitignore 忽略，CI 全新检出时并不存在，直接读文件会导致 ENOENT 假失败。
    const exportRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/ap-tool-home-assistant/export",
    });
    expect(exportRes.statusCode).toBe(200);
    const exported = exportRes.json();
    expect(exported.filename).toBe("ap-tool-home-assistant-v1.0.0.aervox-plugin");
    expect(exported.checksum).toMatch(/^[a-f0-9]{64}$/);

    const bundleBytes = Buffer.from(exported.packageBase64, "base64");
    expect(bundleBytes.byteLength).toBeGreaterThan(0);

    const inspectRes = await app.inject({
      method: "POST",
      url: "/v1/plugins/inspect-package",
      payload: {
        packageBase64: bundleBytes.toString("base64"),
      },
    });

    expect(inspectRes.statusCode).toBe(200);
    const data = inspectRes.json();
    expect(data.id).toBe("ap-tool-home-assistant");
    expect(data.displayName).toBe("Home Assistant 智能家居网关");
    expect(data.isValid).toBe(true);
    expect(data.hasConfig).toBe(true);
    expect(data.tools).toHaveLength(2);
    expect(data.proactive.sensors).toHaveLength(1);
    expect(data.proactive.triggers).toHaveLength(1);
    expect(data.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
