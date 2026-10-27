import { describe, expect, it } from "vitest";
import { calculateCampusPlan, campusStateSchema, createEmptyCampusState, recommendCampusTasks } from "../src/domain/index.js";
import { campusFixture, NOW } from "./domain-fixtures.js";

describe("campus deterministic plan", () => {
  it("preserves second-based departure and one shared task budget", () => {
    const state = campusFixture(); const before = structuredClone(state);
    const plan = calculateCampusPlan(state, NOW);
    expect(plan.departureAt).toBe("2026-10-26T00:11:00.000Z");
    expect(plan.freeMinutes).toBe(16);
    expect(plan.recommendedTasks.map(task => task.id)).toEqual(["words", "preview"]);
    expect(plan.recommendedTasks.reduce((sum, task) => sum + task.estimatedMinutes, 0)).toBe(15);
    expect(plan.departureStatus).toBe("relaxed"); expect(state).toEqual(before);
    state.routes[0]!.durationSeconds = 841;
    const secondsPlan = calculateCampusPlan(state, NOW);
    expect(secondsPlan.departureAt).toBe("2026-10-26T00:10:59.000Z"); expect(secondsPlan.freeMinutes).toBe(15);
  });
  it.each([
    ["08:10:00", "soon", false], ["08:11:00", "leave_now", false],
    ["08:16:00", "leave_now", false], ["08:16:01", "late", true], ["08:31:00", "late", true],
  ])("keeps the buffer separate from lateness at %s", (time, status, isLate) => {
    const plan = calculateCampusPlan(campusFixture(), `2026-10-26T${time}+08:00`);
    expect(plan.departureStatus).toBe(status); expect(plan.isLate).toBe(isLate);
    expect(plan.nextEvent?.id).toBe("math");
    expect(plan.recommendedTasks.reduce((sum, task) => sum + task.estimatedMinutes, 0)).toBeLessThanOrEqual(plan.freeMinutes);
  });
  it("treats equal instants with different offsets identically", () => {
    expect(calculateCampusPlan(campusFixture(), "2026-10-25T23:55:00Z").departureAt)
      .toBe(calculateCampusPlan(campusFixture(), NOW).departureAt);
  });
  it("keeps personal lists available when the route or origin is unknown", () => {
    const state = campusFixture(); state.routes = [];
    const plan = calculateCampusPlan(state, NOW);
    expect(plan.nextEvent?.id).toBe("math"); expect(plan.departureStatus).toBe("route_unavailable");
    expect(plan.departureAt).toBeNull(); expect(plan.recommendedTasks).toEqual([]);
    expect(state.events).toHaveLength(1); expect(state.tasks).toHaveLength(4);
    state.settings.originId = null;
    expect(calculateCampusPlan(state, NOW).origin).toBeNull();
  });
  it("uses zero travel for the selected destination without inventing a route", () => {
    const state = campusFixture(); state.settings.originId = "classroom"; state.routes = [];
    const plan = calculateCampusPlan(state, NOW);
    expect(plan.routeStatus).toBe("not_needed"); expect(plan.route).toBeNull();
    expect(plan.departureAt).toBe("2026-10-26T00:25:00.000Z"); expect(plan.freeMinutes).toBe(30);
  });
  it("excludes arrived, cancelled and ended events and reports overlaps", () => {
    const state = campusFixture();
    state.events.push({ ...state.events[0]!, id: "club", title: "社团", startAt: "2026-10-26T09:00:00+08:00" });
    expect(calculateCampusPlan(state, NOW).conflicts.map(event => event.id)).toEqual(["club"]);
    state.events[0]!.status = "arrived";
    expect(calculateCampusPlan(state, NOW).nextEvent?.id).toBe("club");
    state.events[1]!.status = "cancelled";
    expect(calculateCampusPlan(state, NOW).departureStatus).toBe("no_schedule");
    state.events[0]!.status = "scheduled";
    expect(calculateCampusPlan(state, "2026-10-26T10:00:00+08:00").nextEvent).toBeNull();
  });
  it("starts empty and derives real time from its supplied clock", () => {
    const plan = calculateCampusPlan(createEmptyCampusState(), new Date("2027-01-02T10:00:00Z"));
    expect(plan.at).toBe("2027-01-02T10:00:00.000Z"); expect(plan.departureStatus).toBe("no_schedule");
    expect(createEmptyCampusState().places).toEqual([]);
  });
  it("does not recommend done tasks or exceed a zero budget", () => {
    const state = campusFixture(); state.tasks[0]!.status = "done";
    expect(recommendCampusTasks(state.tasks, 5).map(task => task.id)).toEqual(["preview"]);
    expect(recommendCampusTasks(state.tasks, 0)).toEqual([]);
    expect(() => recommendCampusTasks(state.tasks, -1)).toThrow("invalid_task_budget");
  });
});

describe("bounded campus state contract", () => {
  it.each(["2026-10-26T08:30:00", "2026-02-30T08:30:00+08:00", "2026-13-01T08:30:00Z"]) ("rejects invalid or timezone-free date %s", time => {
    const state = campusFixture(); state.events[0]!.startAt = time;
    expect(campusStateSchema.safeParse(state).success).toBe(false);
    expect(() => calculateCampusPlan(campusFixture(), time)).toThrow();
  });
  it("rejects backwards intervals, invalid timezones, coordinates and fractional budgets", () => {
    const state = campusFixture(); state.events[0]!.endAt = state.events[0]!.startAt;
    expect(campusStateSchema.safeParse(state).success).toBe(false);
    const badTimezone = campusFixture(); badTimezone.settings.timezone = "Mars/Unknown";
    expect(campusStateSchema.safeParse(badTimezone).success).toBe(false);
    const badTask = campusFixture(); badTask.tasks[0]!.estimatedMinutes = 1.5;
    expect(campusStateSchema.safeParse(badTask).success).toBe(false);
    const badCoords = campusFixture(); badCoords.places[0]!.coords = { latitude: 91, longitude: 12, coordinateSystem: "wgs84" };
    expect(campusStateSchema.safeParse(badCoords).success).toBe(false);
  });
  it("prevents duplicate IDs, dangling references and duplicate directional routes", () => {
    const duplicate = campusFixture(); duplicate.places.push({ ...duplicate.places[0]! });
    expect(campusStateSchema.safeParse(duplicate).success).toBe(false);
    const deleted = campusFixture(); deleted.places = deleted.places.filter(place => place.id !== "classroom");
    expect(campusStateSchema.safeParse(deleted).success).toBe(false);
    const route = campusFixture(); route.routes.push({ ...route.routes[0]! });
    expect(campusStateSchema.safeParse(route).success).toBe(false);
  });
  it.each([["places", 64], ["events", 128], ["tasks", 128], ["routes", 128]] as const)("rejects %s above its capacity", (field, max) => {
    const state = campusFixture(); const item = state[field][0]!;
    const oversized = { ...state, [field]: Array.from({ length: max + 1 }, (_, index) => ({ ...item, id: `entry_${index}` })) };
    expect(campusStateSchema.safeParse(oversized).success).toBe(false);
  });
  it("rejects undeclared credentials and restores the absent empty origin", () => {
    expect(campusStateSchema.safeParse({ ...campusFixture(), apiKey: "private" }).success).toBe(false);
    const empty = createEmptyCampusState();
    const parsed = campusStateSchema.parse({ ...empty, settings: { bufferMinutes: 5, timezone: "Asia/Shanghai" } });
    expect(parsed.settings.originId).toBeNull();
  });
});
