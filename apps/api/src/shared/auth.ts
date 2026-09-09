/**
 * Aervox｜思隅 @aervox/api — 认证中间件（租户信任模型加固）
 *
 * 背景：此前租户上下文直接信任 x-workspace-id / x-user-id / x-actor-id 请求头，
 * 应用层租户隔离建立在不可信输入上。本中间件作为统一前置关口：
 * - mode=open（默认，本地开发）：免认证放行，仍统一解析并缓存租户上下文（header + 默认回退）；
 * - mode=token（生产推荐）：强制校验 `Authorization: Bearer <token>` 与
 *   AERVOX_AUTH_TOKEN 一致，否则 401 短路、不进入任何路由与仓储。
 *
 * 令牌与租户绑定（缺陷 A）：token 校验通过后，租户身份**只来自服务端配置**
 * （AERVOX_AUTH_WORKSPACE / AERVOX_AUTH_USER / AERVOX_AUTH_ACTOR），
 * 不再信任裸请求头；未配置租户即 fail-closed 拒绝（威胁模型 TM-001/TM-004：
 * 配置错误为严重阻断）。多租户的每租户令牌签发见后续 OIDC（TM-001）。
 *
 * 配置（优先级：进程环境变量 > .env > 缺省 open）：
 *   AERVOX_AUTH_MODE      open | token（缺省 open）
 *   AERVOX_AUTH_TOKEN     通行密钥（mode=token 时必填，建议 >= 32 位随机值）
 *   AERVOX_AUTH_WORKSPACE token 模式绑定的工作区标识（必填，缺省 fail-closed）
 *   AERVOX_AUTH_USER      token 模式绑定的数据主体标识（必填，缺省 fail-closed）
 *   AERVOX_AUTH_ACTOR     token 模式绑定的操作者标识（可选：管理员/教师/监护人/插件）
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveTenant, setRequestTenant, type ApiTenantContext } from "./tenant.js";

export type AuthMode = "open" | "token";

export interface AuthConfig {
  /** open=本地免认证（默认）；token=强制 Bearer token */
  mode: AuthMode;
  /** mode=token 时的通行密钥 */
  token?: string;
  /** token 模式绑定的工作区标识（来自服务端配置，非请求头） */
  workspaceId?: string;
  /** token 模式绑定的数据主体标识（来自服务端配置，非请求头） */
  subjectUserId?: string;
  /** token 模式绑定的操作者标识（可选：管理员/教师/监护人/插件） */
  actorId?: string;
}

/** 从环境加载认证配置（可注入 env 便于测试） */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode: AuthMode =
    env.AERVOX_AUTH_MODE?.trim().toLowerCase() === "token" ? "token" : "open";
  return {
    mode,
    token: env.AERVOX_AUTH_TOKEN?.trim() || undefined,
    workspaceId: env.AERVOX_AUTH_WORKSPACE?.trim() || undefined,
    subjectUserId: env.AERVOX_AUTH_USER?.trim() || undefined,
    actorId: env.AERVOX_AUTH_ACTOR?.trim() || undefined,
  };
}

/** Fastify onRequest 钩子：执行认证与租户绑定 */
export function createAuthHook(config: AuthConfig = loadAuthConfig()) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mode === "open") {
      // open 模式：仍统一解析/缓存租户，保持业务代码单源
      resolveTenant(req);
      return;
    }

    // token 模式：校验 Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      await reply.status(401).send({
        code: "UNAUTHORIZED",
        message: "missing or malformed Authorization header (expected 'Bearer <token>')",
      });
      return;
    }

    const provided = authHeader.slice(7).trim();
    if (!config.token || provided !== config.token) {
      await reply.status(401).send({
        code: "UNAUTHORIZED",
        message: "invalid bearer token",
      });
      return;
    }

    // fail-closed：未配置绑定租户则阻断（防止误把生产跑在空配置上）
    if (!config.workspaceId || !config.subjectUserId) {
      await reply.status(500).send({
        code: "AUTH_NOT_CONFIGURED",
        message: "token mode requires AERVOX_AUTH_WORKSPACE and AERVOX_AUTH_USER",
      });
      return;
    }
    const tenant: ApiTenantContext = {
      workspaceId: config.workspaceId,
      subjectUserId: config.subjectUserId,
      actorId: config.actorId ?? config.subjectUserId,
    };
    setRequestTenant(req, tenant);
  };
}