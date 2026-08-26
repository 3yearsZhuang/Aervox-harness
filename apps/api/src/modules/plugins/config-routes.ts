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
import { resolveTenant } from "../../shared/tenant.js";
import { BRIDGE_SDK } from "./bridge-sdk.js";
import { PluginConfigError, type PluginConfigService } from "./config-service.js";

function sendError(reply: { code: (status: number) => { send: (body: unknown) => void } }, error: unknown): void {
  if (error instanceof PluginConfigError) {
    return reply.code(error.status).send({ error: error.code, message: error.message, issues: error.issues });
  }
  return reply.code(500).send({ error: "INTERNAL", message: error instanceof Error ? error.message : "internal error" });
}

export function registerPluginConfigRoutes(app: FastifyInstance, service: PluginConfigService): void {
  // ── Schema ──────────────────────────────────────────
  app.get("/v1/plugins/:pluginId/config/schema", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      return await service.getConfigSchema(pluginId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/v1/plugins/:pluginId/config/schema", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      return await service.registerConfigSchema(pluginId, req.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── 配置 ──────────────────────────────────────────
  app.get("/v1/plugins/:pluginId/config", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const tenant = resolveTenant(req);
    try {
      return await service.getConfig(tenant, pluginId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/v1/plugins/:pluginId/config", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      revision?: number;
      values?: Record<string, unknown>;
      secretValues?: Record<string, string | null>;
    };
    if (typeof body.revision !== "number") {
      return reply.code(400).send({ error: "INVALID_CONFIG", message: "revision is required" });
    }
    try {
      return await service.saveConfig(tenant, pluginId, {
        revision: body.revision,
        values: body.values ?? {},
        secretValues: body.secretValues ?? {},
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/v1/plugins/:pluginId/config/reset", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    const tenant = resolveTenant(req);
    try {
      return await service.resetConfig(tenant, pluginId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── Page ──────────────────────────────────────────
  app.get("/v1/plugins/:pluginId/pages", async (req, reply) => {
    const { pluginId } = req.params as { pluginId: string };
    try {
      return { pages: await service.listPages(pluginId) };
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
