import { describe, expect, it } from "vitest";
import {
  buildLegacySituationModel,
  compareBuiltInRuleParity,
  legacyInputEpoch,
} from "../src/proactive-situation-projector.js";

const input = {
  revisionId: "revision-1",
  now: new Date("2026-09-14T12:00:00.000Z"),
  idleSamples: [
    {observedAt: "2026-09-14T10:00:00.000Z", idleSeconds: 0, captureId: "capture-1"},
    {observedAt: "2026-09-14T11:00:00.000Z", idleSeconds: 300, captureId: "capture-2"},
  ],
  focus: {
    windowStart: "2026-09-14T11:00:00.000Z",
    windowEnd: "2026-09-14T12:00:00.000Z",
    focusScore: 40,
    fatigueScore: 75,
    recommendation: "rest",
  },
  health: {
    sleepMinutes: 300,
    dailySteps: 1000,
    localDate: "2026-09-14",
    observedAt: "2026-09-14T09:00:00.000Z",
  },
  commitments: [{
    id: "commitment-1",
    content: "finish E1",
    status: "open",
    dueAt: "2026-09-15T08:00:00.000Z",
  }],
  drifts: [{signalType: "project_stalled", severity: 70, detectedAt: "2026-09-14T11:30:00.000Z"}],
  scenes: [{sceneType: "device_context", applicationId: "editor", capturedAt: "2026-09-14T11:50:00.000Z"}],
  connections: [{id: "connection-1", provider: "home", state: "active", lastSyncAt: "2026-09-14T11:40:00.000Z"}],
} as const;

describe("CR-036 E1 SituationModel 影子投影", () => {
  it("归约白名单字段、来源与在场边沿", () => {
    const snapshot = buildLegacySituationModel(input, 7);
    expect(snapshot).toMatchObject({
      version: "situation_model_v1",
      revisionId: "revision-1",
      watermark: {lastEventSequence: 7},
      presence: {state: "idle", since: "2026-09-14T11:00:00.000Z"},
      health: {sleepMinutes: 300, dailySteps: 1000},
      commitments: [{id: "commitment-1"}],
      drifts: [{signalType: "project_stalled"}],
    });
    expect(snapshot.provenance).toHaveProperty("presence.sourceKey", "system.idle_state");
    expect(snapshot).not.toHaveProperty("connections.0.hasCredential");
  });

  it("四条内置规则与 CR-032 旧命中结果一致", () => {
    const snapshot = buildLegacySituationModel(input, 7);
    expect(compareBuiltInRuleParity({
      commitment_due: true,
      fatigue_high: true,
      drift_high: true,
      health_sleep_low: true,
    }, snapshot)).toEqual([]);
  });

  it("epoch 忽略运行时钟但感知事实变化会改变", () => {
    const first = legacyInputEpoch(input);
    expect(legacyInputEpoch({...input, now: new Date("2026-09-14T12:01:00.000Z")})).toBe(first);
    expect(legacyInputEpoch({
      ...input,
      idleSamples: [...input.idleSamples, {observedAt: "2026-09-14T12:01:00.000Z", idleSeconds: 0}],
    })).not.toBe(first);
  });
});
