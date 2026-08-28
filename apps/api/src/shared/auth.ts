/**
 * Aervox｜思隅 @aervox/api — 认证中间件（租户信任模型加固）
 *
 * 背景：此前租户上下文直接信任 x-workspace-id / x-user-id / x-actor-id 请求头，
 * 应用层租户隔离建立在不可信输入上。本中间件作为统一前置关口：
 * - mode=open（默认，本地开发）：免认证放行，仍统一解析并缓存租户上下文；
 * - mode=token（生产推荐）：强制校验 `Authorization: Bearer <token>` 与
 *   AERVOX_AUTH_TOKEN 一致，否则 401 短路、不进入任何路由与仓储。
 * 校验通过后，租户上下文才被写入请求（resolveTenant 返回已验证的缓存值）。
 *
 * 配置（优先级：进程环境变量 > .env > 缺省 open）：
 *   AERVOX_AUTH_MODE   open | token（缺省 open）
 *   AERVOX_AUTH_TOKEN  通行密钥（mode=token 时必填，建议 >= 32 位随机值）
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveTenant } from "./tenant.js";

export type AuthMode = "open" | "token";

export interface AuthConfig {
  /** open=本地免认证（默认）；token=强制 Bearer token */
  mode: AuthMode;
  /** mode=token 时的通行密钥 */
  token?: string;
}

/** 从环境加载认证配置（可注入 env 便于测试） */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode: AuthMode = env.AERVOX_AUTH_MODE?.trim().toLowerCase() === "token" ? "token" : "open";
  return { mode, token: env.AERVOX_AUTH_TOKEN?.trim() || undefined };
}

/**
 * 构造认证 onRequest hook（async，非回调式）。
 * - open：resolveTenant 统一解析并缓存租户上下文后放行；
 * - token：Bearer token 缺失/不匹配 → 401；匹配 → resolveTenant 后放行。
 */
export function createAuthHook(config: AuthConfig = loadAuthConfig()) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (config.mode === "open") {
      resolveTenant(req);
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!config.token || token.length === 0 || token !== config.token) {
      reply.code(401).send({
        error: "unauthorized",
        code: "AUTH_UNAUTHORIZED",
        message: "missing or invalid bearer token",
      });
      return;
    }
    resolveTenant(req);
  };
}