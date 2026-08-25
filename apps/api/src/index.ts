/**
 * Aervox｜思隅 @aervox/api — 契约骨架与 SQLite 持久化接入
 *
 * 暴露流式协议与用户侧业务路由，基于 @aervox/database (SQLite + Drizzle) 实现租户隔离与落库。
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md + docs/reference/DATABASE.md + @aervox/contracts。
 */
import { buildApp } from "./app.js";

const { app } = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
