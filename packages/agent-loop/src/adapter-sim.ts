/**
 * Aervox｜思隅 @aervox/agent-loop — DSH/pi Adapter 模拟器（阶段 6）
 *
 * 与子进程 stdio 实现共用同一线协议/收敛语义（见 adapter-contract）：
 * - `createSimAdapterDriver`：内存版 AdapterDriverPort 双实现（dsh-any / pi-every），
 *   供契约测试与 provider-parity 对照（无外部进程依赖）；
 * - `drainAdapterDriver`：收集整 Turn 事件流并产出收敛判定（host/stdio 与 sim 共用），
 *   将上游批次声明收紧为 Aervox `all-results-conclude`。
 */
import type {
  AdapterBatchDeclaration,
  AdapterDriverId,
  AdapterDriverPort,
  AdapterEvent,
  AdapterManifest,
  AdapterRequest,
  BatchConcludeDecision,
} from "./adapter-contract.js";
import { concludeAdapterBatch } from "./adapter-contract.js";

/** 模拟器配置（事件脚本缺省为单段文本回应） */
export interface SimAdapterConfig {
  manifest: AdapterManifest;
  /** 整 Turn 事件序列；缺省为单段 delta 文本 */
  script?: AdapterEvent[];
  /** 覆盖批次声明（配合 script 末条 batch 事件为空脚本时使用） */
  declaresEnds?: boolean[];
}

/** 内存版 Adapter Driver（dsh-any / pi-every 双实现：差异仅在 manifest 策略声明） */
export function createSimAdapterDriver(config: SimAdapterConfig): AdapterDriverPort {
  const { manifest, script } = config;
  const events: AdapterEvent[] =
    script ??
    (config.declaresEnds
      ? [
          { type: "delta", text: `[${manifest.adapterId} 模拟执行：工具批次已结算]` },
          { type: "batch", concludes: config.declaresEnds },
        ]
      : [{ type: "delta", text: `[${manifest.adapterId} 模拟执行完成]` }]);
  return {
    id: manifest.adapterId as AdapterDriverId,
    manifest,
    async *run(_request: AdapterRequest): AsyncIterable<AdapterEvent> {
      for (const ev of events) yield ev;
    },
  };
}

/** 整 Turn 运行结果（事件流 + 批次收敛判定 + 协议缺陷标记） */
export interface AdapterRunOutcome {
  events: AdapterEvent[];
  decision: BatchConcludeDecision;
  /** 未声明批次时的协议缺陷（host 应以无结论收敛） */
  protocolError?: "batch_not_declared";
}

/**
 * 收集一次 Adapter 整 Turn 运行：按 manifest 声明的策略将最后批次收紧为收敛判定。
 * host（stdio 端口）与模拟器共用此收敛语义——同一批次声明在两种实现下产出相同判定。
 */
export async function drainAdapterDriver(
  driver: AdapterDriverPort,
  request: AdapterRequest,
): Promise<AdapterRunOutcome> {
  const events: AdapterEvent[] = [];
  let lastBatch: AdapterBatchDeclaration | undefined;
  const iterable = await driver.run(request);
  for await (const ev of iterable) {
    events.push(ev);
    if (ev.type === "batch") {
      lastBatch = { concludes: ev.concludes };
    }
  }
  if (!lastBatch) {
    return { events, decision: { concluded: false, reason: "empty_batch" }, protocolError: "batch_not_declared" };
  }
  return { events, decision: concludeAdapterBatch(driver.manifest.terminationPolicy, lastBatch) };
}