/**
 * Aervox｜思隅 @aervox/host-agent — DSH/pi stdio Adapter 模拟子进程（测试 fixture）
 *
 * 与 packages/agent-loop 的 AdapterWireMessage 线协议一致（自包含实现，不 import 包）：
 * - 启动即 hello（manifest 由 env 注入：ADAPTER_ID/SHA/LICENSE/POLICY）；
 * - stdin 逐行读 request → 回报 delta 事件 + 批次声明（SIM_BATCH=all|none|mixed|none-value）
 *   → done；
 * - SIM_BATCH=mixed 用于验证 Aervox 严格策略对 dsh-any 混合批次的拒绝（不静默放行）。
 */
import { createInterface } from "node:readline";

process.stdout.write(
  JSON.stringify({
    kind: "hello",
    manifest: {
      adapterId: process.env.ADAPTER_ID ?? "dsh",
      version: "sim-1.0",
      sha256: process.env.ADAPTER_SHA ?? "sim-sha",
      license: process.env.ADAPTER_LICENSE ?? "MIT",
      terminationPolicy: process.env.ADAPTER_POLICY === "every" ? "every" : "any",
    },
  }) + "\n",
);

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ kind: "error", id: "unknown", message: "bad_request" }) + "\n");
    return;
  }
  if (msg.kind !== "request") return;

  const batchMode = process.env.SIM_BATCH ?? "all";
  const writes = [
    {
      kind: "event",
      id: msg.id,
      event: { type: "delta", text: process.env.SIM_DELTA ?? "模拟适配器执行完成" },
    },
  ];
  if (batchMode === "all") writes.push({ kind: "batch", id: msg.id, concludes: [true, true] });
  else if (batchMode === "none") writes.push({ kind: "batch", id: msg.id, concludes: [false, false] });
  else if (batchMode === "mixed") writes.push({ kind: "batch", id: msg.id, concludes: [true, false] });
  // none-value：不声明批次（协议缺陷，host 应按无结论收敛）
  writes.push({ kind: "done", id: msg.id });
  for (const w of writes) process.stdout.write(JSON.stringify(w) + "\n");
});