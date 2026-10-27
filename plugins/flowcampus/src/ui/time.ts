function parts(epoch: number, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epoch).map(part => [part.type, part.value]));
}
export function localDateTime(iso: string, timezone: string): string {
  const value = parts(Date.parse(iso), timezone);
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}
/** Resolve the selected timezone, independent of the browser timezone. Reject DST gaps/folds. */
export function absoluteDateTime(input: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) throw new Error('请输入完整的日期和时间。');
  const nominal = Date.parse(`${input}:00Z`);
  if (!Number.isFinite(nominal)) throw new Error('日期或时间无效。');
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const epoch = nominal + hours * 3_600_000;
    const value = parts(epoch, timezone);
    const localEpoch = Date.parse(`${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}Z`);
    offsets.add(localEpoch - epoch);
  }
  const matches = [...offsets].map(offset => nominal - offset).filter(epoch => localDateTime(new Date(epoch).toISOString(), timezone) === input);
  if (matches.length !== 1) throw new Error('该当地时间不存在或有夏令时歧义，请选择另一个时间。');
  return new Date(matches[0]!).toISOString();
}
export function clock(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
export function dateLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(iso));
}
