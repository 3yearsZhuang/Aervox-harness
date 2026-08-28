/**
 * Aervox｜思隅 @aervox/api — 模块装配上下文（ADR-014 演进式模块化单体）
 *
 * 统一承载领域模块注册所需的共享基础设施与服务，替代「注册函数返回值逐层传递」。
 * - app / db / client：基础设施（buildApp 构造）；
 * - 共享服务（toolRuntime / llmConfigService / voiceService / skillManager）：
 *   由归属模块在注册时填充（工具/RLLM 等只需在依赖它的模块之前注册），
 *   依赖方只读，装配顺序由 app.ts 注释显式声明；
 * - skillsRoot / pluginsRoot / workflows：buildApp 注入的构建期配置。
 */
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";
import type { AervoxDatabase } from "@aervox/database";
import type { WorkflowDefinition } from "@aervox/agent-loop";
import type { ToolRuntime } from "./tools/runtime.js";
import type { LLMConfigService } from "./llm/service.js";
import type { VoiceService } from "./voice/service.js";
import type { SkillManager } from "./skills/skill-manager.js";

export interface ModuleContext {
  app: FastifyInstance;
  db: AervoxDatabase;
  client: Client;
  /** Agent Loop 只读工具提供者（tools 模块填充；conversation/persona/skills 读取） */
  toolRuntime?: ToolRuntime;
  /** LLM 配置服务（llm 模块填充；conversation 读取） */
  llmConfigService?: LLMConfigService;
  /** 语音服务（voice 模块填充；persona 读取） */
  voiceService?: VoiceService;
  /** Skill 管理器（skills 模块填充；persona 读取） */
  skillManager?: SkillManager;
  /** 阶段 5c：已注册 Workflow 定义清单（conversation 读取） */
  workflows?: WorkflowDefinition[];
  /** Skill 内容落盘根目录（缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 插件 Page Bundle 落盘根目录（缺省 <repo>/data/plugins） */
  pluginsRoot?: string;
}