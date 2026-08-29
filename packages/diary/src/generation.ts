/**
 * Aervox｜思隅 @aervox/diary — 日记生成核心（API 按需路径 + Worker 定时路径共用）
 *
 * Provider 缝隙：DiaryModelPort 由装配层注入——llm 模式走 OpenAI 兼容 provider
 * （经 DiaryLlmConfigPort 解析租户配置），replay/scripted 等非 LLM 模式走确定性模板
 * （诚实降级，输出标注 template）；租户 LLM 未启用时同样模板降级。
 */
import { createOpenAICompatProvider } from "@aervox/agent-loop";
import type { ModelProviderPort, ModelRequest } from "@aervox/agent-loop";
import type { AervoxDatabase, SqliteLLMConfigRepository, TenantContext } from "@aervox/database";
import { collectDiaryMaterial, diaryMaterialCount } from "./material.js";
import { buildDiarySystemPrompt, buildDiaryUserPrompt } from "./prompts.js";
import { renderTemplateDiary, type DiaryDraft } from "./template.js";

/** 单次日记生成的模型端口（宿主注入；测试注入确定性实现） */
export interface DiaryModelPort {
  generate(input: {
    tenant: TenantContext;
    system: string;
    user: string;
  }): Promise<string>;
}

/** 供 openai-compat provider 使用的纯配置（不含是否启用/供应商协议判断） */
export interface DiaryLlmConfig {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
}

/** 按租户解析日记 LLM 配置的端口（null = 未启用/不支持，服务层模板降级） */
export interface DiaryLlmConfigPort {
  getConfig(tenant: TenantContext): Promise<DiaryLlmConfig | null>;
}

/** 无配置行时的缺省供应商参数（镜像 apps/api LLMConfigService 的 ollama 预设） */
const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LLM_MODEL_ID = "llama3.2";

/** 由 SqliteLLMConfigRepository 构建配置端口：无配置行走 ollama 缺省，显式禁用返回 null */
export function createRepoDiaryLlmConfigPort(
  repo: SqliteLLMConfigRepository,
): DiaryLlmConfigPort {
  return {
    async getConfig(tenant) {
      const found = await repo.getConfig(tenant);
      if (!found) {
        return {
          baseUrl: DEFAULT_LLM_BASE_URL,
          modelId: DEFAULT_LLM_MODEL_ID,
          temperature: 0.7,
          maxTokens: 4096,
        };
      }
      if (!Boolean(found.enabled)) return null;
      return {
        baseUrl: found.baseUrl,
        apiKey: found.apiKey ?? undefined,
        modelId: found.modelId,
        temperature: found.temperature,
        maxTokens: found.maxTokens ?? 4096,
      };
    },
  };
}

/** LLM 模式端口：解析租户配置 → OpenAI 兼容 provider，消费流式输出拼接全文 */
export function createLlmDiaryModelPort(cfgPort: DiaryLlmConfigPort): DiaryModelPort {
  return {
    async generate({ tenant, system, user }) {
      const cfg = await cfgPort.getConfig(tenant);
      if (!cfg) {
        throw new Error("llm_disabled: 当前租户未启用 LLM 配置，无法生成日记");
      }
      const provider = createOpenAICompatProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      });
      const request: ModelRequest = {
        turnId: "diary_generation",
        attemptId: `diary_${Date.now().toString(36)}`,
        step: 1,
        context: {
          turnId: "diary_generation",
          sessionId: "diary_generation",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
      };
      let text = "";
      for await (const chunk of provider.stream(request)) {
        text += chunk.text ?? "";
      }
      if (!text.trim()) throw new Error("llm_empty_output: 模型未返回日记内容");
      return text;
    },
  };
}

/** 解析模型输出：「标题：…」首行 + 正文；缺标题时回退默认 */
export function parseDiaryDraft(raw: string, localDate: string): { title: string; content: string } {
  const text = raw.trim();
  const titleMatch = text.match(/^标题[：:]\s*(.+)$/m);
  if (titleMatch) {
    const title = (titleMatch[1] ?? "").trim().slice(0, 100) || `${localDate} 的日记`;
    const content = text.replace(titleMatch[0], "").trim();
    return { title, content: content || text };
  }
  return { title: `${localDate} 的日记`, content: text };
}

let diarySeq = 0;
export function generateDiaryId(prefix: string): string {
  diarySeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${diarySeq.toString(36)}`;
}

/** 当日本地日期标签（服务器/浏览器本地时区；调度与按需路径统一使用） */
export function localDateToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 当日窗口：本地零点（ISO 近似，按本地日期前缀过滤）至当前时刻 */
export function todayWindow(now = new Date()): { startIso: string; endIso: string } {
  const localDate = localDateToday(now);
  return {
    startIso: `${localDate}T00:00:00`,
    endIso: now.toISOString(),
  };
}

export interface DiaryGenerationServiceDeps {
  db: AervoxDatabase;
  /** llm 模式端口；未注入或租户未启用 LLM 时模板降级 */
  model: DiaryModelPort | null;
}

export class DiaryGenerationService {
  constructor(private readonly deps: DiaryGenerationServiceDeps) {}

  /** 生成一篇日记草稿（素材采集 + 模型调用 / 模板降级） */
  async generate(
    tenant: TenantContext,
    input: { localDate: string; window: { startIso: string; endIso: string }; focus?: string },
  ): Promise<DiaryDraft> {
    const material = await collectDiaryMaterial(this.deps.db, tenant, input.window);
    const materialCount = diaryMaterialCount(material);

    const mode = process.env.AERVOX_LOOP_PROVIDER ?? "llm";
    if (mode !== "llm" || !this.deps.model) {
      return renderTemplateDiary(material, input.localDate);
    }

    try {
      const raw = await this.deps.model.generate({
        tenant,
        system: buildDiarySystemPrompt("思思"),
        user: buildDiaryUserPrompt(material, input.localDate, input.focus),
      });
      const parsed = parseDiaryDraft(raw, input.localDate);
      return {
        title: parsed.title,
        content: parsed.content,
        generatedBy: "llm",
        materialCount,
      };
    } catch (err) {
      // 租户未启用/供应商协议不支持：诚实模板降级；其余错误上抛（配置问题应在链路中显性暴露）
      if (err instanceof Error && err.message.startsWith("llm_disabled")) {
        return renderTemplateDiary(material, input.localDate);
      }
      throw err;
    }
  }
}