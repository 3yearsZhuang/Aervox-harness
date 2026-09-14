/**
 * Aervox｜思隅 @aervox/config — 运行时配置（缺陷 E）
 *
 * 把散落在 api/worker 的 process.env 直读收敛为单一类型化配置：
 * - 集中默认值：每个键在一个地方给出默认；
 * - 启动期校验：非法值（数字/枚举）fail-fast 抛错，杜绝配置漂移静默失效；
 * - 优先级沿用既定声明：进程环境变量 > .env > mise [env] > 代码内置默认；
 * - 纯函数式 loadXxxConfig(env?)：测试可注入 env，不依赖进程全局状态。
 */
export type LoopProvider =
  | "replay"
  | "scripted"
  | "scripted-write"
  | "scripted-privileged"
  | "scripted-quiz"
  | "llm";

/**
 * Loop Driver 选择（AERVOX_LOOP_DRIVER，默认 native）：
 * - native（默认）：进程内 executeTurn，模型 Provider 由 AERVOX_LOOP_PROVIDER 选择；
 * - dsh：整 Turn 走 DSH 进程外 Adapter（ADR-010 阶段 6f），自带 Agent 循环与模型回合，
 *   AERVOX_LOOP_PROVIDER 不参与。准入前置：reference/deepseek-harness 子模块固定 SHA
 *   复核通过（AERVOX_DSH_REPO_ROOT 可显式指定仓库根）；模型回合需 DEEPSEEK_API_KEY
 *   或 DSH_LLM_BASE_URL（OpenAI 兼容端点）。未就绪 fail-closed（Turn Failed，不回退 native）。
 *   pi 为保留项：真 pi Adapter 落地前不进枚举，配置期即 fail-fast。
 */
export type ApiLoopDriver = "native" | "dsh";

/**
 * Turn 执行模式（AERVOX_TURN_EXECUTION）：
 * - background（默认）：POST /turns 落库后立即返回，Agent Loop 后台执行，
 *   客户端经 SSE 活流（重放 + tail）观察进度——深度思考等长回合不再阻塞 HTTP 响应；
 * - inline：POST 内联等 Loop 跑完再返回（旧语义；测试与排查用）。
 */
export type TurnExecution = "background" | "inline";

/** 日志级别（AERVOX_LOG_LEVEL） */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志格式（AERVOX_LOG_FORMAT） */
export type LogFormat = "json" | "pretty";

/** GPT-Sovits 语音输出 provider 配置（voice 模块） */
export interface GptSovitsConfig {
  modelPath?: string;
  allowedRoots: string[];
  endpoint?: string;
  protocol: "http" | "websocket";
  modelId: string;
  secretRef?: string;
}

/** 本地/远程语音识别 provider 配置（voice 模块） */
export interface AsrConfig {
  senseVoiceBaseUrl: string;
  senseVoiceModelPath?: string;
  senseVoiceAllowedRoots: string[];
  whisperEndpoint?: string;
  whisperApiKey?: string;
  whisperModelId: string;
}

/**
 * CR-033 F0 阻断项之一：主动智能演进子片独立 Feature Flag。
 *
 * 每个子 CR 拥有独立开关，可单独回退到 CR-032 基线行为：
 * - situation_projection: E1 SituationModel 影子投影读取切换
 * - proactive_dsl:        E2a 受限规则 DSL
 * - attention_budget:     E2b 注意力预算与回执
 * - proactive_persona:    P5 主动回合人格/安全/记忆同源
 * - perception_events:    E3 感知事件流
 * - operation_catalog:    O1 结构化操作目录
 * - operation_proposals:  O2 主动提议闭环
 * 环境变量：AERVOX_PROACTIVE_SITUATION_PROJECTION 等（默认 off = 保留既有行为）。
 */
export type ProactiveFeatureFlag =
  | "situation_projection"
  | "proactive_dsl"
  | "attention_budget"
  | "proactive_persona"
  | "perception_events"
  | "operation_catalog"
  | "operation_proposals";

export const PROACTIVE_FEATURE_FLAGS: readonly ProactiveFeatureFlag[] = [
  "situation_projection",
  "proactive_dsl",
  "attention_budget",
  "proactive_persona",
  "perception_events",
  "operation_catalog",
  "operation_proposals",
] as const;

const FLAG_ENV: Record<ProactiveFeatureFlag, string> = {
  situation_projection: "AERVOX_PROACTIVE_SITUATION_PROJECTION",
  proactive_dsl: "AERVOX_PROACTIVE_DSL",
  attention_budget: "AERVOX_PROACTIVE_ATTENTION_BUDGET",
  proactive_persona: "AERVOX_PROACTIVE_PERSONA",
  perception_events: "AERVOX_PROACTIVE_PERCEPTION_EVENTS",
  operation_catalog: "AERVOX_PROACTIVE_OPERATION_CATALOG",
  operation_proposals: "AERVOX_PROACTIVE_OPERATION_PROPOSALS",
};

/**
 * 解析主动智能 feature flags（可注入 env 便于测试；默认读取进程环境变量）。
 * 任一 flag 显式置 "1"/"true" 视为开启，否则关闭（fail-closed）。
 */
export function loadProactiveFeatureFlags(env: NodeJS.ProcessEnv = process.env): ReadonlySet<ProactiveFeatureFlag> {
  const enabled = new Set<ProactiveFeatureFlag>();
  for (const flag of PROACTIVE_FEATURE_FLAGS) {
    const raw = env[FLAG_ENV[flag]]?.trim().toLowerCase();
    if (raw === "1" || raw === "true") enabled.add(flag);
  }
  return enabled;
}

/**
 * CR-034 F0 阻断项：本地模型降级阶梯子片独立 Feature Flag。
 *
 * 每个子 CR 拥有独立开关，可单独回退到 CR-015/029 既有激活配置行为：
 * - model_routing:      N1 降级决策器、健康探测与 L0/L1 路由切换
 * - capability_tiering: N2a 能力分级与服务端工具策略
 * - rule_response:      N2b 对话侧 L2 规则回应
 * - local_runtime_host: N3 本地运行时生命周期托管（默认关闭）
 * 环境变量：AERVOX_MODEL_ROUTING 等（默认 off = fail-closed 保留既有行为）。
 */
export type ModelRoutingFeatureFlag =
  | "model_routing"
  | "capability_tiering"
  | "rule_response"
  | "local_runtime_host";

export const MODEL_ROUTING_FEATURE_FLAGS: readonly ModelRoutingFeatureFlag[] = [
  "model_routing",
  "capability_tiering",
  "rule_response",
  "local_runtime_host",
] as const;

const MODEL_ROUTING_FLAG_ENV: Record<ModelRoutingFeatureFlag, string> = {
  model_routing: "AERVOX_MODEL_ROUTING",
  capability_tiering: "AERVOX_CAPABILITY_TIERING",
  rule_response: "AERVOX_RULE_RESPONSE",
  local_runtime_host: "AERVOX_LOCAL_RUNTIME_HOST",
};

/**
 * 解析模型路由与降级阶梯 feature flags（可注入 env 便于测试；默认读取进程环境变量）。
 * 任一 flag 显式置 "1"/"true" 视为开启，否则关闭（fail-closed）。
 */
export function loadModelRoutingFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<ModelRoutingFeatureFlag> {
  const enabled = new Set<ModelRoutingFeatureFlag>();
  for (const flag of MODEL_ROUTING_FEATURE_FLAGS) {
    const raw = env[MODEL_ROUTING_FLAG_ENV[flag]]?.trim().toLowerCase();
    if (raw === "1" || raw === "true") enabled.add(flag);
  }
  return enabled;
}

/** @aervox/api 启动与运行时配置 */
export interface ApiConfig {
  /** HTTP 监听端口（PORT，默认 3000） */
  port: number;
  /** HTTP 监听地址（AERVOX_API_HOST，默认 loopback） */
  host: string;
  /** 日志级别（AERVOX_LOG_LEVEL，默认 info） */
  logLevel: LogLevel;
  /** 日志格式（AERVOX_LOG_FORMAT，默认开发 pretty、生产 json） */
  logFormat: LogFormat;
  /** Agent Loop 模型 Provider（AERVOX_LOOP_PROVIDER，默认 llm） */
  loopProvider: LoopProvider;
  /** Loop Driver（AERVOX_LOOP_DRIVER，默认 native；dsh = 整 Turn 进程外 DSH Adapter） */
  loopDriver: ApiLoopDriver;
  /** Turn 执行模式（AERVOX_TURN_EXECUTION，默认 background） */
  turnExecution: TurnExecution;
  /** Context 压缩方式：rule | off（AERVOX_LOOP_COMPACTION，默认 off） */
  loopCompaction: "rule" | "off";
  /** 3b privileged 工具管理员白名单（AERVOX_ADMIN_IDS，逗号分隔，默认空） */
  adminIds: string[];
  gptSovits: GptSovitsConfig;
  asr: AsrConfig;
  /** CR-033 API 侧事件双写等切片开关。 */
  proactiveFeatureFlags: ReadonlySet<ProactiveFeatureFlag>;
  /** CR-034 模型路由与降级阶梯开关。 */
  modelRoutingFeatureFlags: ReadonlySet<ModelRoutingFeatureFlag>;
}

/** @aervox/worker 运行时配置 */
export interface WorkerConfig {
  workerId: string;
  /** 任务默认节拍（WORKER_TICK_MS，默认 5000） */
  tickMs: number;
  /** 日志级别（AERVOX_LOG_LEVEL，默认 info） */
  logLevel: LogLevel;
  /** 日志格式（AERVOX_LOG_FORMAT，默认开发 pretty、生产 json） */
  logFormat: LogFormat;
  /**
   * 按任务独立节拍覆盖（WORKER_INTERVAL_<NAME>_MS）。
   * 解析失败的 key 回退默认并告警（worker 侧容错语义保留）。
   */
  intervalOverrides: Record<string, number>;
  /** CR-033 主动智能演进子片 feature flags（默认全关，保留既有行为） */
  proactiveFeatureFlags: ReadonlySet<ProactiveFeatureFlag>;
  /** CR-034 模型路由与降级阶梯开关。 */
  modelRoutingFeatureFlags: ReadonlySet<ModelRoutingFeatureFlag>;
}

/** 拆分逗号/冒号分隔白名单（去空） */
const splitList = (raw: string | undefined, sep: string): string[] =>
  (raw ?? "").split(sep).map((s) => s.trim()).filter((s) => s.length > 0);

/** 启动期校验：数字必须为正整数 */
function requirePositiveInt(name: string, raw: string | undefined, fallback: number, fatal = true): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  if (fatal) throw new Error(`[config] ${name}=${raw} is not a valid positive integer`);
  return fallback;
}

/** 启动期校验：枚举 */
function requireEnum<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = raw?.trim();
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`[config] ${name}=${value} is invalid; expected one of ${allowed.join(" | ")}`);
}

/** 加载 @aervox/api 配置（可注入 env 便于测试；默认读取进程环境变量） */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const defaultLogFormat: LogFormat = env.NODE_ENV === "production" ? "json" : "pretty";
  const gptSovitsProtocol = requireEnum(
    "GPT_SOVITS_PROTOCOL",
    env.GPT_SOVITS_PROTOCOL,
    ["http", "websocket"] as const,
    "http",
  );
  return {
    port: requirePositiveInt("PORT", env.PORT, 3000),
    host: env.AERVOX_API_HOST?.trim() || "127.0.0.1",
    logLevel: requireEnum(
      "AERVOX_LOG_LEVEL",
      env.AERVOX_LOG_LEVEL,
      ["debug", "info", "warn", "error"] as const,
      "info",
    ),
    logFormat: requireEnum(
      "AERVOX_LOG_FORMAT",
      env.AERVOX_LOG_FORMAT,
      ["json", "pretty"] as const,
      defaultLogFormat,
    ),
    loopProvider: requireEnum(
      "AERVOX_LOOP_PROVIDER",
      env.AERVOX_LOOP_PROVIDER,
      ["replay", "scripted", "scripted-write", "scripted-privileged", "scripted-quiz", "llm"] as const,
      "llm",
    ),
    loopDriver: requireEnum("AERVOX_LOOP_DRIVER", env.AERVOX_LOOP_DRIVER, ["native", "dsh"] as const, "native"),
    turnExecution: requireEnum(
      "AERVOX_TURN_EXECUTION",
      env.AERVOX_TURN_EXECUTION,
      ["background", "inline"] as const,
      "background",
    ),
    loopCompaction: requireEnum(
      "AERVOX_LOOP_COMPACTION",
      env.AERVOX_LOOP_COMPACTION,
      ["rule", "off"] as const,
      "off",
    ),
    adminIds: splitList(env.AERVOX_ADMIN_IDS, ","),
    gptSovits: {
      modelPath: env.GPT_SOVITS_MODEL_PATH?.trim() || undefined,
      allowedRoots: splitList(env.GPT_SOVITS_ALLOWED_ROOTS, ":"),
      endpoint: env.GPT_SOVITS_ENDPOINT?.trim() || undefined,
      protocol: gptSovitsProtocol,
      modelId: env.GPT_SOVITS_MODEL_ID?.trim() || "default-remote",
      secretRef: env.GPT_SOVITS_SECRET_REF?.trim() || undefined,
    },
    asr: {
      senseVoiceBaseUrl:
        env.SENSEVOICE_MODEL_BASE_URL?.trim() ||
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
      senseVoiceModelPath: env.SENSEVOICE_MODEL_PATH?.trim() || undefined,
      senseVoiceAllowedRoots: splitList(env.SENSEVOICE_ALLOWED_ROOTS, ":"),
      whisperEndpoint: env.WHISPER_ENDPOINT?.trim() || undefined,
      whisperApiKey: env.WHISPER_API_KEY?.trim() || undefined,
      whisperModelId: env.WHISPER_MODEL_ID?.trim() || "whisper-1",
    },
    proactiveFeatureFlags: loadProactiveFeatureFlags(env),
    modelRoutingFeatureFlags: loadModelRoutingFeatureFlags(env),
  };
}

/** 加载 @aervox/worker 配置（可注入 env 便于测试；默认读取进程环境变量） */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const defaultLogFormat: LogFormat = env.NODE_ENV === "production" ? "json" : "pretty";
  const tickMs = requirePositiveInt("WORKER_TICK_MS", env.WORKER_TICK_MS, 5000);
  const intervalOverrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^WORKER_INTERVAL_([A-Z0-9_-]+)_MS$/.exec(key);
    if (!match) continue;
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      intervalOverrides[match[1]!.toLowerCase()] = parsed;
    } else {
      // worker 既有语义：非法覆盖值回退默认并告警（不阻断启动）
      console.warn(`[config] invalid ${key}=${value}; fallback to WORKER_TICK_MS=${tickMs}`);
    }
  }
  return {
    workerId: env.WORKER_ID?.trim() || `worker_${Date.now().toString(36)}`,
    tickMs,
    logLevel: requireEnum(
      "AERVOX_LOG_LEVEL",
      env.AERVOX_LOG_LEVEL,
      ["debug", "info", "warn", "error"] as const,
      "info",
    ),
    logFormat: requireEnum(
      "AERVOX_LOG_FORMAT",
      env.AERVOX_LOG_FORMAT,
      ["json", "pretty"] as const,
      defaultLogFormat,
    ),
    intervalOverrides,
    proactiveFeatureFlags: loadProactiveFeatureFlags(env),
    modelRoutingFeatureFlags: loadModelRoutingFeatureFlags(env),
  };
}
