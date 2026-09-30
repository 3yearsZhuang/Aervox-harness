#!/usr/bin/env node
/**
 * Aervox｜思隅 — Worker × 多进程 SQLite 写竞争演练（ITER-027 验收证据 / 手动运行）
 *
 * ## 为什么存在
 *
 * ITER-027 的两条验收标准——"密集对话与流式写入期间 Worker 自动退避至 3s+ 低频轮询、
 * 写锁冲突率降至 0"与"长周期运行与压测下无 SQLITE_BUSY 报错与 P99 延迟抖动"——此前只有
 * **单进程顺序循环**的"并发"测试支撑，无法证明**跨进程**写竞争下的真实行为。本演练用真实
 * 的多个 OS 进程同时争抢同一个 SQLite 文件，测量真实数字，并如实报告（含负面结果）。
 *
 * ## 如何运行（必须先构建，否则直接失败并提示）
 *
 * ```bash
 * mise exec -- pnpm --filter @aervox/repositories build
 * mise exec -- pnpm --filter @aervox/worker build
 * mise exec -- pnpm --filter @aervox/api build
 * mise exec -- node scripts/worker-write-contention-drill.mjs --label=low-contention  --writers=2 --pace-ms=40
 * mise exec -- node scripts/worker-write-contention-drill.mjs --label=high-contention --writers=3 --pace-ms=0
 * ```
 *
 * 根脚本入口：`pnpm drill:worker-contention`（等价于 `node scripts/worker-write-contention-drill.mjs`）。
 * 注意：本仓库要求的 Node 版本由 mise.toml 固定（Node 24），请用 `mise exec --` 或 `./aervox` 运行。
 *
 * ### 全部参数
 *
 * | 参数 | 默认值 | 含义 |
 * | --- | --- | --- |
 * | `--label=<name>` | `run` | 摘要里的运行标签 |
 * | `--duration-ms=<n>` | `15000` | 写入窗口时长（从 GO 发令开始计，不含子进程启动） |
 * | `--drain-ms=<n>` | `15000` | 写入停止后留给 Worker 清空 Outbox 的时长 |
 * | `--writers=<n>` | `2` | api-writer 进程数（1..4）；第 3 个及以后额外插入 Outbox 事件 |
 * | `--pace-ms=<n>` | `0` | 每个写入者两轮之间的间隔（模拟用户打字节奏） |
 * | `--busy-timeout-ms=<n>` | `5000` | 传给 `createDatabase` 的 `PRAGMA busy_timeout`（线上默认值） |
 * | `--retry-attempts=<n>` | `5` | `withBusyRetry` 尝试次数（线上默认值） |
 * | `--max-consecutive-busy=<n>` | `25` | 连续逃逸 busy 达到该值即判定写入停滞并中止（0 = 关闭） |
 * | `--linger-after-poison-ms=<n>` | `0` | 命中连接污染后**停止写入但延迟退出**的时长，用于测量被遗弃事务的拖累范围 |
 * | `--wakeup-every=<n>` | `1` | 每 N 轮发送一次 `notifyWorkerWakeup("outbox")` |
 * | `--json=<path>` | 无 | 额外把摘要写入该文件 |
 * | `--verbose` | 关 | 子进程 stdout/stderr 直接打到终端（默认为 `<runDir>/<role>.log`） |
 * | `--keep` | 关 | 保留临时运行目录并打印路径（便于查看日志/数据库） |
 *
 * 环境变量：`--writers` 等不会写入持久状态；脚本只在**自己创建的临时目录**里建库，
 * 并强制 `AERVOX_WORKER_IPC_SOCKET` 指向临时 socket，因此不会与开发机上真实运行的
 * API/Worker 互相干扰。
 *
 * ## 它证明什么
 *
 * - 在**真实多进程**竞争下，写入路径是否出现逃逸的 `SQLITE_BUSY` 与连接污染（poisoned）；
 * - API 侧压力租约（`apps/api/dist/shared/worker-pressure-lease.js`，与线上同一份实现）是否
 *   真的让真实 `WorkerHost` 进入压力模式，并把真实 outbox 轮询间隔拉长到 3s 以上
 *   （同时读 `host.isPressureMode()` 与真实相邻轮询间隔）；
 * - 竞争是否造成写入延迟长尾（p50/p95/p99）与数据完整性问题（应有行数 vs 实际行数、
 *   Outbox 是否清空、是否产生 dead_letter）。
 *
 * ## 它不证明什么（明确边界，避免过度解读）
 *
 * - 不覆盖 API HTTP 层、SSE 流式响应与 Agent Loop 长回合的真实耗时。api-writer 只复刻
 *   "建 Turn + 伴随写 Outbox + 更新 Turn 状态 + IPC 唤醒"这一**写路径**，不含 LLM/工具执行。
 * - 不覆盖真实客户端并发模型（多标签页/多会话/多设备）与磁盘 I/O 抖动。单一开发机上的
 *   文件系统缓存会显著弱化竞争，因此这里测到的冲突率是**下界**，不是上限。
 * - 不覆盖进程**启动期**的 Schema DDL 竞争：Schema 由编排器与 Worker 在写入者启动之前
 *   初始化完成，因此 `api-writer` 的统计只反映稳态写入路径的竞争，不含建表/加列的争抢。
 * - 只统计**逃出** `withBusyRetry`（默认 5 次指数退避）与连接自愈层的错误。被重试或自愈
 *   吸收的锁冲突不出现在 `sqliteBusyErrors` 中，只体现为延迟抬高——对比
 *   `--busy-timeout-ms=0` 的运行即可看出"被吸收的冲突"有多频繁。
 * - 不是 CI 门禁：整轮耗时数十秒且结果受机器负载影响，必须手动运行；**默认不接入 CI**。
 *
 * ## 已知 libsql 危险状态（见 packages/repositories/src/write-retry.ts 头注）
 *
 * libsql@0.4.x 在事务 `BEGIN` 阶段遭遇写锁竞争而失败后会残留语句状态：同一连接后续 `commit`
 * 报 `SQL statements in progress`，且被遗弃的事务会持续持有写锁，使**同进程其它连接乃至另一个
 * 进程**的写入都以 `database is locked` 失败，直到该连接被关闭或进程退出。
 * 这正是"多进程压测"必须单独演练的原因：单进程测试根本碰不到它。
 * 本演练把该状态视为**终止态**：命中时角色进程立刻停止写入、把 `aborted`/`abortReason` 写进
 * 自身报告并以非零码退出；编排器据此把整轮标记为**不干净**并打印原因，绝不把这种运行当成通过。
 *
 * ## 角色与实现方式
 *
 * 单个文件、零新增依赖：脚本用 `--role=` 重新执行自身。
 * - `orchestrator`（默认）：建临时目录 + SQLite 文件 + Schema，拉起子进程，持有真实压力租约，
 *   写 STOP 哨兵，收集子进程报告并做最终一致性校验，最后打印 JSON 摘要。
 * - `api-writer`：真实 `SqliteConversationRepository.createTurnWithOutbox` + `updateTurnStatus`
 *   （+ 第三个写入者额外 `SqliteOutboxRepository.insertEvent`）+ `notifyWorkerWakeup`。
 * - `worker`：真实 `WorkerHost` + 真实 `outbox` 任务（真实 `runOutboxCycle`）+
 *   真实 `enableIpc`，采样 `isPressureMode()` 与真实轮询间隔。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

const REPOSITORIES_DIST = path.join(REPO_ROOT, "packages/repositories/dist/index.js");
const WORKER_HOST_DIST = path.join(REPO_ROOT, "apps/worker/dist/worker-host.js");
const OUTBOX_WORKER_DIST = path.join(REPO_ROOT, "apps/worker/dist/outbox-worker.js");
const PRESSURE_LEASE_DIST = path.join(REPO_ROOT, "apps/api/dist/shared/worker-pressure-lease.js");

/** 写入事件类型与 ID 前缀刻意与线上 API 一致（apps/api/.../conversation/routes.ts） */
const OUTBOX_EVENT_TYPE = "turn.created";
const TURN_ID_PREFIX = "drill_t_";
const MESSAGE_ID_PREFIX = "drill_m_";

const LOCAL_CTX = { workspaceId: "local", subjectUserId: "local" };

// ─────────────────────────────────────────────────────────────────────────────
// 通用工具
// ─────────────────────────────────────────────────────────────────────────────

/** 极简 `--flag` / `--flag=value` / `--flag value` 解析（零依赖） */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[token.slice(2)] = "true";
    } else {
      flags[token.slice(2)] = next;
      i += 1;
    }
  }
  return flags;
}

function flagNumber(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} 需要数字，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

function flagBoolean(flags, name, fallback = false) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  return raw !== "false" && raw !== "0";
}

function log(message) {
  process.stderr.write(`[drill] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 线性插值分位数（输入为升序数组） */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return round(sortedAsc[0]);
  const index = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sortedAsc[lower]);
  const interpolated =
    sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (index - lower);
  return round(interpolated);
}

function latencyStats(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, item) => acc + item, 0);
  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(sum / sorted.length),
  };
}

const HISTOGRAM_BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function latencyHistogram(values) {
  const buckets = new Array(HISTOGRAM_BOUNDS.length + 1).fill(0);
  for (const value of values) {
    let placed = false;
    for (let i = 0; i < HISTOGRAM_BOUNDS.length; i += 1) {
      if (value <= HISTOGRAM_BOUNDS[i]) {
        buckets[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) buckets[HISTOGRAM_BOUNDS.length] += 1;
  }
  const labels = [
    ...HISTOGRAM_BOUNDS.map((bound, i) =>
      i === 0 ? `0-${bound}ms` : `${HISTOGRAM_BOUNDS[i - 1]}-${bound}ms`,
    ),
    `>${HISTOGRAM_BOUNDS[HISTOGRAM_BOUNDS.length - 1]}ms`,
  ];
  return labels.map((label, i) => ({ bucket: label, count: buckets[i] })).filter((entry) => entry.count > 0);
}

function hashFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/** 从 `startDir` 逐级向上查找**带 version 字段**的 package.json（跳过 `{"type":"commonjs"}` 之类的占位文件） */
function findPackageVersion(startDir, name) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          if (pkg.name === undefined || pkg.name === name) return pkg.version;
        }
      } catch {
        /* 占位/损坏的 package.json：继续向上找 */
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** 解析某个包的版本号（从 `fromDir` 出发，经 node_modules 解析入口后向上找真实 package.json） */
function resolvePackageVersion(fromDir, name) {
  try {
    const require = createRequire(path.join(fromDir, "noop.js"));
    return findPackageVersion(path.dirname(require.resolve(name)), name);
  } catch {
    /* 版本探测失败不阻断演练 */
  }
  return null;
}

/** 解析"某个包的依赖"的版本号（如 @libsql/client 下的 libsql，pnpm 严格布局下从仓库根不可直接解析） */
function resolveNestedPackageVersion(fromDir, baseName, nestedName) {
  try {
    const require = createRequire(path.join(fromDir, "noop.js"));
    const baseDir = path.dirname(require.resolve(baseName));
    const nestedRequire = createRequire(path.join(baseDir, "noop.js"));
    return findPackageVersion(path.dirname(nestedRequire.resolve(nestedName)), nestedName);
  } catch {
    /* 版本探测失败不阻断演练 */
  }
  return null;
}

function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const porcelain = run(["status", "--porcelain"]);
  return {
    head: run(["rev-parse", "HEAD"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: porcelain === null ? null : porcelain.length > 0,
    dirtyFiles: porcelain === null ? null : porcelain.split("\n").filter(Boolean),
  };
}

function environmentInfo() {
  const repositoriesDir = path.join(REPO_ROOT, "packages/repositories");
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemoryGb: round(os.totalmem() / 1024 ** 3, 2),
    node: process.version,
    nodeExecutable: process.execPath,
    libsql: resolveNestedPackageVersion(repositoriesDir, "@libsql/client", "libsql"),
    libsqlClient: resolvePackageVersion(repositoriesDir, "@libsql/client"),
    drizzleOrm: resolvePackageVersion(repositoriesDir, "drizzle-orm"),
  };
}

function distFingerprint() {
  return {
    repositoriesIndex: hashFile(REPOSITORIES_DIST),
    repositoriesClient: hashFile(path.join(REPO_ROOT, "packages/repositories/dist/client.js")),
    repositoriesWriteRetry: hashFile(path.join(REPO_ROOT, "packages/repositories/dist/write-retry.js")),
    repositoriesWorkerIpc: hashFile(path.join(REPO_ROOT, "packages/repositories/dist/worker-ipc.js")),
    workerHost: hashFile(WORKER_HOST_DIST),
    outboxWorker: hashFile(OUTBOX_WORKER_DIST),
    pressureLease: hashFile(PRESSURE_LEASE_DIST),
  };
}

/**
 * 构建产物前置检查：本演练**只**使用已构建的 dist（与线上运行路径一致），不做 TS 转译。
 * 缺失时给出明确的构建命令，而不是抛出难以理解的模块解析错误。
 */
function requireBuiltArtifacts({ requirePressureLease }) {
  const required = [
    [REPOSITORIES_DIST, "@aervox/repositories"],
    [WORKER_HOST_DIST, "@aervox/worker (worker-host)"],
    [OUTBOX_WORKER_DIST, "@aervox/worker (outbox-worker)"],
  ];
  const missing = required.filter(([file]) => !fs.existsSync(file));
  if (missing.length > 0) {
    const lines = missing.map(([file, label]) => `  - ${label}: ${path.relative(REPO_ROOT, file)}`);
    throw new Error(
      `缺少构建产物，无法运行演练（本演练只用 dist，与线上路径一致）：\n${lines.join("\n")}\n` +
        `请先构建：\n` +
        `  mise exec -- pnpm --filter @aervox/repositories build\n` +
        `  mise exec -- pnpm --filter @aervox/worker build\n` +
        `  mise exec -- pnpm --filter @aervox/api build`,
    );
  }
  const pressureLeaseAvailable = fs.existsSync(PRESSURE_LEASE_DIST);
  if (requirePressureLease && !pressureLeaseAvailable) {
    log(
      `未找到 ${path.relative(REPO_ROOT, PRESSURE_LEASE_DIST)}；` +
        `将退化为等价的手工 pressure(true,TTL)/续期/pressure(false) 序列。`,
    );
  }
  return pressureLeaseAvailable;
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置解析
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_DEFAULTS = {
  durationMs: 15_000,
  drainMs: 15_000,
  writers: 2,
  paceMs: 0,
  busyTimeoutMs: 5_000,
  retryAttempts: 5,
  maxConsecutiveBusy: 25,
  wakeupEvery: 1,
  lingerAfterPoisonMs: 0,
};

function orchestratorConfig(flags) {
  const writers = Math.trunc(flagNumber(flags, "writers", ROLE_DEFAULTS.writers));
  if (writers < 1 || writers > 4) {
    throw new Error(`--writers 必须在 1..4 之间，收到 ${writers}`);
  }
  return {
    label: flags.label ?? "run",
    role: "orchestrator",
    durationMs: Math.trunc(flagNumber(flags, "duration-ms", ROLE_DEFAULTS.durationMs)),
    drainMs: Math.trunc(flagNumber(flags, "drain-ms", ROLE_DEFAULTS.drainMs)),
    writers,
    paceMs: Math.trunc(flagNumber(flags, "pace-ms", ROLE_DEFAULTS.paceMs)),
    busyTimeoutMs: Math.trunc(flagNumber(flags, "busy-timeout-ms", ROLE_DEFAULTS.busyTimeoutMs)),
    retryAttempts: Math.trunc(flagNumber(flags, "retry-attempts", ROLE_DEFAULTS.retryAttempts)),
    maxConsecutiveBusy: Math.trunc(
      flagNumber(flags, "max-consecutive-busy", ROLE_DEFAULTS.maxConsecutiveBusy),
    ),
    wakeupEvery: Math.trunc(flagNumber(flags, "wakeup-every", ROLE_DEFAULTS.wakeupEvery)),
    lingerAfterPoisonMs: Math.trunc(
      flagNumber(flags, "linger-after-poison-ms", ROLE_DEFAULTS.lingerAfterPoisonMs),
    ),
    verbose: flagBoolean(flags, "verbose", false),
    keep: flagBoolean(flags, "keep", false),
    jsonPath: flags.json ? path.resolve(process.cwd(), flags.json) : null,
  };
}

function roleConfig(flags) {
  const role = flags.role;
  const dbPath = flags.db;
  const runDir = flags["run-dir"];
  if (!dbPath || !runDir) {
    throw new Error(`--role=${role} 需要 --db 与 --run-dir（由 orchestrator 传入）`);
  }
  return {
    role,
    index: Math.trunc(flagNumber(flags, "index", 0)),
    dbPath,
    runDir,
    socketPath: flags.socket ?? process.env.AERVOX_WORKER_IPC_SOCKET ?? null,
    durationMs: Math.trunc(flagNumber(flags, "duration-ms", ROLE_DEFAULTS.durationMs)),
    drainMs: Math.trunc(flagNumber(flags, "drain-ms", ROLE_DEFAULTS.drainMs)),
    paceMs: Math.trunc(flagNumber(flags, "pace-ms", ROLE_DEFAULTS.paceMs)),
    busyTimeoutMs: Math.trunc(flagNumber(flags, "busy-timeout-ms", ROLE_DEFAULTS.busyTimeoutMs)),
    retryAttempts: Math.trunc(flagNumber(flags, "retry-attempts", ROLE_DEFAULTS.retryAttempts)),
    maxConsecutiveBusy: Math.trunc(
      flagNumber(flags, "max-consecutive-busy", ROLE_DEFAULTS.maxConsecutiveBusy),
    ),
    wakeupEvery: Math.trunc(flagNumber(flags, "wakeup-every", ROLE_DEFAULTS.wakeupEvery)),
    lingerAfterPoisonMs: Math.trunc(
      flagNumber(flags, "linger-after-poison-ms", ROLE_DEFAULTS.lingerAfterPoisonMs),
    ),
    runToken: flags["run-token"] ?? "run",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 子进程报告
// ─────────────────────────────────────────────────────────────────────────────

function writeReportSync(runDir, fileName, payload) {
  const target = path.join(runDir, fileName);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
  fs.renameSync(temp, target);
}

function readReportSync(runDir, fileName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, fileName), "utf8"));
  } catch {
    return null;
  }
}

function sentinelExists(runDir, name) {
  return fs.existsSync(path.join(runDir, name));
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误分类（必须复用真实判定，不重新实现）
// ─────────────────────────────────────────────────────────────────────────────

function createErrorTally(classify) {
  const tally = {
    sqliteBusyErrors: 0,
    poisonedErrors: 0,
    otherErrors: 0,
    consecutiveBusy: 0,
    maxConsecutiveBusyObserved: 0,
    samples: [],
  };
  const record = (kind, error) => {
    const message = messageOf(error);
    if (tally.samples.length < 8) {
      tally.samples.push({ kind, message: message.slice(0, 400) });
    }
  };
  return {
    tally,
    /** 返回 'busy' | 'poisoned' | 'other' */
    count(error) {
      if (classify.isPoisoned(error)) {
        tally.poisonedErrors += 1;
        tally.consecutiveBusy = 0;
        record("poisoned", error);
        return "poisoned";
      }
      if (classify.isBusy(error)) {
        tally.sqliteBusyErrors += 1;
        tally.consecutiveBusy += 1;
        tally.maxConsecutiveBusyObserved = Math.max(
          tally.maxConsecutiveBusyObserved,
          tally.consecutiveBusy,
        );
        record("busy", error);
        return "busy";
      }
      tally.otherErrors += 1;
      tally.consecutiveBusy = 0;
      record("other", error);
      return "other";
    },
    resetStreak() {
      tally.consecutiveBusy = 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 角色：api-writer（HTTP 写路径的多进程复刻）
// ─────────────────────────────────────────────────────────────────────────────

async function runApiWriter(flags) {
  const cfg = roleConfig(flags);
  const repos = await import(pathToFileURL(REPOSITORIES_DIST).href);
  const {
    createDatabase,
    SqliteConversationRepository,
    SqliteOutboxRepository,
    isSqliteBusyError,
    isSqliteConnectionPoisonedError,
    notifyWorkerWakeup,
  } = repos;

  const tally = createErrorTally({
    isBusy: isSqliteBusyError,
    isPoisoned: isSqliteConnectionPoisonedError,
  });

  const startedAt = Date.now();
  const report = {
    role: "api-writer",
    index: cfg.index,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    dbPath: cfg.dbPath,
    config: {
      durationMs: cfg.durationMs,
      paceMs: cfg.paceMs,
      busyTimeoutMs: cfg.busyTimeoutMs,
      retryAttempts: cfg.retryAttempts,
      maxConsecutiveBusy: cfg.maxConsecutiveBusy,
      wakeupEvery: cfg.wakeupEvery,
      lingerAfterPoisonMs: cfg.lingerAfterPoisonMs,
    },
    bootMs: null,
    goEpochMs: null,
    goReceivedAfterMs: null,
    finishReason: null,
    aborted: false,
    abortReason: null,
    abortedAtEpochMs: null,
    rounds: 0,
    turnsCreated: 0,
    statusUpdatesApplied: 0,
    extraOutboxInserts: 0,
    writes: { attempted: 0, succeeded: 0, failed: 0, byOp: {} },
    errors: tally.tally,
    latencyMs: null,
    failedLatencyMs: null,
    latencyHistogram: null,
    latencyByOpMs: {},
    wakeups: { attempted: 0, delivered: 0 },
    /** client.ts 的 ReconnectableClient 连接自愈次数（若本轮发生 BEGIN 竞争，这里会 >0） */
    reconnects: null,
    activeMs: 0,
    exitCode: 0,
  };

  const bumpOp = (op, field) => {
    report.writes.byOp[op] = report.writes.byOp[op] ?? { attempted: 0, succeeded: 0, failed: 0 };
    report.writes.byOp[op][field] += 1;
  };

  /** 全部写尝试的时间线：[epochMs, 耗时ms, 操作名, 是否成功]，用于跨进程精确合并与"中毒窗口"分析 */
  const timeline = [];
  const okLatencies = [];
  const failedLatencies = [];
  const okByOp = new Map();

  let dbHandle = null;
  let finished = false;

  const finish = (finishReason, exitCode) => {
    if (finished) return;
    finished = true;
    clearInterval(stopWatcher);
    report.finishReason = finishReason;
    report.exitCode = exitCode;
    report.activeMs = report.goEpochMs === null ? 0 : Date.now() - report.goEpochMs;
    try {
      report.reconnects = dbHandle?.reconnectCount?.() ?? null;
    } catch {
      report.reconnects = null;
    }
    report.latencyMs = latencyStats(okLatencies);
    report.failedLatencyMs = latencyStats(failedLatencies);
    report.latencyHistogram = latencyHistogram(okLatencies);
    for (const [op, values] of okByOp.entries()) {
      report.latencyByOpMs[op] = latencyStats(values);
    }
    try {
      writeReportSync(cfg.runDir, `report-api-writer-${cfg.index}.json`, report);
      // 原始样本单独落盘：报告里的分位数只对本进程有效，跨进程合并与窗口分析需要原始样本。
      writeReportSync(cfg.runDir, `timeline-api-writer-${cfg.index}.json`, { timeline });
    } catch {
      /* 报告写入失败不改变退出码语义 */
    }
    try {
      dbHandle?.client?.close?.();
    } catch {
      /* 关闭失败无碍退出 */
    }
    process.exit(exitCode);
  };

  let stopRequested = false;
  const stopWatcher = setInterval(() => {
    if (sentinelExists(cfg.runDir, "STOP_WRITERS")) stopRequested = true;
  }, 25);
  stopWatcher.unref?.();

  process.on("uncaughtException", (error) => {
    report.aborted = true;
    report.abortReason = `uncaught_exception: ${messageOf(error)}`;
    finish("uncaught_exception", 5);
  });
  process.on("unhandledRejection", (error) => {
    report.aborted = true;
    report.abortReason = `unhandled_rejection: ${messageOf(error)}`;
    finish("unhandled_rejection", 5);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => finish(`signal_${signal}`, 6));
  }

  dbHandle = await createDatabase({
    url: `file:${cfg.dbPath}`,
    busyTimeoutMs: cfg.busyTimeoutMs,
    busyRetry: { attempts: cfg.retryAttempts },
  });

  const conversationRepo = new SqliteConversationRepository(dbHandle.db);
  const outboxRepo = new SqliteOutboxRepository(dbHandle.db);

  const measure = async (op, operation) => {
    report.writes.attempted += 1;
    bumpOp(op, "attempted");
    const wallStart = Date.now();
    const started = performance.now();
    try {
      const value = await operation();
      const ms = performance.now() - started;
      timeline.push([wallStart, round(ms), op, 1]);
      okLatencies.push(ms);
      if (!okByOp.has(op)) okByOp.set(op, []);
      okByOp.get(op).push(ms);
      report.writes.succeeded += 1;
      bumpOp(op, "succeeded");
      tally.resetStreak();
      return { ok: true, value };
    } catch (error) {
      const ms = performance.now() - started;
      timeline.push([wallStart, round(ms), op, 0]);
      failedLatencies.push(ms);
      report.writes.failed += 1;
      bumpOp(op, "failed");
      const kind = tally.count(error);
      return { ok: false, kind, error };
    }
  };

  // ── 就绪握手：等 GO 再开始计时。子进程启动（加载整个 @aervox/repositories dist 模块图）
  // 需要数秒，若不等握手，编排器计时的"写入窗口"会把启动时间算进去（实测 4s 窗口里只有
  // 0.7s 在真正写），既浪费又会让窗口与实际写入期错位。
  report.bootMs = Date.now() - startedAt;
  fs.writeFileSync(path.join(cfg.runDir, `writer-ready-${cfg.index}`), String(Date.now()));
  const goDeadline = Date.now() + 60_000;
  while (!sentinelExists(cfg.runDir, "GO") && Date.now() < goDeadline && !stopRequested) {
    await sleep(10);
  }
  if (!sentinelExists(cfg.runDir, "GO")) {
    report.abortReason = stopRequested ? "stopped_before_go" : "go_sentinel_timeout";
    finish(report.abortReason, 7);
    return;
  }
  report.goEpochMs = Date.now();
  report.goReceivedAfterMs = report.goEpochMs - startedAt;
  const startedWritingAt = report.goEpochMs;

  const deadline = startedWritingAt + cfg.durationMs;
  let roundNo = 0;

  try {
    while (Date.now() < deadline && !stopRequested) {
      roundNo += 1;
      report.rounds = roundNo;
      const runToken = cfg.runToken;
      const turnId = `${TURN_ID_PREFIX}${cfg.index}_${runToken}_${roundNo}`;
      const messageId = `${MESSAGE_ID_PREFIX}${cfg.index}_${runToken}_${roundNo}`;

      // 1) 真实原子写：Turn + 首条消息 + Outbox 事件（同一事务）
      const created = await measure("createTurnWithOutbox", () =>
        conversationRepo.createTurnWithOutbox(
          LOCAL_CTX,
          {
            id: turnId,
            sessionId: "ses_drill_shared",
            idempotencyKey: `drill_idem_${cfg.index}_${runToken}_${roundNo}`,
            status: "Created",
          },
          { id: messageId, content: `drill round ${roundNo} from writer ${cfg.index}` },
          {
            id: `outbox_${turnId}`,
            eventType: OUTBOX_EVENT_TYPE,
            idempotencyKey: `idem_outbox_${turnId}`,
            payload: { turnId, sessionId: "ses_drill_shared" },
          },
        ),
      );
      if (created.ok) report.turnsCreated += 1;

      // 2) 真实状态更新（线上 API 对状态更新失败是容错的：catch(() => undefined)）
      if (created.ok) {
        const updated = await measure("updateTurnStatus", () =>
          conversationRepo.updateTurnStatus(LOCAL_CTX, turnId, "Completed", 1),
        );
        if (updated.ok) report.statusUpdatesApplied += 1;
      }

      // 3) 第三个写入者额外插入 Outbox 事件，进一步抬高写竞争
      if (cfg.index >= 2) {
        const extraId = `outbox_extra_${cfg.index}_${runToken}_${roundNo}`;
        const inserted = await measure("insertEvent", () =>
          outboxRepo.insertEvent(LOCAL_CTX, {
            id: extraId,
            idempotencyKey: `idem_${extraId}`,
            eventType: OUTBOX_EVENT_TYPE,
            payload: { turnId, sessionId: "ses_drill_shared", source: "extra-writer" },
          }),
        );
        if (inserted.ok) report.extraOutboxInserts += 1;
      }

      // 4) IPC 秒级唤醒（线上 API 在 Outbox 落库后即唤醒 Worker）
      if (roundNo % Math.max(1, cfg.wakeupEvery) === 0) {
        report.wakeups.attempted += 1;
        const delivered = await notifyWorkerWakeup("outbox", cfg.socketPath ?? undefined);
        if (delivered) report.wakeups.delivered += 1;
      }

      // 5) 终止态：连接已污染 → 立刻**停止写入**（继续写只会拖住整库）。
      // `--linger-after-poison-ms` 可让该进程在停止写入后存活一段时间，用于测量"被遗弃事务
      // 是否真的会拖住其它进程"（默认 0 = 立即退出，尽快把写锁还给其它进程）。
      if (tally.tally.poisonedErrors > 0) {
        report.aborted = true;
        report.abortedAtEpochMs = Date.now();
        report.abortReason =
          `connection_poisoned after ${tally.tally.poisonedErrors} error(s): ` +
          `${tally.tally.samples.find((s) => s.kind === "poisoned")?.message ?? "unknown"}`;
        if (cfg.lingerAfterPoisonMs > 0) {
          report.poisonLingerMs = cfg.lingerAfterPoisonMs;
          await sleep(cfg.lingerAfterPoisonMs);
        }
        finish("connection_poisoned", 3);
        return;
      }

      // 6) 持续逃逸的 busy：说明当前 busy_timeout/重试完全无法吸收竞争，视为写入停滞
      if (
        cfg.maxConsecutiveBusy > 0 &&
        tally.tally.consecutiveBusy >= cfg.maxConsecutiveBusy
      ) {
        report.aborted = true;
        report.abortedAtEpochMs = Date.now();
        report.abortReason =
          `sustained_busy: ${tally.tally.consecutiveBusy} consecutive writes failed with ` +
          `SQLITE_BUSY (busyTimeoutMs=${cfg.busyTimeoutMs}, retryAttempts=${cfg.retryAttempts})`;
        finish("sustained_busy", 4);
        return;
      }

      if (cfg.paceMs > 0) await sleep(cfg.paceMs);
    }

    finish(stopRequested ? "stop_sentinel" : "duration_elapsed", 0);
  } catch (error) {
    report.aborted = true;
    report.abortReason = `writer_loop_error: ${messageOf(error)}`;
    finish("writer_loop_error", 5);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 角色：worker（真实 WorkerHost + 真实 outbox 任务 + 真实 IPC）
// ─────────────────────────────────────────────────────────────────────────────

/** 只记录不输出的日志器：满足 LoggerPort 形状，供 WorkerHost 使用（带时间戳便于与轮询时间线对齐） */
function createRecordingLogger(sink) {
  const make = (fields) => ({
    debug: (entry) => sink.push({ t: Date.now(), level: "debug", ...fields, ...entry }),
    info: (entry) => sink.push({ t: Date.now(), level: "info", ...fields, ...entry }),
    warn: (entry) => sink.push({ t: Date.now(), level: "warn", ...fields, ...entry }),
    error: (entry) => sink.push({ t: Date.now(), level: "error", ...fields, ...entry }),
    child: (childFields) => make({ ...fields, ...childFields }),
  });
  return make({});
}

async function runWorker(flags) {
  const cfg = roleConfig(flags);
  const repos = await import(pathToFileURL(REPOSITORIES_DIST).href);
  const {
    createDatabase,
    initDatabaseSchema,
    SqliteOutboxRepository,
    SqlitePlatformRepository,
    isSqliteBusyError,
    isSqliteConnectionPoisonedError,
    sendWorkerIpcMessage,
  } = repos;
  const { WorkerHost } = await import(pathToFileURL(WORKER_HOST_DIST).href);
  const { runOutboxCycle } = await import(pathToFileURL(OUTBOX_WORKER_DIST).href);

  const tally = createErrorTally({
    isBusy: isSqliteBusyError,
    isPoisoned: isSqliteConnectionPoisonedError,
  });

  const startedAt = Date.now();
  const report = {
    role: "worker",
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    dbPath: cfg.dbPath,
    config: {
      outboxIntervalMs: 3_000,
      enableIpc: true,
      socketPath: cfg.socketPath,
      busyTimeoutMs: cfg.busyTimeoutMs,
      retryAttempts: cfg.retryAttempts,
    },
    readyAfterMs: null,
    finishReason: null,
    aborted: false,
    abortReason: null,
    exitCode: 0,
    cycles: 0,
    eventsProcessed: 0,
    errors: tally.tally,
    pressure: {
      engaged: false,
      activeSamples: 0,
      totalSamples: 0,
      modeEvents: [],
    },
    pollIntervals: null,
    scheduledIntervalSamplesMs: [],
    currentIntervalSamplesMs: [],
    logCounts: {},
    logSamples: [],
    pendingAtWorkerExit: null,
    outboxStatusAtWorkerExit: null,
    activeMs: 0,
  };

  const logSink = [];
  const logger = createRecordingLogger(logSink);
  const workerId = `drill-worker-${process.pid}`;
  const cycles = [];
  let finished = false;
  let dbHandle = null;

  const summariseLogs = () => {
    const counts = {};
    const samples = [];
    for (const entry of logSink) {
      counts[entry.event] = (counts[entry.event] ?? 0) + 1;
      if (
        samples.length < 40 &&
        (entry.event === "worker.pressure_mode.entered" ||
          entry.event === "worker.pressure_mode.exited" ||
          entry.event === "worker.task.busy_conflict" ||
          entry.event === "worker.task.failed" ||
          entry.event === "worker.pressure_mode.ineffective")
      ) {
        samples.push({
          event: entry.event,
          message: entry.message,
          fields: entry.fields ?? null,
        });
      }
    }
    return { counts, samples };
  };

  const finish = (finishReason, exitCode) => {
    if (finished) return;
    finished = true;
    clearInterval(stopWatcher);
    report.finishReason = finishReason;
    report.exitCode = exitCode;
    report.activeMs = Date.now() - startedAt;
    const logs = summariseLogs();
    report.logCounts = logs.counts;
    report.logSamples = logs.samples;
    try {
      writeReportSync(cfg.runDir, "report-worker.json", report);
    } catch {
      /* 见上 */
    }
    try {
      dbHandle?.client?.close?.();
    } catch {
      /* 见上 */
    }
    process.exit(exitCode);
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => finish(`signal_${signal}`, 6));
  }

  dbHandle = await createDatabase({
    url: `file:${cfg.dbPath}`,
    busyTimeoutMs: cfg.busyTimeoutMs,
    busyRetry: { attempts: cfg.retryAttempts },
  });
  await initDatabaseSchema(dbHandle.client);

  const outboxRepo = new SqliteOutboxRepository(dbHandle.db);
  const platformRepo = new SqlitePlatformRepository(dbHandle.db);

  const host = new WorkerHost({
    workerId,
    logger,
    enableIpc: true,
    ipcSocketPath: cfg.socketPath ?? undefined,
  });

  host.registerJob({
    name: "outbox",
    run: async () => {
      const start = Date.now();
      try {
        const processed = await runOutboxCycle({ outboxRepo, platformRepo, workerId });
        cycles.push({ startMs: start, endMs: Date.now(), processed });
        report.cycles += 1;
        report.eventsProcessed += processed;
        return processed;
      } catch (error) {
        // 分类后**原样抛出**：让 WorkerHost 的真实 busy 处理（setPressureMode(true, 5000)）生效。
        const kind = tally.count(error);
        cycles.push({
          startMs: start,
          endMs: Date.now(),
          processed: 0,
          errorKind: kind,
          error: messageOf(error).slice(0, 300),
        });
        report.cycles += 1;
        throw error;
      }
    },
  });

  host.start();

  // 等待自身 IPC 服务就绪（回环 ping），再通知编排器可以放写入者进来了。
  const ipcReadyDeadline = Date.now() + 10_000;
  let ipcReady = false;
  while (Date.now() < ipcReadyDeadline && !ipcReady) {
    ipcReady = await sendWorkerIpcMessage(
      { action: "ping" },
      { socketPath: cfg.socketPath ?? undefined, timeoutMs: 200 },
    );
    if (!ipcReady) await sleep(50);
  }
  report.readyAfterMs = Date.now() - startedAt;
  report.ipcReady = ipcReady;
  fs.writeFileSync(path.join(cfg.runDir, "worker-ready"), String(Date.now()));

  // 采样：压力模式 + 真实调度状态（scheduled/current 间隔）
  const pressureIntervals = [];
  let pressureOpenAt = null;
  const samples = [];
  /** 只在"压力位/排期间隔"发生变化时记录一行，用于还原调度决策时间线 */
  const scheduleTimeline = [];
  let lastScheduleKey = null;
  const sampler = setInterval(() => {
    const state = host.getJobState("outbox") ?? {};
    const pressure = host.isPressureMode();
    const scheduled = state.scheduledIntervalMs ?? null;
    samples.push({
      t: Date.now(),
      pressure,
      scheduledIntervalMs: scheduled,
      currentIntervalMs: state.currentIntervalMs ?? null,
      idleStreak: state.idleStreak ?? null,
    });
    const key = `${pressure}|${scheduled}|${state.currentIntervalMs ?? null}`;
    if (key !== lastScheduleKey) {
      lastScheduleKey = key;
      scheduleTimeline.push({
        offsetMs: Date.now() - startedAt,
        pressure,
        scheduledIntervalMs: scheduled,
        currentIntervalMs: state.currentIntervalMs ?? null,
        idleStreak: state.idleStreak ?? null,
      });
    }
    if (pressure && pressureOpenAt === null) pressureOpenAt = Date.now();
    if (!pressure && pressureOpenAt !== null) {
      pressureIntervals.push({ startMs: pressureOpenAt, endMs: Date.now() });
      pressureOpenAt = null;
    }
  }, 50);
  sampler.unref?.();

  let stopRequested = false;
  const stopWatcher = setInterval(() => {
    if (sentinelExists(cfg.runDir, "STOP_WORKER")) stopRequested = true;
  }, 50);
  stopWatcher.unref?.();

  const hardDeadline = startedAt + cfg.durationMs + cfg.drainMs + 60_000;
  while (!stopRequested && Date.now() < hardDeadline) {
    await sleep(100);
  }

  clearInterval(sampler);
  if (pressureOpenAt !== null) {
    pressureIntervals.push({ startMs: pressureOpenAt, endMs: Date.now() });
  }

  report.pressure.totalSamples = samples.length;
  report.pressure.activeSamples = samples.filter((s) => s.pressure).length;
  report.pressure.engaged = report.pressure.activeSamples > 0;
  report.pressure.modeEvents = pressureIntervals.map(({ startMs, endMs }) => ({
    startMs,
    endMs,
    startOffsetMs: startMs - startedAt,
    durationMs: endMs - startMs,
  }));
  // WorkerHost 自己打印的压力模式日志（进入/退出），与采样窗口交叉验证
  report.pressure.modeLog = logSink
    .filter(
      (entry) =>
        entry.event === "worker.pressure_mode.entered" || entry.event === "worker.pressure_mode.exited",
    )
    .map((entry) => ({
      event: entry.event,
      offsetMs: entry.t - startedAt,
      fields: entry.fields ?? null,
    }));
  report.scheduleTimeline = scheduleTimeline;
  report.scheduledIntervalSamplesMs = [...new Set(samples.map((s) => s.scheduledIntervalMs))].filter(
    (v) => v !== null,
  );
  report.currentIntervalSamplesMs = [...new Set(samples.map((s) => s.currentIntervalMs))].filter(
    (v) => v !== null,
  );

  // 真实观测到的轮询间隔 = 相邻 outbox 轮询开始时间之差，并按压力窗口分段
  const gaps = [];
  for (let i = 1; i < cycles.length; i += 1) {
    const gapMs = cycles[i].startMs - cycles[i - 1].startMs;
    const midpoint = cycles[i - 1].startMs + gapMs / 2;
    const duringPressure = pressureIntervals.some(
      (window) => midpoint >= window.startMs && midpoint <= window.endMs,
    );
    gaps.push({
      gapMs,
      duringPressure,
      startMs: cycles[i].startMs,
      processedBefore: cycles[i - 1].processed,
    });
  }
  report.pollIntervals = {
    observedGapCount: gaps.length,
    allMs: latencyStats(gaps.map((g) => g.gapMs)),
    duringPressureMs: latencyStats(gaps.filter((g) => g.duringPressure).map((g) => g.gapMs)),
    outsidePressureMs: latencyStats(gaps.filter((g) => !g.duringPressure).map((g) => g.gapMs)),
    gaps: gaps.map((g) => ({
      startOffsetMs: g.startMs - startedAt,
      gapMs: g.gapMs,
      duringPressure: g.duringPressure,
      processedBeforeGap: g.processedBefore,
    })),
  };
  // 真实轮询时间线（相对 worker 启动），用于在报告里复原"压力前 / 压力中 / 压力后"的实际节拍。
  report.cycleTimeline = cycles.slice(0, 300).map((cycle) => ({
    startOffsetMs: cycle.startMs - startedAt,
    durationMs: cycle.endMs - cycle.startMs,
    processed: cycle.processed,
    ...(cycle.errorKind ? { errorKind: cycle.errorKind } : {}),
  }));

  try {
    await host.stop();
  } catch {
    /* 停止失败不阻断报告 */
  }

  // 退出前的真源读数（使用自身连接，避免 WAL 快照滞后带来的误判）
  try {
    const statusRows = (
      await dbHandle.client.execute(
        "SELECT status, COUNT(*) AS count FROM outbox_events GROUP BY status",
      )
    ).rows;
    const byStatus = {};
    for (const row of statusRows) byStatus[String(row.status)] = Number(row.count);
    report.outboxStatusAtWorkerExit = byStatus;
    report.pendingAtWorkerExit = byStatus.pending ?? 0;
  } catch (error) {
    report.pendingAtWorkerExit = null;
    report.outboxStatusReadError = messageOf(error).slice(0, 300);
  }

  const exitCode = report.aborted ? 3 : 0;
  finish(stopRequested ? "stop_sentinel" : "hard_deadline", exitCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// 角色：orchestrator
// ─────────────────────────────────────────────────────────────────────────────

async function runOrchestrator(flags) {
  const cfg = orchestratorConfig(flags);
  const pressureLeaseAvailable = requireBuiltArtifacts({ requirePressureLease: true });

  const runToken = crypto.randomBytes(4).toString("hex");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "avx-wc-"));
  const dbPath = path.join(runDir, "aervox.db");
  // Unix Domain Socket 路径有长度上限（约 104 字节），因此 socket 放在 tmpdir 根下并用短名。
  const socketPath = path.join(os.tmpdir(), `avx-wc-${runToken}.sock`);
  // 让 in-process 的真实压力租约与子进程指向同一个（隔离的）socket，避免与开发机上真实 Worker 互相干扰。
  process.env.AERVOX_WORKER_IPC_SOCKET = socketPath;

  const warnings = [];
  if (socketPath.length > 100) {
    warnings.push(`IPC socket 路径长度 ${socketPath.length} 接近 unix socket 上限（约 104）`);
  }

  log(`运行目录: ${runDir}`);
  log(`数据库:   ${dbPath}`);
  log(`IPC socket: ${socketPath}`);
  log(
    `配置: writers=${cfg.writers} pace=${cfg.paceMs}ms duration=${cfg.durationMs}ms ` +
      `drain=${cfg.drainMs}ms busy_timeout=${cfg.busyTimeoutMs}ms retryAttempts=${cfg.retryAttempts}`,
  );

  const repos = await import(pathToFileURL(REPOSITORIES_DIST).href);
  const {
    createDatabase,
    initDatabaseSchema,
    SqliteConversationRepository,
  } = repos;

  // ── 建库 + Schema + 共享会话 ───────────────────────────────────────────────
  const seedHandle = await createDatabase({
    url: `file:${dbPath}`,
    busyTimeoutMs: cfg.busyTimeoutMs,
    busyRetry: { attempts: cfg.retryAttempts },
  });
  await initDatabaseSchema(seedHandle.client);
  await new SqliteConversationRepository(seedHandle.db).createSession(LOCAL_CTX, "drill", {
    id: "ses_drill_shared",
  });
  seedHandle.client.close();

  const childEnv = { ...process.env, AERVOX_WORKER_IPC_SOCKET: socketPath };

  const commonArgs = [
    `--db=${dbPath}`,
    `--run-dir=${runDir}`,
    `--run-token=${runToken}`,
    `--duration-ms=${cfg.durationMs}`,
    `--drain-ms=${cfg.drainMs}`,
    `--pace-ms=${cfg.paceMs}`,
    `--busy-timeout-ms=${cfg.busyTimeoutMs}`,
    `--retry-attempts=${cfg.retryAttempts}`,
    `--max-consecutive-busy=${cfg.maxConsecutiveBusy}`,
    `--wakeup-every=${cfg.wakeupEvery}`,
    `--linger-after-poison-ms=${cfg.lingerAfterPoisonMs}`,
    `--socket=${socketPath}`,
  ];

  const children = [];
  const spawnRole = (role, extraArgs, label) => {
    const logPath = path.join(runDir, `${label}.log`);
    const logFd = cfg.verbose ? null : fs.openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, `--role=${role}`, ...commonArgs, ...extraArgs],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        stdio: cfg.verbose ? ["ignore", "inherit", "inherit"] : ["ignore", logFd, logFd],
      },
    );
    if (logFd !== null) fs.closeSync(logFd);
    const record = {
      label,
      role,
      index: extraArgs.find((a) => a.startsWith("--index="))?.slice("--index=".length) ?? null,
      pid: child.pid,
      logPath: cfg.verbose ? null : path.relative(REPO_ROOT, logPath),
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      endedAt: null,
      exitPromise: new Promise((resolve) => {
        child.once("exit", (code, signal) => {
          record.exitCode = code;
          record.signal = signal;
          record.endedAt = Date.now();
          resolve(record);
        });
      }),
    };
    children.push(record);
    log(`已启动 ${label} (pid=${child.pid})`);
    return record;
  };

  try {
    // ── 1. Worker 先起：等自身 IPC 就绪 ─────────────────────────────────────
    const workerChild = spawnRole("worker", [], "worker");
    const readyFile = path.join(runDir, "worker-ready");
    const readyDeadline = Date.now() + 20_000;
    while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) {
      await sleep(50);
    }
    if (!fs.existsSync(readyFile)) {
      warnings.push("Worker 未在 20s 内声明 IPC 就绪，继续执行（压力信号可能未被投递）");
      log("警告: Worker 未在 20s 内就绪");
    } else {
      log("Worker IPC 就绪");
    }

    // ── 2. 拉起 API 写入者，等它们完成启动（加载 dist 模块图需要数秒）─────────
    const writerChildren = [];
    for (let index = 0; index < cfg.writers; index += 1) {
      writerChildren.push(spawnRole("api-writer", [`--index=${index}`], `api-writer-${index}`));
    }
    const writerReadyDeadline = Date.now() + 60_000;
    const allWritersReady = () =>
      writerChildren.every((child) =>
        fs.existsSync(path.join(runDir, `writer-ready-${child.index}`)),
      );
    while (!allWritersReady() && Date.now() < writerReadyDeadline) {
      await sleep(25);
    }
    if (!allWritersReady()) {
      warnings.push("部分写入者未在 60s 内就绪");
      log("警告: 部分写入者未在 60s 内就绪");
    } else {
      log("全部写入者就绪");
    }

    // ── 3. 真实压力租约：与 apps/api 线上握手序列完全一致 ────────────────────
    let pressureHandle = null;
    let pressureSource = "api-worker-pressure-lease (apps/api/dist)";
    const { notifyWorkerPressure } = repos;
    if (pressureLeaseAvailable) {
      const lease = await import(pathToFileURL(PRESSURE_LEASE_DIST).href);
      pressureHandle = {
        acquire: () => lease.acquireWorkerPressureLease(),
        release: (id) => lease.releaseWorkerPressureLease(id),
        ttlMs: lease.PRESSURE_LEASE_TTL_MS,
        refreshMs: lease.PRESSURE_LEASE_REFRESH_MS,
      };
    } else {
      pressureSource = "replicated notifyWorkerPressure(true,15s)/refresh(10s)/pressure(false)";
      const interval = setInterval(() => {
        void notifyWorkerPressure(true, 15_000, socketPath);
      }, 10_000);
      interval.unref?.();
      pressureHandle = {
        acquire: () => {
          void notifyWorkerPressure(true, 15_000, socketPath);
          return "replicated";
        },
        release: () => {
          clearInterval(interval);
          void notifyWorkerPressure(false, undefined, socketPath);
        },
        ttlMs: 15_000,
        refreshMs: 10_000,
      };
    }
    const leaseId = pressureHandle.acquire();
    log(`压力租约已获取 (${pressureSource}, id=${leaseId})`);

    // ── 4. GO 发令 → 计时窗口开始 ──────────────────────────────────────────
    const writerWindowStart = Date.now();
    fs.writeFileSync(path.join(runDir, "GO"), String(writerWindowStart));
    log("已下发 GO，写入窗口开始");

    // 窗口结束条件：所有写入者已退出（例如全部中毒中止）或到达 --duration-ms。
    // 前者让"实际写入窗口"如实反映为更短的时长，而不是白等一个已经无人写入的窗口。
    const windowDeadline = writerWindowStart + cfg.durationMs;
    while (
      Date.now() < windowDeadline &&
      writerChildren.some((child) => child.exitCode === null)
    ) {
      await sleep(25);
    }
    const endedEarly = writerChildren.every((child) => child.exitCode !== null);
    if (endedEarly) {
      warnings.push(
        "写入窗口提前结束：所有写入者都在 --duration-ms 之前退出（通常意味着连接污染中止）",
      );
    }
    fs.writeFileSync(path.join(runDir, "STOP_WRITERS"), String(Date.now()));
    log(
      `已下发 STOP_WRITERS（${endedEarly ? "所有写入者已提前退出" : "窗口到期"}），等待写入者退出`,
    );

    const writerExitDeadline = Date.now() + 90_000;
    while (
      writerChildren.some((child) => child.exitCode === null) &&
      Date.now() < writerExitDeadline
    ) {
      await sleep(50);
    }
    const writerWindowMs = Date.now() - writerWindowStart;

    pressureHandle.release(leaseId);
    log("压力租约已释放，进入 drain 窗口");

    // ── 5. drain：让 Worker 把 Outbox 清空 ─────────────────────────────────
    await sleep(cfg.drainMs);
    fs.writeFileSync(path.join(runDir, "STOP_WORKER"), String(Date.now()));
    log("已下发 STOP_WORKER，等待 Worker 退出");

    const workerExitDeadline = Date.now() + 90_000;
    while (workerChild.exitCode === null && Date.now() < workerExitDeadline) {
      await sleep(50);
    }

    // 极端情况下仍有残留子进程：强杀并记录
    for (const child of children) {
      if (child.exitCode === null) {
        warnings.push(`${child.label} 未在期限内退出，已 SIGKILL`);
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }
    await Promise.all(children.map((child) => child.exitPromise));

    // ── 6. 最终一致性校验（全新连接，所有写入者已退出） ─────────────────────
    const integrity = await checkIntegrity({
      createDatabase,
      dbPath,
      busyTimeoutMs: cfg.busyTimeoutMs,
      retryAttempts: cfg.retryAttempts,
      writerReports: children
        .filter((child) => child.role === "api-writer")
        .map((child) =>
          readReportSync(runDir, `report-api-writer-${child.index}.json`),
        ),
    });

    const workerReport = readReportSync(runDir, "report-worker.json");
    const writerReports = children
      .filter((child) => child.role === "api-writer")
      .map((child) => readReportSync(runDir, `report-api-writer-${child.index}.json`));
    const writerLatencyFiles = children
      .filter((child) => child.role === "api-writer")
      .map((child) => readReportSync(runDir, `latency-api-writer-${child.index}.json`));

    const writerTimelines = children
      .filter((child) => child.role === "api-writer")
      .map((child) => readReportSync(runDir, `timeline-api-writer-${child.index}.json`));

    // ── 7. 汇总 ───────────────────────────────────────────────────────────
    // 延迟统计优先使用各进程落盘的**原始样本**做精确跨进程合并；
    // 若样本文件缺失，则退化为按直方图桶中点近似，并在摘要中显式标注。
    const events = writerTimelines.flatMap((file) => file?.timeline ?? []);
    const exactLatency = writerTimelines.some((file) => file !== null) && events.length > 0;
    const allOkLatencies = exactLatency
      ? events.filter((e) => e[3] === 1).map((e) => e[1])
      : writerReports.flatMap((r) => (r ? expandLatency(r) : []));
    const zeroWrites = (r) => !r || r.writes.attempted === 0;

    // "中毒窗口"诊断：某个写入者命中连接污染后仍存活（--linger-after-poison-ms）的区间内，
    // 其它进程的写入是否被拖住（延迟长尾 / 失败）。这是 libsql 被遗弃事务持锁的直接证据。
    const poisonDiagnostics = buildPoisonDiagnostics({
      writerReports,
      events,
      lingerMs: cfg.lingerAfterPoisonMs,
    });

    const summary = {
      drill: "worker-write-contention",
      version: 1,
      label: cfg.label,
      generatedAt: new Date().toISOString(),
      environment: {
        ...environmentInfo(),
        git: gitInfo(),
        distFingerprint: distFingerprint(),
      },
      config: {
        ...cfg,
        runDir,
        dbPath,
        socketPath,
        runToken,
        pressureSource,
        pressureLeaseTtlMs: pressureHandle.ttlMs,
        pressureLeaseRefreshMs: pressureHandle.refreshMs,
        outboxBaseIntervalMs: 3_000,
        pressureMinIntervalMs: 3_000,
        pressureBackoffFactor: 2,
      },
      durationMs: writerWindowMs,
      processes: children.map((child) => ({
        label: child.label,
        role: child.role,
        index: child.index,
        pid: child.pid,
        exitCode: child.exitCode,
        signal: child.signal,
        startedAt: new Date(child.startedAt).toISOString(),
        endedAt: child.endedAt ? new Date(child.endedAt).toISOString() : null,
        runtimeMs: child.endedAt ? child.endedAt - child.startedAt : null,
        logPath: child.logPath,
      })),
      writesAttempted: sumBy(writerReports, (r) => r.writes.attempted),
      writesSucceeded: sumBy(writerReports, (r) => r.writes.succeeded),
      writesFailed: sumBy(writerReports, (r) => r.writes.failed),
      writesByOp: mergeOpCounters(writerReports),
      sqliteBusyErrors: sumBy(writerReports, (r) => r.errors.sqliteBusyErrors) +
        (workerReport?.errors?.sqliteBusyErrors ?? 0),
      poisonedErrors: sumBy(writerReports, (r) => r.errors.poisonedErrors) +
        (workerReport?.errors?.poisonedErrors ?? 0),
      otherErrors: sumBy(writerReports, (r) => r.errors.otherErrors) +
        (workerReport?.errors?.otherErrors ?? 0),
      // 连接自愈（client.ts ReconnectableClient）是否真的被触发；0 说明本轮没有任何 BEGIN 阶段竞争
      // 走到自愈路径，或事务对象内部的终态错误根本不经过自愈层。
      writerReconnects: sumBy(writerReports, (r) => r.reconnects ?? 0),
      errorSamples: [
        ...writerReports.flatMap((r, i) =>
          r
            ? r.errors.samples.map((s) => ({ source: `api-writer-${i}`, ...s }))
            : [],
        ),
        ...(workerReport?.errors?.samples ?? []).map((s) => ({ source: "worker", ...s })),
      ].slice(0, 20),
      latencyMs: latencyStats(allOkLatencies),
      latencySource: exactLatency ? "exact_merged_raw_samples" : "approximated_from_histogram",
      latencyHistogram: latencyHistogram(allOkLatencies),
      failedLatencyMs: latencyStats(events.filter((e) => e[3] === 0).map((e) => e[1])),
      latencyByOpMs: mergeLatencyByOp(writerReports, events),
      poisonDiagnostics,
      latencyByProcess: writerReports.map((r, i) => ({
        label: `api-writer-${i}`,
        latencyMs: r ? r.latencyMs : null,
      })),
      writerDetail: writerReports.map((r, i) => ({
        label: `api-writer-${i}`,
        pid: r?.pid ?? null,
        bootMs: r?.bootMs ?? null,
        goReceivedAfterMs: r?.goReceivedAfterMs ?? null,
        finishReason: r?.finishReason ?? null,
        aborted: r?.aborted ?? null,
        abortReason: r?.abortReason ?? null,
        abortedAtEpochMs: r?.abortedAtEpochMs ?? null,
        poisonLingerMs: r?.poisonLingerMs ?? null,
        rounds: r?.rounds ?? null,
        turnsCreated: r?.turnsCreated ?? null,
        statusUpdatesApplied: r?.statusUpdatesApplied ?? null,
        extraOutboxInserts: r?.extraOutboxInserts ?? null,
        writes: r?.writes ?? null,
        errors: r
          ? {
              sqliteBusyErrors: r.errors.sqliteBusyErrors,
              poisonedErrors: r.errors.poisonedErrors,
              otherErrors: r.errors.otherErrors,
              maxConsecutiveBusyObserved: r.errors.maxConsecutiveBusyObserved,
            }
          : null,
        wakeups: r?.wakeups ?? null,
        reconnects: r?.reconnects ?? null,
        activeMs: r?.activeMs ?? null,
        reportMissing: r === null,
        zeroWrites: zeroWrites(r),
      })),
      worker: workerReport
        ? {
            pid: workerReport.pid,
            ipcReady: workerReport.ipcReady,
            readyAfterMs: workerReport.readyAfterMs,
            finishReason: workerReport.finishReason,
            cycles: workerReport.cycles,
            eventsProcessed: workerReport.eventsProcessed,
            pressureModeEngaged: workerReport.pressure.engaged,
            pressureSamplesActive: workerReport.pressure.activeSamples,
            pressureSamplesTotal: workerReport.pressure.totalSamples,
            pressureModeWindows: workerReport.pressure.modeEvents,
            pressureModeLog: workerReport.pressure.modeLog ?? [],
            scheduleTimeline: workerReport.scheduleTimeline ?? null,
            busyConflictsObservedByHost:
              workerReport.logCounts?.["worker.task.busy_conflict"] ?? 0,
            taskFailuresObservedByHost: workerReport.logCounts?.["worker.task.failed"] ?? 0,
            scheduledIntervalSamplesMs: workerReport.scheduledIntervalSamplesMs,
            currentIntervalSamplesMs: workerReport.currentIntervalSamplesMs,
            pollIntervals: workerReport.pollIntervals,
            cycleTimeline: workerReport.cycleTimeline ?? null,
            errors: workerReport.errors,
            logCounts: workerReport.logCounts,
            logSamples: workerReport.logSamples,
            pendingAtWorkerExit: workerReport.pendingAtWorkerExit,
            outboxStatusAtWorkerExit: workerReport.outboxStatusAtWorkerExit,
            reportMissing: false,
          }
        : { reportMissing: true },
      integrity,
      warnings,
    };

    // ── 8. 判定与退出码 ───────────────────────────────────────────────────
    const failures = [];
    for (const child of children) {
      const expectedZero = child.role === "worker" || child.role === "api-writer";
      if (child.exitCode === null) {
        failures.push(`process_not_exited: ${child.label}`);
      } else if (child.exitCode !== 0 && expectedZero) {
        failures.push(`process_nonzero_exit: ${child.label} exit=${child.exitCode}`);
      }
    }
    for (const detail of summary.writerDetail) {
      if (detail.reportMissing) failures.push(`missing_report: ${detail.label}`);
      if (detail.aborted) failures.push(`aborted_writer: ${detail.label} (${detail.abortReason})`);
    }
    if (summary.worker.reportMissing) failures.push("missing_report: worker");
    if (!integrity.ok) failures.push("integrity_check_failed");
    if (cfg.writers > 1 && summary.writerDetail.some((d) => d.zeroWrites)) {
      failures.push("writer_produced_zero_writes");
    }
    if (summary.worker.pressureModeEngaged === false) {
      // 不是硬失败，但必须显眼：没有压力模式，"退避"这条验收就无从谈起
      warnings.push("Worker 整轮未进入压力模式（pressureModeEngaged=false）");
    }

    summary.verdict = {
      clean: failures.length === 0,
      exitCode: failures.length === 0 ? 0 : 1,
      failures,
      notes: [
        "sqliteBusyErrors 只统计逃出 withBusyRetry(5 次) 与连接自愈层的错误；被吸收的冲突只体现为延迟。",
        "本演练在开发机上运行，文件系统缓存会弱化竞争，冲突率是下界而非上限。",
      ],
    };

    printSummary(summary, cfg);
    if (cfg.jsonPath) {
      fs.writeFileSync(cfg.jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
      log(`JSON 摘要已写入: ${cfg.jsonPath}`);
    }
    if (!cfg.keep) {
      fs.rmSync(runDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* 已清理 */
      }
    } else {
      log(`保留运行目录: ${runDir}`);
    }
    process.exit(summary.verdict.exitCode);
  } catch (error) {
    for (const child of children) {
      if (child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }
    if (!cfg.keep) fs.rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

function sumBy(items, pick) {
  return items.reduce((acc, item) => acc + (item ? pick(item) : 0), 0);
}

function mergeOpCounters(reports) {
  const merged = {};
  for (const report of reports) {
    if (!report) continue;
    for (const [op, counters] of Object.entries(report.writes.byOp ?? {})) {
      merged[op] = merged[op] ?? { attempted: 0, succeeded: 0, failed: 0 };
      merged[op].attempted += counters.attempted;
      merged[op].succeeded += counters.succeeded;
      merged[op].failed += counters.failed;
    }
  }
  return merged;
}

function mergeLatencyByOp(reports, events = []) {
  const merged = {};
  const ops = new Set();
  for (const report of reports) {
    for (const op of Object.keys(report?.latencyByOpMs ?? {})) ops.add(op);
  }
  for (const event of events) ops.add(event[2]);
  for (const op of ops) {
    const samples = events.filter((e) => e[2] === op && e[3] === 1).map((e) => e[1]);
    if (samples.length > 0) {
      merged[op] = latencyStats(samples);
      continue;
    }
    // 兜底：无原始样本时给出各进程分位数
    merged[op] = {
      count: reports.reduce((acc, r) => acc + (r?.latencyByOpMs?.[op]?.count ?? 0), 0),
      perProcess: reports.map((r) => r?.latencyByOpMs?.[op] ?? null).filter((s) => s !== null),
      source: "approximated_from_histogram",
    };
  }
  return merged;
}

/**
 * 中毒窗口诊断：把每个命中连接污染的写入者的"污染后存活区间"作为观察窗，
 * 统计该窗口内**所有进程**的写入尝试与延迟——若其它进程也被拖住，说明被遗弃的事务确实持锁。
 */
function buildPoisonDiagnostics({ writerReports, events, lingerMs }) {
  const windows = writerReports
    .map((report, index) =>
      report?.abortedAtEpochMs
        ? {
            label: `api-writer-${index}`,
            reason: report.abortReason,
            startEpochMs: report.abortedAtEpochMs,
            endEpochMs: report.abortedAtEpochMs + (report.poisonLingerMs ?? lingerMs),
            lingerMs: report.poisonLingerMs ?? lingerMs,
            writesBeforePoison: report.writes?.attempted ?? null,
          }
        : null,
    )
    .filter((entry) => entry !== null);
  if (windows.length === 0) {
    return { hasPoison: false, windows: [], note: "本轮未命中连接污染（poisoned）状态" };
  }
  const inAnyWindow = (t) =>
    windows.some((window) => t >= window.startEpochMs && t <= window.endEpochMs);
  const windowEvents = events.filter((e) => inAnyWindow(e[0]));
  const baselineEvents = events.filter((e) => !inAnyWindow(e[0]));
  const attemptsInWindow = windowEvents.length;
  const failuresInWindow = windowEvents.filter((e) => e[3] === 0).length;
  return {
    hasPoison: true,
    windows,
    lingerMsUsed: lingerMs,
    duringPoisonWindow: {
      writeAttempts: attemptsInWindow,
      writeFailures: failuresInWindow,
      failureRate: attemptsInWindow === 0 ? null : round(failuresInWindow / attemptsInWindow, 4),
      latencyMs: latencyStats(windowEvents.filter((e) => e[3] === 1).map((e) => e[1])),
    },
    baseline: {
      writeAttempts: baselineEvents.length,
      writeFailures: baselineEvents.filter((e) => e[3] === 0).length,
      latencyMs: latencyStats(baselineEvents.filter((e) => e[3] === 1).map((e) => e[1])),
    },
    note:
      lingerMs > 0
        ? "窗口 = 中毒写入者停止写入后仍存活（linger）的区间；用于测量被遗弃事务是否拖住其它进程。"
        : "linger=0：中毒进程立即退出，窗口近似为瞬时，仅用于标注中毒时刻。",
  };
}

/**
 * 从报告里还原近似延迟样本：报告为控制体积只保留了分位数与直方图，这里用直方图桶中点
 * 作为近似样本，用于给出"全进程合并"的 p50/p95/p99（在报告中标注为近似）。
 */
function expandLatency(report) {
  const samples = [];
  if (!report?.latencyHistogram) return samples;
  for (const bucket of report.latencyHistogram) {
    const match = /^(\d+)-(\d+)ms$/.exec(bucket.bucket);
    const openMatch = /^>(\d+)ms$/.exec(bucket.bucket);
    let midpoint = null;
    if (match) midpoint = (Number(match[1]) + Number(match[2])) / 2;
    else if (openMatch) midpoint = Number(openMatch[1]) * 1.5;
    else if (bucket.bucket.endsWith("ms")) midpoint = Number.parseFloat(bucket.bucket) / 2;
    if (midpoint === null) continue;
    for (let i = 0; i < bucket.count; i += 1) samples.push(midpoint);
  }
  return samples;
}

/**
 * 最终一致性校验：所有写入者已退出后，用**全新连接**读取真源。
 * 校验项（硬失败）：行数守恒、无孤儿 Turn、Outbox pending===0、无 dead_letter。
 */
async function checkIntegrity({ createDatabase, dbPath, busyTimeoutMs, retryAttempts, writerReports }) {
  const handle = await createDatabase({
    url: `file:${dbPath}`,
    busyTimeoutMs,
    busyRetry: { attempts: retryAttempts },
  });
  const query = async (sql) => (await handle.client.execute(sql)).rows;
  const scalar = async (sql) => Number((await query(sql))[0]?.c ?? 0);

  const expectedTurns = writerReports.reduce((acc, r) => acc + (r?.turnsCreated ?? 0), 0);
  const expectedTurnsByProcess = writerReports.map((r) => r?.turnsCreated ?? 0);

  const turnsInDb = await scalar(`SELECT COUNT(*) AS c FROM turns WHERE id LIKE '${TURN_ID_PREFIX}%'`);
  const messagesInDb = await scalar(
    `SELECT COUNT(*) AS c FROM message_versions WHERE id LIKE '${MESSAGE_ID_PREFIX}%'`,
  );
  const orphanTurns = await scalar(
    `SELECT COUNT(*) AS c FROM turns t WHERE t.id LIKE '${TURN_ID_PREFIX}%' ` +
      `AND NOT EXISTS (SELECT 1 FROM message_versions m WHERE m.turn_id = t.id)`,
  );
  const turnStatusRows = await query(
    `SELECT status, COUNT(*) AS c FROM turns WHERE id LIKE '${TURN_ID_PREFIX}%' GROUP BY status`,
  );
  const turnStatusCounts = {};
  for (const row of turnStatusRows) turnStatusCounts[String(row.status)] = Number(row.c);
  const outboxStatusRows = await query(
    "SELECT status, COUNT(*) AS c FROM outbox_events GROUP BY status",
  );
  const outboxStatusCounts = {};
  for (const row of outboxStatusRows) outboxStatusCounts[String(row.status)] = Number(row.c);
  // 注意：通用 outbox 处理器写入的是 `audit_records`（packages/schema 的表名），
  // 不是 DDL 里另一张同域表 `audit_logs`；这里统计的是真正被写入的那张。
  const auditRecords = await scalar("SELECT COUNT(*) AS c FROM audit_records");
  const sessionTurns = await scalar(
    "SELECT COUNT(*) AS c FROM turns WHERE session_id = 'ses_drill_shared'",
  );

  handle.client.close();

  const outboxPending = outboxStatusCounts.pending ?? 0;
  const outboxDeadLetter = outboxStatusCounts.dead_letter ?? 0;
  const outboxFailed = outboxStatusCounts.failed ?? 0;

  const checks = [
    {
      name: "turns_row_conservation",
      ok: turnsInDb === expectedTurns,
      detail: `expected=${expectedTurns} actual=${turnsInDb} perProcess=${JSON.stringify(expectedTurnsByProcess)}`,
    },
    {
      name: "messages_row_conservation",
      ok: messagesInDb === expectedTurns,
      detail: `expected=${expectedTurns} actual=${messagesInDb}`,
    },
    { name: "no_orphan_turns", ok: orphanTurns === 0, detail: `orphanTurns=${orphanTurns}` },
    {
      name: "outbox_pending_zero",
      ok: outboxPending === 0,
      detail: `pending=${outboxPending}`,
    },
    {
      name: "outbox_no_dead_letter",
      ok: outboxDeadLetter === 0,
      detail: `deadLetter=${outboxDeadLetter}`,
    },
    {
      name: "session_row_consistency",
      ok: sessionTurns === turnsInDb,
      detail: `turnsInSharedSession=${sessionTurns} drillTurns=${turnsInDb}`,
    },
  ];
  const advisory = [
    {
      name: "turn_status_all_completed",
      ok: (turnStatusCounts.Completed ?? 0) === expectedTurns,
      detail: `statusCounts=${JSON.stringify(turnStatusCounts)}`,
    },
    {
      name: "outbox_no_failed_retriable",
      ok: outboxFailed === 0,
      detail: `failed=${outboxFailed}`,
    },
    {
      name: "worker_consumed_every_event",
      ok: auditRecords === (outboxStatusCounts.published ?? 0),
      detail: `auditRecords=${auditRecords} published=${outboxStatusCounts.published ?? 0}`,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    expectedTurns,
    turnsInDb,
    messagesInDb,
    orphanTurns,
    turnStatusCounts,
    outboxStatusCounts,
    outboxPending,
    outboxDeadLetter,
    outboxFailed,
    auditRecords,
    checks,
    advisory,
  };
}

function printSummary(summary, cfg) {
  const text = JSON.stringify(summary, null, 2);
  process.stdout.write(`${text}\n`);
  if (!cfg.verbose) {
    process.stderr.write(
      `\n[drill] 结论: ${summary.verdict.clean ? "CLEAN" : "NOT CLEAN"} ` +
        `(exit=${summary.verdict.exitCode})` +
        (summary.verdict.failures.length > 0
          ? `\n[drill] 失败项:\n  - ${summary.verdict.failures.join("\n  - ")}`
          : "") +
        `\n[drill] 写入 ${summary.writesSucceeded}/${summary.writesAttempted} 成功, ` +
        `busy=${summary.sqliteBusyErrors} poisoned=${summary.poisonedErrors} other=${summary.otherErrors} ` +
        `reconnects=${summary.writerReconnects}\n` +
        `[drill] 写入延迟 p50=${summary.latencyMs.p50Ms}ms p95=${summary.latencyMs.p95Ms}ms ` +
        `p99=${summary.latencyMs.p99Ms}ms (n=${summary.latencyMs.count})\n` +
        `[drill] Worker 压力模式=${summary.worker.pressureModeEngaged ?? "n/a"} ` +
        `压力窗口=${JSON.stringify(summary.worker.pressureModeWindows ?? [])}\n` +
        `[drill] 压力期轮询间隔=${JSON.stringify(summary.worker.pollIntervals?.duringPressureMs ?? null)}\n` +
        `[drill] 完整性=${summary.integrity.ok ? "OK" : "FAILED"}\n` +
        (summary.poisonDiagnostics?.hasPoison
          ? `[drill] 连接污染窗口=${JSON.stringify(summary.poisonDiagnostics.windows)} ` +
            `窗口内其它进程写入失败率=${summary.poisonDiagnostics.duringPoisonWindow.failureRate}\n`
          : ""),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

const flags = parseFlags(process.argv.slice(2));
const role = flags.role ?? "orchestrator";

if (role === "orchestrator") {
  await runOrchestrator(flags);
} else if (role === "api-writer") {
  await runApiWriter(flags);
} else if (role === "worker") {
  await runWorker(flags);
} else {
  throw new Error(`未知 --role=${role}（支持 orchestrator / api-writer / worker）`);
}
