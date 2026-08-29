/**
 * Aervox｜思隅 @aervox/practice-review — 术语抽取与过滤（CAP-007 / CAP-002）
 *
 * 核心特性：
 * 1. LLM 初提（严格 prompt，只提连续短语、技术名词，排除泛化词，输出 JSON）
 * 2. LLM 复核（候选 > 5 时由质检 prompt 逐条判定 keep/drop）
 * 3. 正则与 JSON 修复兜底（从残缺响应提取 text 字段）
 * 4. 本地启发式（拉丁/英文缩写/数字词、引号/书名号实体、2-4 字专业中文连续短语）
 * 5. 归一化与停用词过滤（去首尾标点、停用词黑名单、子串重叠去重：短词被长词包含则丢弃）
 * 6. 关系标注：background（背景/定义/深度下钻）或 related（关联/对比/发散）
 */

export interface ExtractedTerm {
  text: string;
  relation: "background" | "related";
  description?: string;
}

export interface LLMCallable {
  generate: (prompt: string, options?: { systemPrompt?: string; temperature?: number }) => Promise<string>;
}

export interface ExtractTermsOptions {
  llm?: LLMCallable;
  maxTerms?: number;
  enableHeuristicFallback?: boolean;
}

/** 通用词/停用词黑名单（不具有技术下钻或概念对比价值的词） */
const GENERIC_STOPWORDS = new Set([
  "这个", "那个", "什么", "怎么", "如何", "可以", "需要", "进行", "问题", "方法",
  "过程", "结果", "内容", "情况", "方面", "部分", "作用", "意义", "系统", "功能",
  "实现", "使用", "应用", "设计", "开发", "学习", "研究", "分析", "总结", "概述",
  "基础", "核心", "关键", "主要", "重要", "特点", "优势", "劣势", "步骤", "阶段",
  "要求", "目标", "原则", "方式", "模式", "逻辑", "结构", "数据", "信息", "用户",
  "代码", "文件", "项目", "模块", "组件", "对象", "变量", "函数", "接口", "参数",
  "this", "that", "what", "how", "why", "can", "need", "do", "make", "use",
  "user", "data", "info", "code", "file", "function", "method", "class", "object",
]);

/** 清理首尾标点与空格 */
export function cleanTermText(text: string): string {
  if (!text) return "";
  // 清理常见的首尾中英文标点、引号、括号、空白
  return text
    .trim()
    .replace(/^[`"'“”‘’《》（）()\[\]【】\s.,，。、:：;；!！?？]+/, "")
    .replace(/[`"'“”‘’《》（）()\[\]【】\s.,，。、:：;；!！?？]+$/, "")
    .trim();
}

/** 判断是否为泛化泛词或无效词 */
export function isGenericTerm(text: string): boolean {
  const cleaned = cleanTermText(text).toLowerCase();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 25) return true;
  if (GENERIC_STOPWORDS.has(cleaned)) return true;
  // 纯纯数字或标点
  if (/^[\d\s.,_-]+$/.test(cleaned)) return true;
  // 单纯纯英文介词或连词
  if (/^(the|a|an|in|on|at|for|to|of|and|or|by|with)$/i.test(cleaned)) return true;
  return false;
}

/** 子串重叠去重：若短词被长词完全包含且在同一语义域，保留更精准的长词 */
export function dedupeOverlapTerms(terms: ExtractedTerm[]): ExtractedTerm[] {
  const uniqueMap = new Map<string, ExtractedTerm>();
  for (const t of terms) {
    const cleaned = cleanTermText(t.text);
    if (isGenericTerm(cleaned)) continue;
    if (!uniqueMap.has(cleaned.toLowerCase())) {
      uniqueMap.set(cleaned.toLowerCase(), { ...t, text: cleaned });
    }
  }

  const list = Array.from(uniqueMap.values());
  const kept: ExtractedTerm[] = [];

  for (let i = 0; i < list.length; i++) {
    const current = list[i];
    if (!current) continue;
    let isSubstr = false;
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const other = list[j];
      if (other && other.text.length > current.text.length && other.text.toLowerCase().includes(current.text.toLowerCase())) {
        // 短词包含在长词内，丢弃短词，保留更长更具体的专业术语
        isSubstr = true;
        break;
      }
    }
    if (!isSubstr) {
      kept.push(current);
    }
  }

  return kept;
}

/**
 * 启发式本地抽取（包含引号、书名号、专有名词、拉丁缩写等）
 */
export function extractHeuristicTerms(text: string): ExtractedTerm[] {
  if (!text) return [];
  const results: ExtractedTerm[] = [];

  // 1. 书名号/引号中的专有实体 《...》、“...”、"..."、`...`
  const quoteRegex = /(?:《([^》]+)》|“([^”]+)”|"([^"]+)"|`([^`]+)`)/g;
  let match: RegExpExecArray | null;
  while ((match = quoteRegex.exec(text)) !== null) {
    const entity = match[1] || match[2] || match[3] || match[4];
    if (entity) {
      const cleaned = cleanTermText(entity);
      if (!isGenericTerm(cleaned)) {
        results.push({ text: cleaned, relation: "background" });
      }
    }
  }

  // 2. 连续中英文技术词/缩写/数字复合词（如 Dijkstra 算法、OAuth2.0、TypeScript、React 19、JWT）
  const techRegex = /\b[A-Za-z][A-Za-z0-9_+#.-]*(?:\s*(?:算法|定理|协议|架构|模型|模式|机制|原理|定律|变换|方程|结构|序列|体系))?/gu;
  while ((match = techRegex.exec(text)) !== null) {
    const term = match[0];
    if (term) {
      const cleaned = cleanTermText(term);
      if (cleaned.length >= 2 && !isGenericTerm(cleaned)) {
        results.push({ text: cleaned, relation: "related" });
      }
    }
  }

  // 3. 常见中文术语匹配（2~5个汉字后接 算法/定理/协议/架构/模型/模式/机制/树/图/矩阵/分析）
  const cnTermSuffixRegex = /([\u4e00-\u9fa5]{2,6}(?:算法|定理|协议|架构|模型|模式|机制|原理|定律|变换|方程|结构|序列|体系))/g;
  while ((match = cnTermSuffixRegex.exec(text)) !== null) {
    const term = match[1];
    if (term) {
      const cleaned = cleanTermText(term);
      if (!isGenericTerm(cleaned)) {
        results.push({ text: cleaned, relation: "background" });
      }
    }
  }

  return dedupeOverlapTerms(results);
}

/** 从可能残缺或包含 markdown 标记的 LLM 输出中安全解析 JSON */
export function parseTermsFromJSON(jsonText: string): ExtractedTerm[] {
  if (!jsonText || typeof jsonText !== "string") return [];

  // 1. 优先尝试提取 ```json ... ``` 块
  const jsonBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = jsonBlock && jsonBlock[1] ? jsonBlock[1] : jsonText;

  try {
    const parsed = JSON.parse(raw.trim());
    const items = Array.isArray(parsed) ? parsed : (parsed?.terms || parsed?.items || []);
    if (Array.isArray(items)) {
      const results: ExtractedTerm[] = [];
      for (const item of items) {
        if (item && typeof item.text === "string") {
          const relation: "background" | "related" = item.relation === "related" ? "related" : "background";
          results.push({
            text: cleanTermText(item.text),
            relation,
            description: typeof item.description === "string" ? item.description : undefined,
          });
        }
      }
      return results.filter((t) => !isGenericTerm(t.text));
    }
  } catch {
    // JSON 解析失败，执行正则兜底从文本中提取 text 与 relation 字段
  }

  // 2. 正则兜底解析
  const fallbackTerms: ExtractedTerm[] = [];
  const itemRegex = /"text"\s*:\s*"([^"]+)"(?:\s*,\s*"relation"\s*:\s*"(background|related)")?/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(raw)) !== null) {
    const textMatch = match[1];
    if (textMatch) {
      const text = cleanTermText(textMatch);
      const relation: "background" | "related" = match[2] === "related" ? "related" : "background";
      if (!isGenericTerm(text)) {
        fallbackTerms.push({ text, relation });
      }
    }
  }

  return fallbackTerms;
}

/**
 * 术语抽取两阶段标准 Pipeline
 */
export async function extractTerms(
  fullText: string,
  options: ExtractTermsOptions = {},
): Promise<ExtractedTerm[]> {
  const { llm, maxTerms = 8, enableHeuristicFallback = true } = options;
  if (!fullText || typeof fullText !== "string" || fullText.trim().length === 0) {
    return [];
  }

  let candidates: ExtractedTerm[] = [];

  if (llm) {
    try {
      // 阶段 1: LLM 初提 (_llm_extract)
      const extractSystemPrompt = `你是一个专业的知识图谱与技术术语抽取引擎。
你的任务是从给定的技术或学习文本中，提取出最核心、最具有进一步深入学习与追问探索价值的技术名词、科学概念或算法原理。
规则：
1. 必须是原文中直接出现或高度紧密的连续专有名词、核心概念；
2. 严禁提取“这个、方法、实现、问题、步骤、可以”等日常泛化词；
3. 输出纯 JSON 数组，每个对象包含：
   - "text": 术语名词（简洁精确）
   - "relation": "background"（基础背景/核心定义，适合下钻深挖）或 "related"（衍生技术/关联对比，适合对比发散）
   - "description": 简短一句话说明（10字以内）
4. 控制在 3~8 个最精炼的关键术语。`;

      const prompt = `请从以下内容中提取核心专业术语：\n\n${fullText}`;
      const response = await llm.generate(prompt, {
        systemPrompt: extractSystemPrompt,
        temperature: 0.1,
      });

      candidates = parseTermsFromJSON(response);

      // 阶段 2: LLM 复核 (_llm_judge) — 当候选词 > 5 时进行质检过滤
      if (candidates.length > 5) {
        const judgeSystemPrompt = `你是一位严苛的技术质检员。
请对以下候选术语进行严格筛选，剔除过于泛化、无实际技术深度或容易产生歧义的词汇，只保留真正值得作为知识点追问下钻或对比学习的高价值名词。
只返回筛选后保留的 JSON 数组。`;

        const judgePrompt = `候选术语列表：\n${JSON.stringify(candidates, null, 2)}\n\n请输出最终筛选后的有效术语 JSON 数组。`;
        try {
          const judgedResponse = await llm.generate(judgePrompt, {
            systemPrompt: judgeSystemPrompt,
            temperature: 0.1,
          });
          const judged = parseTermsFromJSON(judgedResponse);
          if (judged.length > 0) {
            candidates = judged;
          }
        } catch {
          // 复核出错时优雅退化为初提结果
        }
      }
    } catch {
      // LLM 调用异常，自动退化为本地启发式
    }
  }

  // 若 LLM 未提供或抽取为空，且启用了启发式兜底
  if (candidates.length === 0 && enableHeuristicFallback) {
    candidates = extractHeuristicTerms(fullText);
  }

  // 归一化过滤与重叠去重
  const deduped = dedupeOverlapTerms(candidates);
  return deduped.slice(0, maxTerms);
}
