// 时区工具：只依赖 Intl，不引入外部包。
// 关键不变量：观看区间以 UTC 绝对时刻存储，本地日界只影响"归属哪一天"，
// 因此跨午夜、改时区都不会凭空增加或减少时长。

const timeFormatCache = new Map();
const dateFormatCache = new Map();
const weekdayFormatCache = new Map();

function timeFormatter(tz) {
  let f = timeFormatCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    timeFormatCache.set(tz, f);
  }
  return f;
}

function dateFormatter(tz) {
  let f = dateFormatCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatCache.set(tz, f);
  }
  return f;
}

function weekdayFormatter(tz) {
  let f = weekdayFormatCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
    weekdayFormatCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(tz, date) {
  const parts = {};
  for (const p of timeFormatter(tz).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts; // {year, month, day, hour, minute, second}
}

// 该时区在某一瞬间相对 UTC 的偏移（分钟）。
export function offsetMinutesAt(tz, date) {
  const p = localParts(tz, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function localDateOf(tz, date) {
  return dateFormatter(tz).format(date); // YYYY-MM-DD
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function weekdayOf(tz, date) {
  return WEEKDAYS[weekdayFormatter(tz).format(date)];
}

export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

// 某个本地日期 00:00 对应的 UTC 瞬间。两次迭代收敛偏移，兼容 DST 切换日。
export function dayStartUtc(tz, ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let start = guess - offsetMinutesAt(tz, new Date(guess)) * 60_000;
  start = guess - offsetMinutesAt(tz, new Date(start)) * 60_000;
  start = guess - offsetMinutesAt(tz, new Date(start)) * 60_000;
  return new Date(start);
}

export function dayBoundsUtc(tz, ymd) {
  return { start: dayStartUtc(tz, ymd), end: dayStartUtc(tz, addDaysYmd(ymd, 1)) };
}

// 本地时刻（HH:MM）在某一天对应的 UTC 瞬间。
export function localTimeToUtc(tz, ymd, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(dayStartUtc(tz, ymd).getTime() + (hh * 60 + mm) * 60_000);
}

// date 距离其本地日界起点过去了多少分钟（用于停用时段判断）。
export function minutesOfLocalDay(tz, date) {
  const start = dayStartUtc(tz, localDateOf(tz, date));
  return (date.getTime() - start.getTime()) / 60_000;
}

// 把一段 UTC 区间按本地日界切开，每片标注归属的本地日期。
// 切分只改变归属，不改变总时长（守恒）。
export function splitByLocalDays(tz, iv) {
  const pieces = [];
  let cursor = new Date(iv.start);
  const end = new Date(iv.end);
  let guard = 0;
  while (cursor < end) {
    if (++guard > 4000) throw new Error("splitByLocalDays: 区间过长");
    const ymd = localDateOf(tz, cursor);
    const dayEnd = dayBoundsUtc(tz, ymd).end;
    const pieceEnd = dayEnd < end ? dayEnd : end;
    pieces.push({ start: cursor.getTime(), end: pieceEnd.getTime(), localDate: ymd });
    cursor = pieceEnd;
  }
  return pieces;
}
