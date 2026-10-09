/**
 * Aervox｜思隅 @aervox/core — 系统根提示词与工具使用指南 (Base System Prompt)
 *
 * 规则依据：
 * - AVX-HAR-001 §7.1 Context 组装规范（第 1 项：固定系统安全与产品边界；第 5 项：工具引导与约束）
 * - 明确定义核心工具调用时机、调用约束与硬性准则；
 * - 规则：当且仅当工具在当前 Turn 中被提供（可见）时方可调用；新增工具必须在此扩展登记。
 */
import type { ToolSpec } from "./types.js";


/** 工具调用与行为指导规范 */
export interface ToolGuidance {
  name: string;
  whenToUse: string;
  whenNotToUse?: string;
  constraints?: string[];
}

/**
 * 内核内置工具的标准指引清单（ADR-021 内核提纯修订：仅登记内核自有工具；
 * 宿主/插件贡献的工具 guidance 由宿主经 BaseSystemPromptOptions.customGuidance 注入，
 * 参考 apps/api 的 HOST_TOOL_GUIDANCE。新增内核工具必须往此表追加登记。）
 */
export const BASE_TOOL_GUIDANCE: readonly ToolGuidance[] = [
  {
    name: "ask_user_question",
    whenToUse: "当且仅当需要用户进行关键决策确认、方案选择（如 Plan Review）、或缺少必要信息无法继续推进任务时调用。",
    whenNotToUse: "任务明确或可以根据常理进行合理默认推断时，禁止冗余提问；Subagent（子任务）执行期间禁止直接调用。",
    constraints: [
      "问题必须简明，若有推荐选项必须放置在首位并追加 `(Recommended)` 标记。",
      "若使用 `plan-review` 意图，必须在 `detail` 中完整提供待审查的计划 Markdown，且 `intent.approve` 必须与选项匹配。",
    ],
  },
  {
    name: "subagent_delegate",
    whenToUse: "当任务较为庞大、具有高度独立性或需要委托子任务在隔离上下文中执行时调用。",
    whenNotToUse: "单步简单任务、或直接通过当前可用工具即可完成的任务无需委托。",
    constraints: [
      "必须提供清晰明确的 `task` 目标描述。",
      "子任务执行期间无法直接与人类互动，未决事项将汇总在子任务输出中返回。",
    ],
  },
  {
    name: "workflow_run",
    whenToUse: "当需要执行预先注册的标准工作流步骤时调用。",
    whenNotToUse: "无匹配的已注册工作流时禁止随意捏造 workflow 名称。",
    constraints: [
      "步骤顺序执行，前序步骤输出作为后续步骤输入。",
    ],
  },
];

export interface BaseSystemPromptOptions {
  assistantName?: string;
  /** 宿主身份与职责；缺省使用中立助手描述。 */
  identity?: string;
  /** 宿主输出策略，内核不指定产品表现格式。 */
  outputStyle?: string;
  personaPrompt?: string;
  activeTools?: ToolSpec[];
  customGuidance?: ToolGuidance[];
  /** 扩展提示词片段清单（由插件通过切面或特定运行模式规范等注入），将按序插入在基础工具指南与人格/输出规范之间 */
  extraSections?: string[];
}

/**
 * 构建系统根提示词 (Base System Prompt)
 */
export function buildBaseSystemPrompt(options: BaseSystemPromptOptions = {}): string {
  const name = options.assistantName || "Assistant";
  const guidanceList = [...BASE_TOOL_GUIDANCE, ...(options.customGuidance || [])];
  const hasPersona = Boolean(options.personaPrompt?.trim());

  const sections: string[] = [
    `# 身份与角色`,
    options.identity ?? `你是 ${name}，协助用户完成任务。`,
    ...(hasPersona
      ? [
          `注意：若下方「人格设定」对名称、称呼、性格、语气、行为风格或可用技能另有定义，以人格设定为准，本节仅作缺省兜底。`,
        ]
      : []),
    ``,
    `# 工具使用规范与约束 (Tool Usage & Constraints)`,
    `1. **工具可用性判断**：你只能调用当前会话明确提供的工具。严禁臆造或调用未在当前 schema 中声明的工具。`,
    `2. **适时调用原则**：只有在真正需要获取外部数据、持久化状态或向用户获取必要输入时才调用工具，避免无意义的频繁工具调用。`,
    `3. **参数严格性**：工具参数必须完全符合声明的 JSON Schema，禁止缺失必填字段。`,
    `4. **人机互动（ask_user_question）规则**：在面临模糊分支、破坏性操作或计划审批时，优先向用户提问，选项需清晰对齐。`,
    `5. **工具演进约束**：所有新接入系统的工具必须遵循相同的使用时机与边界约束。`,
  ];

  // 注入工具具体的调用时机与边界
  sections.push(``, `## 核心工具使用时机指南:`);
  for (const g of guidanceList) {
    sections.push(`- **\`${g.name}\`**:`);
    sections.push(`  - **何时使用**: ${g.whenToUse}`);
    if (g.whenNotToUse) {
      sections.push(`  - **何时禁止使用**: ${g.whenNotToUse}`);
    }
    if (g.constraints && g.constraints.length > 0) {
      sections.push(`  - **约束要求**: ${g.constraints.join("; ")}`);
    }
  }

  // 注入扩展提示词片段清单（由插件通过切面或特定运行模式规范等注入）
  if (options.extraSections && options.extraSections.length > 0) {
    for (const extra of options.extraSections) {
      if (extra && extra.trim().length > 0) {
        sections.push(``, extra.trim());
      }
    }
  }

  // 拼接自定义人格提示词（如有）：人格设定优先于默认身份与风格（安全策略除外）
  if (options.personaPrompt && options.personaPrompt.trim().length > 0) {
    sections.push(
      ``,
      `# 人格设定 (Persona Settings · 最高优先级：覆盖默认身份、名称、称呼与风格；安全与数据策略除外)`,
      options.personaPrompt.trim(),
    );
  }

  if (options.outputStyle?.trim()) sections.push(``, options.outputStyle.trim());

  return sections.join("\n");
}
