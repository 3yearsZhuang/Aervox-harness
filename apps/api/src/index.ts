/**
 * Aervox｜思隅 @aervox/api — 契约骨架与 SQLite 持久化接入
 *
 * 暴露流式协议与用户侧业务路由，基于 @aervox/repositories (SQLite + Drizzle) 实现租户隔离与落库。
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md + docs/reference/DATABASE.md + @aervox/contracts。
 */
import { buildApp } from "./app.js";
import { loadApiConfig } from "@aervox/config";
import { assertSafeApiListenHost, loadAuthConfig } from "./shared/auth.js";

const { app } = await buildApp();
// 缺陷 E：集中类型化配置（PORT 启动期校验）
const config = loadApiConfig();
const auth = loadAuthConfig();
assertSafeApiListenHost(config.host, auth.mode);
await app.listen({ port: config.port, host: config.host });
