import type { KnowledgeItem, ReviewItem } from "./types.js";

export function updateAfterAnswer(item: KnowledgeItem, isCorrect: boolean): void {
  if (isCorrect) {
    item.correctCount++;
    item.correctStreak++;
    item.mastery = Math.min(item.mastery + 0.1, 1);
  } else {
    item.wrongCount++;
    item.correctStreak = 0;
    item.mastery = Math.max(item.mastery - 0.1, 0);
  }
}

function getReviewIntervalDays(
  isCorrect: boolean,
  correctStreak: number,
): number {
  if (!isCorrect || correctStreak === 0) return 1;

  if (correctStreak === 1) return 2;

  if (correctStreak === 2) return 4;

  if (correctStreak === 3) return 8;

  return 15;
}

export function createReviewItem(
  item: KnowledgeItem,
  isCorrect: boolean,
  options: { now?: Date; timeZone?: string } = {},
): ReviewItem {
  const intervalDays = getReviewIntervalDays(isCorrect, item.correctStreak);
  const dueAt = addCalendarDays(options.now ?? new Date(), intervalDays, options.timeZone ?? "UTC");

  return {
    knowledgeId: item.id,
    dueAt,
    intervalDays,
    schedulerVersion: 2,
  };
}

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(date: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function partsAsUtc(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function zonedDateTimeToUtc(target: DateTimeParts, timeZone: string): Date {
  let instant = partsAsUtc(target);
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = zonedParts(new Date(instant), timeZone);
    const adjustment = partsAsUtc(target) - partsAsUtc(actual);
    if (adjustment === 0) break;
    instant += adjustment;
  }
  return new Date(instant);
}

export function getLocalDayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const local = zonedParts(now, timeZone);
  const startParts: DateTimeParts = { ...local, hour: 0, minute: 0, second: 0 };
  const nextCalendar = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const endParts: DateTimeParts = {
    year: nextCalendar.getUTCFullYear(),
    month: nextCalendar.getUTCMonth() + 1,
    day: nextCalendar.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  return {
    start: zonedDateTimeToUtc(startParts, timeZone),
    end: zonedDateTimeToUtc(endParts, timeZone),
  };
}

function addCalendarDays(now: Date, intervalDays: number, timeZone: string): Date {
  const local = zonedParts(now, timeZone);
  const targetCalendar = new Date(partsAsUtc(local));
  targetCalendar.setUTCDate(targetCalendar.getUTCDate() + intervalDays);
  const target: DateTimeParts = {
    year: targetCalendar.getUTCFullYear(),
    month: targetCalendar.getUTCMonth() + 1,
    day: targetCalendar.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
    second: local.second,
  };

  return zonedDateTimeToUtc(target, timeZone);
}
