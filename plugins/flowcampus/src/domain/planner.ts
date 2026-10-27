import { campusInstantSchema, campusStateSchema, type CampusState, type CampusPlan, type CampusTask } from "../contracts/index.js";

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Empty personal workspace; demo dates and synthetic places never enter host storage. */
export function createEmptyCampusState(): CampusState {
  return { version: 1, places: [], events: [], tasks: [], routes: [],
    settings: { originId: null, bufferMinutes: 5, timezone: "Asia/Shanghai" } };
}

export function recommendCampusTasks(tasks: readonly CampusTask[], availableMinutes: number): CampusTask[] {
  if (!Number.isSafeInteger(availableMinutes) || availableMinutes < 0) throw new Error("invalid_task_budget");
  const priority = { high: 0, medium: 1, low: 2 };
  const candidates = tasks.filter(task => task.status === "pending").slice().sort((a, b) =>
    priority[a.priority] - priority[b.priority] || a.estimatedMinutes - b.estimatedMinutes || compareId(a.id, b.id));
  const chosen: CampusTask[] = [];
  let remaining = availableMinutes;
  for (const task of candidates) {
    if (task.estimatedMinutes <= remaining) { chosen.push(task); remaining -= task.estimatedMinutes; }
  }
  return chosen;
}

/** One immutable input snapshot drives UI and the read-only model tool. No network or writes. */
export function calculateCampusPlan(input: CampusState, at: string | Date = new Date()): CampusPlan {
  const state = campusStateSchema.parse(input);
  const instant = campusInstantSchema.parse(at instanceof Date ? at.toISOString() : at);
  const now = Date.parse(instant);
  const candidates = state.events.filter(event => event.status === "scheduled" && Date.parse(event.endAt) > now)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || compareId(a.id, b.id));
  const nextEvent = candidates[0] ?? null;
  const origin = state.places.find(place => place.id === state.settings.originId) ?? null;
  const destination = state.places.find(place => place.id === nextEvent?.placeId) ?? null;
  const conflicts = nextEvent ? candidates.filter(event => event.id !== nextEvent.id
    && Date.parse(event.startAt) < Date.parse(nextEvent.endAt) && Date.parse(event.endAt) > Date.parse(nextEvent.startAt)) : [];
  const base: CampusPlan = { at: instant, timezone: state.settings.timezone, nextEvent, origin, destination, route: null,
    routeStatus: "not_needed", departureAt: null, freeMinutes: 0, isLate: false,
    departureStatus: "no_schedule", recommendedTasks: [], conflicts };
  if (!nextEvent) return base;
  // Being at the destination has a known zero travel time; no fabricated route record is needed.
  const samePlace = origin !== null && origin.id === destination?.id;
  const route = state.routes.find(value => value.originId === origin?.id && value.destinationId === destination?.id) ?? null;
  if (!origin || !destination || (!samePlace && !route)) {
    return { ...base, routeStatus: "unavailable", departureStatus: "route_unavailable" };
  }
  const travelMs = samePlace ? 0 : route!.durationSeconds * 1000;
  const start = Date.parse(nextEvent.startAt);
  const departure = start - travelMs - state.settings.bufferMinutes * 60000;
  const freeMinutes = Math.max(0, Math.floor((departure - now) / 60000));
  const isLate = now + travelMs > start;
  return { ...base, route: samePlace ? null : route, routeStatus: samePlace ? "not_needed" : "available",
    departureAt: new Date(departure).toISOString(), freeMinutes, isLate,
    departureStatus: isLate ? "late" : now >= departure ? "leave_now" : freeMinutes <= 10 ? "soon" : "relaxed",
    recommendedTasks: recommendCampusTasks(state.tasks, freeMinutes) };
}
