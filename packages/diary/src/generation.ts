/**
 * Aervox｜思隅 @aervox/diary — 日记生成核心（API 按需路径 + Worker 定时路径共用）
 *
 * DiaryModelPort 由宿主注入；协议、默认配置与 Provider 创建归模型基础设施。
 * 非模型模式和显式不可用配置采用标明 template 的确定性模板。
 */
import type { DiaryMaterialPort, LocalContext } from "@aervox/contracts";
import { diaryMaterialCount } from "./material.js";
import { buildDiarySystemPrompt, buildDiaryUserPrompt } from "./prompts.js";
import { renderTemplateDiary, type DiaryDraft } from "./template.js";

/** 单次日记生成的模型端口（宿主注入；测试注入确定性实现） */
export interface DiaryModelPort {
  generate(input: {
    context: LocalContext;
    system: string;
    user: string;
  }): Promise<string>;
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

/** 当日窗口：本地零点（换算为 UTC ISO，与 createdAt 的 toISOString 存储格式对齐）至当前时刻。
 *  不得用本地零点的无时区字符串「近似」：UTC+8 等东半球时区在本地 0 点至 UTC 零点之间
 *  本地日期超前 UTC 日期，字符串比较会把当天消息全部排除（缺陷：diary 素材 materialCount=0）。 */
export function todayWindow(now = new Date()): { startIso: string; endIso: string } {
  const localDate = localDateToday(now);
  const [year, month, day] = localDate.split("-").map(Number);
  const localMidnight = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  return {
    startIso: localMidnight.toISOString(),
    endIso: now.toISOString(),
  };
}

import { DiaryStyleRegistry, defaultDiaryStyleRegistry } from "./styles.js";

export interface DiaryGenerationServiceDeps {
  materials: DiaryMaterialPort;
  /** 宿主显式决定是否使用模型，领域服务不读取进程环境。 */
  useModel?: boolean;
  /** llm 模式端口；未注入或租户未启用 LLM 时模板降级 */
  model: DiaryModelPort | null;
  /** 可选的日记提炼风格注册表；缺省时使用 defaultDiaryStyleRegistry */
  styles?: DiaryStyleRegistry;
}

export class DiaryGenerationService {
  constructor(private readonly deps: DiaryGenerationServiceDeps) {}

  /** 生成一篇日记草稿（素材采集 + 模型调用 / 模板降级） */
  async generate(
    tenant: LocalContext,
    input: {
      localDate: string;
      window: { startIso: string; endIso: string };
      focus?: string;
      styleId?: string;
    },
  ): Promise<DiaryDraft> {
    const styleRegistry = this.deps.styles ?? defaultDiaryStyleRegistry;
    const style =
      (input.styleId ? styleRegistry.get(input.styleId) : undefined) ??
      styleRegistry.getDefault();

    const material = await this.deps.materials.collect(tenant, input.window);
    const materialCount = diaryMaterialCount(material);

    if (this.deps.useModel === false || !this.deps.model) {
      return renderTemplateDiary(material, input.localDate, style.id);
    }

    try {
      const raw = await this.deps.model.generate({
        context: tenant,
        system: style.buildSystemPrompt("思思"),
        user: style.buildUserPrompt(material, input.localDate, input.focus),
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
        return renderTemplateDiary(material, input.localDate, style.id);
      }
      throw err;
    }
  }
}