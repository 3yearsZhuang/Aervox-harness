/**
 * Aervox｜思隅 @aervox/host-agent — DSH 真 Turn runner（stdio 协议，测试/接入骨架，阶段 6d）
 *
 * 与 packages/agent-loop 的 AdapterWireMessage 线协议一致（自包含，不 import 包）：
 * - hello：复用 probeDSHReference 形态（gitlink SHA + MIT），由 host 侧复核；
 * - request → 模型回合：真实 LLM 调用（OpenAI 兼容端点，DSH 同款协议：
 *   deepseek 官方或任意兼容 baseUrl）→ delta 文本 → batch(全结论) → done；
 * - 前置：`reference/deepseek-harness` 就绪（可作为后续替换 DSH 库内循环的构建前提）+ 
 *   `DEEPSEEK_API_KEY`（或 `DSH_LLM_BASE_URL`+`DSH_MODEL_ID`）齐备才走真实模型；
 *   缺前置 → error 事件携带精确指引（host 失败自动禁用），不挂死。
 *
 * 说明：DSH 库内 Agent 循环（Cordis 容器）接入需参考仓库 `pnpm install && pnpm
 * build:lib:host` 构建产物——本 runner 是「协议 + 真实模型回合」接通骨架，库内核替换留 P2。
 */
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(fileURLToPath(new URL("../../../../../", import.meta.url)), "reference/deepseek-harness");
const refReady = existsSync(join(rootDir, "node_modules")) && existsSync(join(rootDir, "packages/core/agent/dist"));

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const hasExplicitBaseUrl = Boolean(process.env.DSH_LLM_BASE_URL);
const modelReady = Boolean(apiKey) || hasExplicitBaseUrl;
const baseUrl = hasExplicitBaseUrl ? process.env.DSH_LLM_BASE_URL : "https://api.deepseek.com/v1";
const modelId = process.env.DSH_MODEL_ID ?? "deepseek-chat";

const manifest = {
  adapterId: "dsh",
  version: "0.1.1-rc.2",
  sha256: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  license: "MIT",
  terminationPolicy: "any",
};

const out = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

out({ kind: "hello", manifest });

/** 单次模型回合（真实 LLM；OpenAI 兼容，DSH 同款协议） */
async function modelTurn({ userMessage }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 256,
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`dsh_model_error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    out({ kind: "error", id: "unknown", message: "bad_request" });
    return;
  }
  if (msg.kind !== "request") return;
  const id = msg.id;

  if (!modelReady) {
    out({ kind: "error", id, message: "dsh_unconfigured: 需要 DEEPSEEK_API_KEY（或 DSH_LLM_BASE_URL）以运行真实模型 turn" });
    return;
  }
  try {
    const text = await modelTurn({ userMessage: msg.request.userMessage });
    out({ kind: "event", id, event: { type: "delta", text } });
    out({ kind: "batch", id, concludes: [true] });
    out({ kind: "done", id });
  } catch (err) {
    out({ kind: "error", id, message: err instanceof Error ? err.message : "dsh_turn_error" });
  }
});

// 前置检测（非阻塞：仅用于 stderr 日志/审计；就绪状态由 hello 后 request 实际结果判定）
if (!refReady) {
  process.stderr.write(
    `[dsh-runner] 提示：reference/deepseek-harness 未构建（node_modules/dist 缺失）。库内 Agent 循环接入需 \`cd reference/deepseek-harness && pnpm install && pnpm build:lib:host\`；协议层/真实模型回合不受影响。\n`,
  );
}
if (!apiKey) {
  process.stderr.write(
    `[dsh-runner] 提示：无 DEEPSEEK_API_KEY——request 将返回 dsh_unconfigured（失败自动禁用）；设置 key 或本地 OpenAI 兼容端点后可跑真实模型 turn。\n`,
  );
}
void refReady;