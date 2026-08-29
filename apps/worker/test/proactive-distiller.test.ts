import { describe, expect, it } from "vitest";
import type { ProactiveCaptureModel } from "@aervox/database";
import {
  createRuleBasedProactiveDistiller,
  redactCredentialMaterial,
} from "../src/proactive-distiller.js";

const capture = (overrides: Partial<ProactiveCaptureModel> = {}): ProactiveCaptureModel => ({
  id: "cap_1",
  revisionId: "pro_1",
  sourceGrantId: "src_1",
  workspaceId: "ws_1",
  subjectUserId: "usr_1",
  sourceKey: "device.browser_activity",
  contentType: "application/json",
  payloadText: "用户常在晚间阅读 TypeScript 文档",
  checksum: "sha256:test",
  byteSize: 42,
  processingBoundary: "local_only",
  observedAt: "2026-08-29T12:30:00.000Z",
  ingestedAt: "2026-08-29T12:30:01.000Z",
  retentionUntil: "2026-09-05T12:30:01.000Z",
  distillationStatus: "pending",
  distillationAttemptCount: 0,
  lastDistillationError: null,
  retentionBlockedAt: null,
  distilledMemoryIds: [],
  createdAt: "2026-08-29T12:30:01.000Z",
  updatedAt: "2026-08-29T12:30:01.000Z",
  ...overrides,
});

describe("CAP-033 local profile distiller", () => {
  it("creates a source-linked local memory candidate", async () => {
    const [memory] = await createRuleBasedProactiveDistiller().distill(capture());
    expect(memory).toMatchObject({
      claimType: "browsing_habit",
      subjectKey: "device.browser_activity:2026-08-29",
      confidence: 70,
    });
    expect(memory?.content).toContain("TypeScript 文档");
    expect(memory?.evidenceRefs[0]).toMatchObject({ checksum: "sha256:test" });
  });

  it("removes credentials and private keys before memory persistence", async () => {
    const secret = [
      "password=hunter2",
      "token: abc.def.ghi",
      "-----BEGIN PRIVATE KEY-----",
      "private-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const [memory] = await createRuleBasedProactiveDistiller().distill(
      capture({ sourceKey: "device.clipboard", payloadText: secret }),
    );
    expect(memory?.content).not.toContain("hunter2");
    expect(memory?.content).not.toContain("private-material");
    expect(memory?.content).toContain("已排除凭据");
    expect(memory?.content).toContain("已排除私钥");
  });

  it("fails closed when provenance is not local_only", async () => {
    await expect(
      createRuleBasedProactiveDistiller().distill(
        capture({ processingBoundary: "remote" as ProactiveCaptureModel["processingBoundary"] }),
      ),
    ).rejects.toThrow("not marked local_only");
  });

  it("does not promote screen image payloads into profile text", async () => {
    const [memory] = await createRuleBasedProactiveDistiller().distill(
      capture({
        sourceKey: "device.screen_capture",
        payloadText: null,
        payload: { app: "Editor", dataUrl: `data:image/png;base64,${"A".repeat(30_000)}` },
      }),
    );
    expect(memory?.content).toContain("Editor");
    expect(memory?.content).not.toContain("base64");
    expect(memory?.content.length).toBeLessThan(4_000);
  });

  it("redacts common bearer-style secrets", () => {
    expect(redactCredentialMaterial("Authorization: Bearer-credential")).toBe(
      "Authorization=[已排除凭据]",
    );
  });
});
