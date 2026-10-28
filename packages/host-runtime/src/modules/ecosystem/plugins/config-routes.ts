/**
 * Aervox｜思隅 @aervox/api — 插件 Config / Page 路由（CAP-020 扩展 · CR-006）
 *
 * 新增路由文件（遵守中间件重构期不改动既有路由文件的约束）：
 * - PUT/GET /v1/plugins/:pluginId/config/schema   注册/读取配置 Schema；
 * - GET/PUT  /v1/plugins/:pluginId/config         读取/保存配置（secret 不回显）；
 * - POST     /v1/plugins/:pluginId/config/reset   重置配置；
 * - GET/POST /v1/plugins/:pluginId/pages          列出/注册 Page；
 * - POST     /v1/plugins/:pluginId/pages/:pageId/assets  写入 Page 静态资源；
 * - GET      /v1/plugins/:pluginId/pages/:pageId/assets/* 读取 Page 静态资源；
 * - GET      /v1/plugin-pages/bridge.js           Page Bridge SDK。
 */
import type { FastifyInstance } from "fastify";
import { pluginConfigApi, type PluginConfigAccessQuery, type SavePluginConfigRequest } from "@aervox/contracts";
import { registerContractRoute } from "../../../shared/contract-route.js";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { BRIDGE_SDK } from "./bridge-sdk.js";
import { PluginConfigError, type PluginConfigService } from "./config-service.js";
import { PageAssetBoundaryError } from "./bundle-store.js";

function sendError(reply: { code: (status: number) => { send: (body: unknown) => void } }, error: unknown): void {
  if (error instanceof PageAssetBoundaryError) {
    return reply.code(400).send({ error: "INVALID_ASSET_PATH", code: "INVALID_ASSET_PATH", message: error.message });
  }
  if (error instanceof PluginConfigError) {
    return reply.code(error.status).send({ error: error.code, code: error.code, message: error.message, issues: error.issues });
  }
  throw error;
}

export function registerPluginConfigRoutes(app: FastifyInstance, service: PluginConfigService): void {
  // ── Schema ──────────────────────────────────────────
  registerContractRoute(app, pluginConfigApi.getSchema, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      return await service.getConfigSchema(pluginId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerContractRoute(app, pluginConfigApi.registerSchema, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      return await service.registerConfigSchema(pluginId, req.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── 配置 ──────────────────────────────────────────
  registerContractRoute(app, pluginConfigApi.exportData, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      reply.header("Cache-Control", "no-store");
      return await service.exportStoredData(resolveLocalContext(req), pluginId);
    } catch (error) { return sendError(reply, error); }
  });

  registerContractRoute(app, pluginConfigApi.get, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const { expectedLifecycleGeneration, expectedPageId, expectedPageGeneration } = req.query as PluginConfigAccessQuery;
    const tenant = resolveLocalContext(req);
    try {
      reply.header("Cache-Control", "no-store");
      return await service.getConfig(tenant, pluginId, expectedLifecycleGeneration, { expectedPageId, expectedPageGeneration });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerContractRoute(app, pluginConfigApi.save, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const tenant = resolveLocalContext(req);
    const body = req.body as SavePluginConfigRequest;
    try {
      return await service.saveConfig(tenant, pluginId, {
        revision: body.revision,
        values: body.values ?? {},
        secretValues: body.secretValues ?? {},
        expectedLifecycleGeneration: body.expectedLifecycleGeneration,
        expectedPageId: body.expectedPageId,
        expectedPageGeneration: body.expectedPageGeneration,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerContractRoute(app, pluginConfigApi.reset, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const { expectedLifecycleGeneration, expectedPageId, expectedPageGeneration } = req.query as PluginConfigAccessQuery;
    const tenant = resolveLocalContext(req);
    try {
      return await service.resetConfig(tenant, pluginId, expectedLifecycleGeneration, { expectedPageId, expectedPageGeneration });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── Page ──────────────────────────────────────────
  registerContractRoute(app, pluginConfigApi.listPages, async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const { expectedLifecycleGeneration } = req.query as { expectedLifecycleGeneration?: string };
    try {
      reply.header("Cache-Control", "no-store");
      return { pages: await service.listPages(pluginId, expectedLifecycleGeneration) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/v1/plugins/:pluginId/pages", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      const page = await service.registerPage(pluginId, req.body);
      return reply.code(201).send(page);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/v1/plugins/:pluginId/pages/:pageId/assets", async (req, reply) => {
    const { pluginId, pageId } = req.params as { pluginId: string; pageId: string };
    const body = (req.body ?? {}) as { files?: Array<{ path: string; contentBase64: string }> };
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: "INVALID_ASSETS", message: "files is required" });
    }
    try {
      return reply.code(201).send(await service.writePageAssets(pluginId, pageId, body.files));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // 入口 HTML 与静态资源共用一条通配路由（Fastify '*' 仅允许出现在路径末尾）
  app.get("/v1/plugins/:pluginId/pages/:pageId/assets/*", async (req, reply) => {
    const params = req.params as { pluginId: string; pageId: string; "*"?: string };
    const { pluginId, pageId } = params;
    const rest = params["*"] ?? "";
    try {
      const asset =
        rest === "index.html"
          ? await service.readPageEntry(pluginId, pageId)
          : await service.readPageAsset(pluginId, pageId, rest);
      return reply
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors *; base-uri 'none'; form-action 'none'")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .type(asset.mime)
        .send(asset.content);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Bridge SDK
  app.get("/v1/plugin-pages/bridge.js", async (_req, reply) =>
    reply
      .header("Content-Type", "text/javascript; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(BRIDGE_SDK),
  );
}
