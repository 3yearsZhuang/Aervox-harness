/**
 * Aervox｜思隅 @aervox/api — 本机 API 认证中间件
 *
 * CR-030 后数据库是永久本地单用户真源，API 不再接收租户身份。open 模式仅允许
 * loopback；token 模式校验 Bearer token，可从服务端配置注入 actorId 作为审计主体。
 *
 * 配置（优先级：进程环境变量 > .env > 缺省 open）：
 *   AERVOX_AUTH_MODE  open | token（缺省 open）
 *   AERVOX_AUTH_TOKEN 通行密钥（mode=token 时必填，建议 >= 32 位随机值）
 *   AERVOX_AUTH_ACTOR 操作者标识（可选，仅用于审计）
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveLocalContext, setRequestLocalContext } from "./local-context.js";
import { isIP } from "node:net";

export type AuthMode = "open" | "token";

export interface AuthConfig {
  /** open=本地免认证（默认）；token=强制 Bearer token */
  mode: AuthMode;
  /** mode=token 时的通行密钥 */
  token?: string;
  /** token 模式绑定的操作者标识（可选，仅用于审计） */
  actorId?: string;
}

/** 从环境加载认证配置（可注入 env 便于测试） */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode: AuthMode =
    env.AERVOX_AUTH_MODE?.trim().toLowerCase() === "token" ? "token" : "open";
  return {
    mode,
    token: env.AERVOX_AUTH_TOKEN?.trim() || undefined,
    actorId: env.AERVOX_AUTH_ACTOR?.trim() || undefined,
  };
}

export function assertSafeApiListenHost(host: string, mode: AuthMode): void {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = normalized === "localhost" || normalized === "ip6-localhost" ||
    (isIP(normalized) === 4 && normalized.startsWith("127.")) || normalized === "::1";
  if (!loopback && mode === "open") {
    throw new Error("open authentication cannot listen on a non-loopback API host");
  }
}

/**
 * 构造认证 onRequest hook（async，非回调式）。
 * - open：创建固定本地上下文后放行；
 * - token：Bearer token 缺失/不匹配 → 401；
 *   匹配 → 注入固定本地上下文，可附带服务端配置的审计 actorId。
 */
export function createAuthHook(config: AuthConfig = loadAuthConfig()) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (config.mode === "open") {
      resolveLocalContext(req);
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
    setRequestLocalContext(req, config.actorId);
  };
}
