import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginManifestSchema,
  pluginConfigSchema,
} from "@aervox/contracts";
import { createInMemoryDatabase } from "@aervox/repositories";
import { buildApp } from "../src/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_SOURCE_ROOT = path.resolve(__dirname, "../../../plugins");

describe("出厂官方插件集市与全量插件打包验证 (Market & Builtin Plugins Packaging)", () => {
  it("plugins/ 下全部 7 个插件的 plugin.manifest.json 均严格通过契约校验", async () => {
    const entries = await fs.readdir(PLUGINS_SOURCE_ROOT, { withFileTypes: true });
    const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(dirNames).toContain("home-assistant");
    expect(dirNames).toContain("xiaomi-health");
    expect(dirNames).toContain("anki-sync");
    expect(dirNames).toContain("diary-distillers");
    expect(dirNames).toContain("multimodal-ocr");
    expect(dirNames).toContain("focus-mode");
    expect(dirNames).toContain("health-guard");

    for (const dirName of dirNames) {
      const manifestPath = path.join(PLUGINS_SOURCE_ROOT, dirName, "plugin.manifest.json");
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = pluginManifestSchema.safeParse(JSON.parse(raw));
      expect(
        parsed.success,
        `插件 ${dirName} 的 plugin.manifest.json 校验失败: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
      expect(parsed.data?.metadata.id).toBe(dirName);
    }
  });

  it("各插件的 config.schema.json 均严格通过 pluginConfigSchema 校验", async () => {
    const entries = await fs.readdir(PLUGINS_SOURCE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const schemaPath = path.join(PLUGINS_SOURCE_ROOT, entry.name, "config.schema.json");
      try {
        const raw = await fs.readFile(schemaPath, "utf8");
        const parsed = pluginConfigSchema.safeParse(JSON.parse(raw));
        expect(
          parsed.success,
          `插件 ${entry.name} 的 config.schema.json 校验失败: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
  });

  it("GET /v1/plugins/market 成功自发现全部 7 个插件及其能力指标明细", async () => {
    const { db, client } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });

    const res = await app.inject({
      method: "GET",
      url: "/v1/plugins/market",
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBe(7);

    const itemIds = items.map((i: any) => i.id);
    expect(itemIds).toContain("home-assistant");
    expect(itemIds).toContain("xiaomi-health");
    expect(itemIds).toContain("anki-sync");
    expect(itemIds).toContain("diary-distillers");
    expect(itemIds).toContain("multimodal-ocr");

    // 抽检 home-assistant 能力指标
    const ha = items.find((i: any) => i.id === "home-assistant");
    expect(ha).toBeDefined();
    expect(ha.capabilities.hasConfig).toBe(true);
    expect(ha.capabilities.toolsCount).toBe(2);
    expect(ha.capabilities.sensorsCount).toBe(1);
    expect(ha.capabilities.triggersCount).toBe(1);
    expect(ha.capabilities.skillsCount).toBe(1);

    // 抽检 anki-sync 能力指标
    const anki = items.find((i: any) => i.id === "anki-sync");
    expect(anki).toBeDefined();
    expect(anki.capabilities.hasConfig).toBe(true);
    expect(anki.capabilities.toolsCount).toBe(2);
    expect(anki.capabilities.skillsCount).toBe(1);

    // 抽检 diary-distillers 能力指标
    const diary = items.find((i: any) => i.id === "diary-distillers");
    expect(diary).toBeDefined();
    expect(diary.capabilities.hasConfig).toBe(true);
    expect(diary.capabilities.toolsCount).toBe(2);
    expect(diary.capabilities.skillsCount).toBe(1);
  });

  it("POST /v1/plugins/market/:id/install 支持从出厂集市一键安装并注册工具与配置", async () => {
    const { db, client } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });

    // 安装 home-assistant
    const resHa = await app.inject({
      method: "POST",
      url: "/v1/plugins/market/home-assistant/install",
    });
    expect(resHa.statusCode).toBe(201);
    expect(resHa.json().id).toBe("home-assistant");
    expect(resHa.json().version).toBe("1.0.0");

    // 验证配置 Schema 是否就绪
    const configRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/home-assistant/config",
    });
    expect(configRes.statusCode).toBe(200);
    expect(configRes.json().schemaVersion).toBe(1);

    // 安装 anki-sync
    const resAnki = await app.inject({
      method: "POST",
      url: "/v1/plugins/market/anki-sync/install",
    });
    expect(resAnki.statusCode).toBe(201);
    expect(resAnki.json().id).toBe("anki-sync");

    // 验证插件列表包含已安装项
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const installedIds = listRes.json().items.map((p: any) => p.id);
    expect(installedIds).toContain("home-assistant");
    expect(installedIds).toContain("anki-sync");
  });

  it("GET /v1/plugins/:id/export 导出的 .aervox-plugin 分发包支持 POST /v1/plugins/inspect-package 安全预检", async () => {
    const { db, client } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });

    // 分发包由产品自身的导出端点现场生成，不依赖 dist-plugins/ 下的本地构建产物：
    // 该目录已由 .gitignore 忽略，CI 全新检出时并不存在，直接读文件会导致 ENOENT 假失败。
    const exportRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/home-assistant/export",
    });
    expect(exportRes.statusCode).toBe(200);
    const exported = exportRes.json();
    expect(exported.filename).toBe("home-assistant-1.0.0.aervox-plugin");
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
    expect(data.id).toBe("home-assistant");
    expect(data.displayName).toBe("Home Assistant 智能家居网关");
    expect(data.isValid).toBe(true);
    expect(data.hasConfig).toBe(true);
    expect(data.tools).toHaveLength(2);
    expect(data.proactive.sensors).toHaveLength(1);
    expect(data.proactive.triggers).toHaveLength(1);
    expect(data.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
