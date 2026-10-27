import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const CAMPUS_LIMITS = { places: 64, events: 128, tasks: 128, routes: 128 } as const;
const identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const title = z.string().trim().min(1).max(160);
export const campusInstantSchema = z.iso.datetime({ offset: true }).max(64)
  .refine(value => Number.isFinite(Date.parse(value)), "时间必须是有效的带偏移 ISO 8601 日期");
const timezone = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }); return true; } catch { return false; }
}, "不支持的时区");

export const campusPlaceSchema = z.object({
  id: identifier, name: title, address: z.string().trim().max(300),
  coords: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    coordinateSystem: z.enum(["gcj02", "wgs84"]), }).strict().optional(),
}).strict();
export const campusEventSchema = z.object({
  id: identifier, title, startAt: campusInstantSchema, endAt: campusInstantSchema,
  placeId: identifier, status: z.enum(["scheduled", "arrived", "cancelled"]),
}).strict().refine(event => Date.parse(event.endAt) > Date.parse(event.startAt), {
  message: "结束时间必须晚于开始时间", path: ["endAt"],
});
export const campusTaskSchema = z.object({
  id: identifier, title, estimatedMinutes: z.number().int().min(1).max(1440),
  priority: z.enum(["high", "medium", "low"]), status: z.enum(["pending", "done"]),
}).strict();
export const campusRouteSchema = z.object({
  originId: identifier, destinationId: identifier,
  durationSeconds: z.number().int().min(0).max(86400),
  source: z.enum(["manual", "amap"]), observedAt: campusInstantSchema,
}).strict();
export const campusSettingsSchema = z.object({
  // Generic host config removes optional null values. Reading restores the empty origin.
  originId: identifier.nullable().optional().default(null),
  bufferMinutes: z.number().int().min(0).max(120), timezone,
}).strict();
export const campusStateSchema = z.object({
  version: z.literal(1), places: z.array(campusPlaceSchema).max(CAMPUS_LIMITS.places),
  events: z.array(campusEventSchema).max(CAMPUS_LIMITS.events),
  tasks: z.array(campusTaskSchema).max(CAMPUS_LIMITS.tasks),
  routes: z.array(campusRouteSchema).max(CAMPUS_LIMITS.routes), settings: campusSettingsSchema,
}).strict().superRefine((state, context) => {
  const uniqueIds = (items: { id: string }[], key: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) context.addIssue({ code: "custom", path: [key, index, "id"], message: "标识不能重复" });
      seen.add(item.id);
    });
  };
  uniqueIds(state.places, "places"); uniqueIds(state.events, "events"); uniqueIds(state.tasks, "tasks");
  const places = new Set(state.places.map(place => place.id));
  if (state.settings.originId !== null && !places.has(state.settings.originId)) {
    context.addIssue({ code: "custom", path: ["settings", "originId"], message: "起点不存在" });
  }
  state.events.forEach((event, index) => {
    if (!places.has(event.placeId)) context.addIssue({ code: "custom", path: ["events", index, "placeId"], message: "日程关联地点不存在" });
  });
  const pairs = new Set<string>();
  state.routes.forEach((route, index) => {
    for (const key of ["originId", "destinationId"] as const) {
      if (!places.has(route[key])) context.addIssue({ code: "custom", path: ["routes", index, key], message: "路线关联地点不存在" });
    }
    const pair = `${route.originId}:${route.destinationId}`;
    if (pairs.has(pair)) context.addIssue({ code: "custom", path: ["routes", index], message: "同方向路线不能重复" });
    pairs.add(pair);
  });
});

export const campusDepartureStatusSchema = z.enum(["relaxed", "soon", "leave_now", "late", "no_schedule", "route_unavailable"]);
export const campusPlanSchema = z.object({
  at: campusInstantSchema, timezone,
  nextEvent: campusEventSchema.nullable(), origin: campusPlaceSchema.nullable(), destination: campusPlaceSchema.nullable(),
  route: campusRouteSchema.nullable(), routeStatus: z.enum(["available", "unavailable", "not_needed"]),
  departureAt: campusInstantSchema.nullable(), freeMinutes: z.number().int().nonnegative(), isLate: z.boolean(),
  departureStatus: campusDepartureStatusSchema, recommendedTasks: z.array(campusTaskSchema).max(CAMPUS_LIMITS.tasks),
  conflicts: z.array(campusEventSchema).max(CAMPUS_LIMITS.events),
}).strict();
export const campusStateSnapshotSchema = z.object({
  state: campusStateSchema, revision: z.number().int().nonnegative(), lifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusPlanSnapshotSchema = z.object({
  plan: campusPlanSchema, revision: z.number().int().nonnegative(), lifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusSaveRequestSchema = z.object({
  state: campusStateSchema, expectedRevision: z.number().int().nonnegative(), expectedLifecycleGeneration: z.string().min(1).max(128),
}).strict();
export const campusPlanQuerySchema = z.object({ at: campusInstantSchema.optional() }).strict();

export type CampusPlace = z.output<typeof campusPlaceSchema>;
export type CampusEvent = z.output<typeof campusEventSchema>;
export type CampusTask = z.output<typeof campusTaskSchema>;
export type CampusRoute = z.output<typeof campusRouteSchema>;
export type CampusState = z.output<typeof campusStateSchema>;
export type CampusPlan = z.output<typeof campusPlanSchema>;
export type CampusStateSnapshot = z.output<typeof campusStateSnapshotSchema>;
export type CampusPlanSnapshot = z.output<typeof campusPlanSnapshotSchema>;
export type CampusSaveRequest = z.output<typeof campusSaveRequestSchema>;
