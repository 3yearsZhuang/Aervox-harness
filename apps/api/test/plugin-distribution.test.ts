/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件分发集成测试
 *
 * 覆盖：
 * 1. POST /v1/plugins/inspect-package:
 *    - 内存解包安全审计（路径穿越拒绝）；
 *    - PRD CAP-020 安装前预检（元数据、SHA-256、感知源权限、数据范围与能力明细）；
 * 2. POST /v1/plugins/install-package:
 *    - 从分发包原子安装（插件主表 + 工具 + 技能 + 配置 + Page）；
 *    - 重复安装冲突 409 与 overwrite=true 覆盖安装；
 * 3. GET /v1/plugins/:id/export:
 *    - 插件打包导出为 .aervox-plugin 单文件归档；
 *    - 导出的安装包可再次被 inspect 与 install（自举闭环）；
 * 4. GET /v1/plugins/market 与 POST /v1/plugins/market/:id/install:
 *    - 官方出厂插件集市检索与一键安装。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/repositories";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

function buildTestPluginBundle(overrides: {
  id?: string;
  version?: string;
  files?: Record<string, string>;
} = {}): Buffer {
  const id = overrides.id ?? "com.example.disttest";
  const version = overrides.version ?? "1.0.0";
  const manifest = {
    apiVersion: "aervox.dev/v1",
    kind: "PluginManifest",
    metadata: {
      id,
      displayName: "分发测试插件",
      publisher: "aervox-official",
      version,
      description: "用于验证分发包预检与安装的完整测试插件",
      license: "AGPL-3.0-or-later",
    },
    spec: {
      config: {
        schemaVersion: 1,
        entry: "config.schema.json",
      },
      skills: [
        {
          name: "dist-assistant",
          description: "分发助手技能",
          content: "---\nname: dist-assistant\ndescription: 辅助测试分发\n---\n# 分发技能提示词",
        },
      ],
      tools: [
        {
          name: "dist_echo",
          description: "回显输入内容",
          category: "test",
          safetyLevel: "read_only",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
      pages: [
        {
          id: "dashboard",
          title: "测试看板",
          entry: "pages/dashboard/index.html",
          capabilities: ["config.read", "host.notify"],
        },
      ],
      proactive: {
        sensors: [
          {
            sourceId: "system.idle_state",
            description: "读取系统空闲时间",
          },
        ],
        triggers: [
          {
            ruleId: "idle_alert",
            name: "空闲提醒",
            triggerType: "system_state",
            condition: { idleMinutesMax: 10 },
            cooldownSeconds: 600,
          },
        ],
      },
    },
  };

  const configSchema = {
    apiVersion: "aervox.dev/v1",
    kind: "PluginConfigSchema",
    schemaVersion: 1,
    fields: [
      {
        key: "testApiKey",
        type: "secret",
        label: "测试密钥",
      },
    ],
  };

  const rawFiles: Record<string, Uint8Array> = {
    "plugin.manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "config.schema.json": strToU8(JSON.stringify(configSchema, null, 2)),
    "SKILL.md": strToU8("---\nname: dist-main\ndescription: 主技能\n---\n# 主提示词"),
    "pages/dashboard/index.html": strToU8("<!DOCTYPE html><html><body><h1>看板</h1></body></html>"),
    "pages/dashboard/app.js": strToU8("console.log('page loaded');"),
  };

  if (overrides.files) {
    for (const [name, content] of Object.entries(overrides.files)) {
      rawFiles[name] = strToU8(content);
    }
  }

  const bytes = zipSync(rawFiles, { level: 6 });
  return Buffer.from(bytes);
}

describe("CAP-020 插件分发与打包集成测试", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("POST /v1/plugins/inspect-package: 预检合法安装包并提取 PRD CAP-020 安全元数据", async () => {
    const bundleZip = buildTestPluginBundle({ id: "pkg.sample", version: "2.1.0" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/plugins/inspect-package",
      payload: {
        packageBase64: bundleZip.toString("base64"),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isValid).toBe(true);
    expect(body.id).toBe("pkg.sample");
    expect(body.version).toBe("2.1.0");
    expect(body.publisher).toBe("aervox-official");
    expect(body.checksum).toHaveLength(64); // SHA-256
    expect(body.hasConfig).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("dist_echo");
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].id).toBe("dashboard");
    expect(body.proactive.sensors).toHaveLength(1);
    expect(body.proactive.sensors[0].sourceId).toBe("system.idle_state");
    expect(body.permissions).toContain("proactive.sensor:system.idle_state");
    expect(body.permissions).toContain("page:config.read");
    expect(body.dataScope.length).toBeGreaterThan(0);
    expect(body.alreadyInstalled).toBe(false);
  });

  it("POST /v1/plugins/inspect-package: 拦截恶意路径穿越安装包 (fail-closed)", async () => {
    const maliciousBytes = zipSync({
      "plugin.manifest.json": strToU8(JSON.stringify({
        apiVersion: "aervox.dev/v1",
        kind: "PluginManifest",
        metadata: { id: "evil", displayName: "Evil", publisher: "evil", version: "1.0.0" },
      })),
      "../../evil.txt": strToU8("malicious content"),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/plugins/inspect-package",
      payload: {
        packageBase64: Buffer.from(maliciousBytes).toString("base64"),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isValid).toBe(false);
    expect(body.issues[0]).toMatch(/Unsafe entry path/);
  });

  it("POST /v1/plugins/install-package: 从分发包安装插件并同步工具与技能", async () => {
    const bundleZip = buildTestPluginBundle({ id: "pkg.installed", version: "1.0.0" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/plugins/install-package",
      payload: {
        packageBase64: bundleZip.toString("base64"),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe("pkg.installed");
    expect(body.version).toBe("1.0.0");
    expect(body.installSource).toBe("package");

    // 验证工具已被注册
    const toolsRes = await app.inject({ method: "GET", url: "/v1/tools" });
    const tools = toolsRes.json().items;
    expect(tools.some((t: any) => t.name === "dist_echo" && t.pluginId === "pkg.installed")).toBe(true);

    // 验证技能已被注册
    const skillsRes = await app.inject({ method: "GET", url: "/v1/skills" });
    const skills = skillsRes.json().items;
    expect(skills.some((s: any) => s.pluginId === "pkg.installed")).toBe(true);
  });

  it("POST /v1/plugins/install-package: 重复安装冲突返回 409，支持 overwrite=true 覆盖安装", async () => {
    const bundleZip1 = buildTestPluginBundle({ id: "pkg.conflict", version: "1.0.0" });
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/plugins/install-package",
      payload: {
        packageBase64: bundleZip1.toString("base64"),
      },
    });
    expect(res1.statusCode).toBe(201);

    // 未带 overwrite 重复安装 -> 409
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/plugins/install-package",
      payload: {
        packageBase64: bundleZip1.toString("base64"),
      },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe("PLUGIN_ALREADY_EXISTS");

    // 带 overwrite=true 覆盖安装升级到 1.1.0 -> 201
    const bundleZip2 = buildTestPluginBundle({ id: "pkg.conflict", version: "1.1.0" });
    const res3 = await app.inject({
      method: "POST",
      url: "/v1/plugins/install-package",
      payload: {
        packageBase64: bundleZip2.toString("base64"),
        overwrite: true,
      },
    });
    expect(res3.statusCode).toBe(201);
    expect(res3.json().version).toBe("1.1.0");
  });

  it("GET /v1/plugins/:id/export: 导出安装包并实现自举重装闭环", async () => {
    // 1. 安装一个插件
    const bundleZip = buildTestPluginBundle({ id: "pkg.exportable", version: "3.0.0" });
    await app.inject({
      method: "POST",
      url: "/v1/plugins/install-package",
      payload: { packageBase64: bundleZip.toString("base64") },
    });

    // 2. 导出该插件
    const exportRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/pkg.exportable/export",
    });
    expect(exportRes.statusCode).toBe(200);
    const expData = exportRes.json();
    expect(expData.pluginId).toBe("pkg.exportable");
    expect(expData.filename).toBe("pkg.exportable-3.0.0.aervox-plugin");
    expect(expData.packageBase64).toBeTruthy();
    expect(expData.checksum).toHaveLength(64);

    // 3. 预检导出的包
    const inspectRes = await app.inject({
      method: "POST",
      url: "/v1/plugins/inspect-package",
      payload: { packageBase64: expData.packageBase64 },
    });
    expect(inspectRes.statusCode).toBe(200);
    expect(inspectRes.json().id).toBe("pkg.exportable");
    expect(inspectRes.json().isValid).toBe(true);
    expect(inspectRes.json().alreadyInstalled).toBe(true);
  });

  it("GET /v1/plugins/market: 获取出厂集市列表并支持一键安装", async () => {
    // 查询集市
    const marketRes = await app.inject({
      method: "GET",
      url: "/v1/plugins/market",
    });
    expect(marketRes.statusCode).toBe(200);
    const items = marketRes.json().items;
    expect(Array.isArray(items)).toBe(true);

    // 如果根目录下有内置插件（focus-mode 或 health-guard）
    const target = items.find((i: any) => i.id === "health-guard" || i.id === "focus-mode");
    if (target) {
      expect(target.source).toBe("builtin");
      expect(target.displayName).toBeTruthy();

      // 测试从集市一键安装
      const installRes = await app.inject({
        method: "POST",
        url: `/v1/plugins/market/${target.id}/install`,
      });
      expect(installRes.statusCode).toBe(201);
      expect(installRes.json().id).toBe(target.id);
    }
  });
});
