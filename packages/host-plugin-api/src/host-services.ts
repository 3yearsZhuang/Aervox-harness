/**
 * Aervox｜思隅 @aervox/host-plugin-api — 宿主服务窄端口 (Host Services)
 *
 * 机器事实源：CR-060 与 AVX-PLUG-001 §0.3。
 *
 * 插件**不得**接触数据库、模式包、仓储或宿主实时总线（由 `scripts/import-boundary.mjs`
 * 的 `plugins-domain-no-db-no-host` 规则机器强制）。凡插件需要宿主侧资源，一律经本文件
 * 声明的窄端口：宿主按当前本地上下文构造实现并注入，插件只声明意图，不感知表、连接与事务。
 *
 * 边界判定（`docs/reference/capability-composition.md` 的「核心与可选的边界判定」）：
 * 学习事实真源（表结构、仓储、复习排期）属 `CAP-003/004/006`，按反向检查保留主仓；
 * 插件以普通消费方身份经 `learningFacts` 窄端口读写，不取得真源所有权。
 */

/** 会话编排窄端口：插件可发起新会话与探索分支 */
export interface PluginSessionPort {
  /** 新建会话，返回其 id */
  createSession(title: string): Promise<{ id: string }>;
  /** 在父会话下建立探索分支（`reason` 为分支归因标签，由调用方自述来源） */
  createBranch(input: {
    id: string;
    parentSessionId: string;
    childSessionId: string;
    title: string;
    reason: string;
  }): Promise<void>;
}

/** 一次作答判定的写入意图（本地上下文已绑定在端口实例上，故不经参数传递） */
export interface JudgedAnswerInput {
  /** 触发本次作答的回合 id（作为作答记录的会话溯源） */
  turnId: string;
  /** 题干 */
  prompt: string;
  /** 题型：choice | short_answer | fill_blank（展示用） */
  questionType?: string;
  /** 用户原始回答 */
  userAnswer: string;
  /** 标准答案 */
  correctAnswer: string;
  judgement: "correct" | "incorrect" | "partial";
  /** 解析（答错时的纠正说明） */
  explanation?: string;
  /** 可选知识点概念描述 */
  knowledgeConcept?: string;
  /** 证据来源标签：由调用方自述（通常为其插件 id），宿主不做语义解释 */
  source?: string;
}

/** 作答落库回执 */
export interface JudgedAnswerReceipt {
  questionId: string;
  attemptId: string;
  judgement: "correct" | "incorrect" | "partial";
  /** judgement === "incorrect" 时进入错题本 */
  enteredMistakeNotebook: boolean;
}

/**
 * 宿主自有不可变记录。
 * 插件将其视为**不透明载荷**：只做 API 响应转发，不解析内部字段，
 * 以此避免插件反向依赖宿主表结构（真源仍归宿主持有）。
 */
export type HostRecord = Readonly<Record<string, unknown>>;

/** 练习报告写入意图（统计口径由调用方决定，宿主只负责落库） */
export interface ReportDraft {
  sessionId: string;
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  avgTimeSpentSec?: number;
  totalHintsUsed?: number;
  masteryPrediction?: number;
  biasAssessment?: string;
  reportType?: string;
}

/**
 * 学习事实窄端口。
 * 宿主代持 `CAP-003/004/006` 的学习事实真源与复习推断，插件只声明读写意图。
 */
export interface PluginLearningFactPort {
  /** 落库一次作答判定（写 questions + question_attempts） */
  recordJudgedAnswer(input: JudgedAnswerInput): Promise<JudgedAnswerReceipt>;
  /** 新建练习报告 */
  writeReport(draft: ReportDraft): Promise<HostRecord>;
  /** 按 id 读取练习报告 */
  readReport(reportId: string): Promise<HostRecord | null>;
  /** 按会话列出练习报告 */
  listReports(sessionId: string): Promise<HostRecord[]>;
  /** 重置掌握度推断（保留原始作答） */
  resetInference(sessionId: string): Promise<HostRecord>;
}

/**
 * 插件装配时由宿主注入的服务集合，**按当前本地上下文绑定**。
 * 宿主按 request / turn 粒度构造；插件不得缓存跨上下文的实例。
 */
export interface PluginHostServices {
  sessions: PluginSessionPort;
  learningFacts: PluginLearningFactPort;
}
