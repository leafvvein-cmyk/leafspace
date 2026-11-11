const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

function zonedParts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute),
    second: Number(values.second), millisecond: date.getUTCMilliseconds(), weekday: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[values.weekday] };
}

function localInstant(parts, timezone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const seen = zonedParts(new Date(instant), timezone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, seen.millisecond);
    const difference = target - seenUtc;
    if (!difference) break;
    instant += difference;
  }
  return new Date(instant);
}

function shiftedDate(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)); date.setUTCDate(date.getUTCDate() + days);
  return { ...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayFor(parts) { return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() || 7; }

export function normalizeTaskRecurrence(value, dueAt, timezone) {
  if (value == null) return null;
  if (!dueAt || !value || !['daily', 'weekly', 'monthly'].includes(value.frequency) || !Number.isInteger(value.interval)
    || value.interval < 1 || value.interval > 365) throw new Error('重复待办规则无效');
  let due;
  try { due = zonedParts(new Date(dueAt), timezone); } catch { throw new Error('重复待办规则无效'); }
  if (value.frequency === 'daily') return { frequency: 'daily', interval: value.interval };
  if (value.frequency === 'weekly') {
    const weekdays = value.weekdays == null ? [due.weekday] : [...new Set(value.weekdays)].sort((a, b) => a - b);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || !WEEKDAYS.includes(day))) throw new Error('每周重复日期无效');
    return { frequency: 'weekly', interval: value.interval, weekdays };
  }
  const dayOfMonth = value.dayOfMonth ?? due.day;
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new Error('每月重复日期无效');
  return { frequency: 'monthly', interval: value.interval, dayOfMonth };
}

export function nextTaskDueAt(dueAt, timezone, rawRecurrence) {
  const recurrence = normalizeTaskRecurrence(rawRecurrence, dueAt, timezone), current = zonedParts(new Date(dueAt), timezone);
  let next;
  if (recurrence.frequency === 'daily') next = shiftedDate(current, recurrence.interval);
  else if (recurrence.frequency === 'weekly') {
    const weekday = weekdayFor(current), later = recurrence.weekdays.find((day) => day > weekday);
    next = shiftedDate(current, later == null ? recurrence.interval * 7 - weekday + recurrence.weekdays[0] : later - weekday);
  } else {
    const monthIndex = current.year * 12 + current.month - 1 + recurrence.interval;
    const year = Math.floor(monthIndex / 12), month = monthIndex % 12 + 1, lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    next = { ...current, year, month, day: Math.min(recurrence.dayOfMonth, lastDay) };
  }
  return localInstant(next, timezone).toISOString();
}
