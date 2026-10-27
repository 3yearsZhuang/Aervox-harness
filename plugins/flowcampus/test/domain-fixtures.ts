import { createEmptyCampusState, type CampusState } from "../src/domain/index.js";

export const NOW = "2026-10-26T07:55:00+08:00";
export function campusFixture(): CampusState {
  return { ...createEmptyCampusState(),
    places: [{ id: "dorm", name: "宿舍", address: "北区" }, { id: "classroom", name: "逸夫楼302", address: "教学区" }],
    events: [{ id: "math", title: "高等数学", startAt: "2026-10-26T08:30:00+08:00", endAt: "2026-10-26T10:00:00+08:00", placeId: "classroom", status: "scheduled" }],
    tasks: [
      { id: "words", title: "复习单词", estimatedMinutes: 10, priority: "high", status: "pending" },
      { id: "preview", title: "预习", estimatedMinutes: 5, priority: "medium", status: "pending" },
      { id: "homework", title: "作业", estimatedMinutes: 30, priority: "high", status: "pending" },
      { id: "email", title: "查看通知", estimatedMinutes: 3, priority: "low", status: "pending" },
    ],
    routes: [{ originId: "dorm", destinationId: "classroom", durationSeconds: 840, source: "manual", observedAt: NOW }],
    settings: { originId: "dorm", bufferMinutes: 5, timezone: "Asia/Shanghai" },
  };
}
