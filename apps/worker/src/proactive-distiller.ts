/**
 * CAP-033 本地画像提炼器。
 *
 * 默认实现是确定性的本地规则处理，不调用 LLM/Embedding/网络。它把原始捕获转换为
 * 带来源证据的画像记忆候选，并在持久化前剔除凭据与私钥材料。
 */
import type { ProactiveCaptureModel } from "@aervox/database";

export interface DistilledProfileMemory {
  claimType: string;
  subjectKey: string;
  content: string;
  confidence: number;
  evidenceRefs: Array<{ sourceKey: string; checksum: string; observedAt: string }>;
}

export interface ProactiveCaptureDistiller {
  readonly processorId: string;
  distill(capture: ProactiveCaptureModel): Promise<DistilledProfileMemory[]>;
}

const SOURCE_LABELS: Record<string, { claimType: string; label: string }> = {
  "aervox.activity": { claimType: "usage_habit", label: "Aervox 使用" },
  "aervox.operation": { claimType: "operation_habit", label: "Aervox 操作" },
  "device.app_activity": { claimType: "application_habit", label: "应用与窗口" },
  "device.browser_activity": { claimType: "browsing_habit", label: "浏览器与网页" },
  "device.input_content": { claimType: "input_habit", label: "输入与操作" },
  "device.clipboard": { claimType: "clipboard_habit", label: "剪贴板" },
  "device.screen_capture": { claimType: "screen_context", label: "屏幕上下文" },
  "filesystem.full_disk_watch": { claimType: "document_context", label: "文件与文档" },
  "external.communication": { claimType: "communication_context", label: "通信资料" },
  "device.microphone": { claimType: "media_context", label: "麦克风" },
  "device.camera": { claimType: "media_context", label: "摄像头" },
  "device.location": { claimType: "environment_context", label: "位置" },
  "device.sensors": { claimType: "environment_context", label: "环境与传感器" },
  "restricted.profile": { claimType: "restricted_private_context", label: "敏感私人资料" },
};

const MAX_MEMORY_LENGTH = 4_000;

/** 删除可直接用于认证的材料；画像仍可保留非凭据型私人内容。 */
export function redactCredentialMaterial(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
      "[已排除私钥]",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[已排除访问密钥]")
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, "[已排除令牌]")
    .replace(
      /\b(password|passwd|passcode|token|api[_-]?key|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi,
      (_match, key: string) => `${key}=[已排除凭据]`,
    );
}

function stableValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.startsWith("data:image/") || value.length > 20_000) return "[binary content omitted]";
    return value;
  }
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stableValue).filter(Boolean).join("；");
  if (typeof value === "object") {
    const binaryKeys = new Set(["dataUrl", "thumbnail", "thumbnailDataUrl", "audioBase64", "videoBase64"]);
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !binaryKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}: ${stableValue(item)}`)
      .filter((item) => !item.endsWith(": "))
      .join("；");
  }
  return String(value);
}

function captureText(capture: ProactiveCaptureModel): string {
  const parts = [capture.payloadText ?? "", stableValue(capture.payload)];
  return redactCredentialMaterial(parts.filter(Boolean).join("；").trim())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MEMORY_LENGTH);
}

export function createRuleBasedProactiveDistiller(): ProactiveCaptureDistiller {
  return {
    processorId: "local-rule-profile-v1",
    async distill(capture) {
      if (capture.processingBoundary !== "local_only") {
        throw new Error("proactive capture is not marked local_only");
      }
      const descriptor = SOURCE_LABELS[capture.sourceKey] ?? {
        claimType: "private_context",
        label: capture.sourceKey,
      };
      const text = captureText(capture);
      const day = capture.observedAt.slice(0, 10);
      const content = text
        ? `${descriptor.label}（${day}）：${text}`
        : `${descriptor.label}（${day}）：记录到一次已授权活动，原始内容为空或仅包含被排除的凭据。`;
      return [
        {
          claimType: descriptor.claimType,
          subjectKey: `${capture.sourceKey}:${day}`,
          content,
          confidence: text ? 70 : 40,
          evidenceRefs: [
            {
              sourceKey: capture.sourceKey,
              checksum: capture.checksum,
              observedAt: capture.observedAt,
            },
          ],
        },
      ];
    },
  };
}
