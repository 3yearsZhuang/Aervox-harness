/**
 * Aervox｜思隅 @aervox/api — 内容模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import path from "node:path";
import type { ModuleContext } from "../context.js";
import { SqliteContentRepository } from "@aervox/database";
import { registerContentRoutes } from "./routes.js";

/** 附件二进制默认落盘根目录：<repo>/data/attachments（测试可注入临时目录） */
const DEFAULT_ATTACHMENTS_ROOT = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  return path.join(repoRoot, "data", "attachments");
};

export function registerContentModule(ctx: ModuleContext): void {
  const { app, db, attachmentsRoot } = ctx;
  const contentRepo = new SqliteContentRepository(db);
  registerContentRoutes(app, contentRepo, attachmentsRoot ?? DEFAULT_ATTACHMENTS_ROOT());
}
