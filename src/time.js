// 时间核心：所有“时长”都以绝对时刻（毫秒）计算，按会员所在时区切分自然日。
// 这样跨午夜、跨时区旅行、设备时钟被篡改都不会凭空增加或减少时长。

const MINUTE_MS = 60_000;

// 以分钟为粒度的左闭右开区间 [startMs, endMs)。
export function interval(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error(`非法时间区间: ${startMs}..${endMs}`);
  }
  return { start: startMs, end: endMs };
}

export function durationMs(iv) {
  return iv.end - iv.start;
}

// 合并重叠/相邻区间，返回归一化后的不相交区间（按开始时刻升序）。
// 消费记账一律先归并：同一会员在两台设备上的重叠观看只扣一次。
export function mergeIntervals(intervalsList) {
  const sorted = intervalsList
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

// 归并两批区间（用于“离线设备补传 + 已有账目”），返回 { merged, addedMs }。
// addedMs 是真正新增的时长：重传或重叠的部分不计费。
export function mergeInto(existing, incoming) {
  const before = totalDuration(existing);
  const merged = mergeIntervals([...existing, ...incoming]);
  const after = totalDuration(merged);
  return { merged, addedMs: after - before };
}

export function totalDuration(intervalsList) {
  return mergeIntervals(intervalsList).reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

// 求在窗口 [windowStart, windowEnd) 内的总时长（分钟区间与窗口求交）。
export function durationWithin(intervalsList, windowStart, windowEnd) {
  return mergeIntervals(intervalsList)
    .map((iv) => ({ start: Math.max(iv.start, windowStart), end: Math.min(iv.end, windowEnd) }))
    .filter((iv) => iv.end > iv.start)
    .reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

// 把任意区间按自然日（指定 IANA 时区）切成 [dayStart, dayEnd) 片段。
// 跨午夜的一段连播会被切成两段，分别计入两天的每日预算。
export function splitByCalendarDay(iv, timeZone) {
  const pieces = [];
  let cursor = iv.start;
  while (cursor < iv.end) {
    const dayStart = startOfCalendarDay(cursor, timeZone);
    // 下一个当地零点（DST 切换日可能相距 23 或 25 小时）。
    const dayEnd = startOfCalendarDay(dayStart + 25 * 60 * MINUTE_MS, timeZone);
    const pieceEnd = Math.min(iv.end, dayEnd);
    pieces.push({ day: calendarDate(dayStart, timeZone), iv: interval(cursor, pieceEnd) });
    cursor = pieceEnd;
  }
  return pieces;
}

// 用 Intl 求某绝对时刻在指定时区“当地零点”的绝对时刻。
export function startOfCalendarDay(instantMs, timeZone) {
  // 取当地年月日，再问“当地这一天 00:00 对应哪个绝对时刻”。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  // 二分：当地零点一定在 instant 前 0~24 小时多（DST 日可能是 23/25 小时）。
  let lo = instantMs - 26 * 60 * MINUTE_MS;
  let hi = instantMs;
  const dayStr = `${y}-${pad(m)}-${pad(d)}`;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (calendarDate(mid, timeZone) === dayStr) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function calendarDate(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 判断某绝对时刻是否落在“当地 HH:MM-HH:MM”时段内（支持跨午夜时段，如 22:00-06:00）。
export function inLocalWindow(instantMs, timeZone, fromMinutes, toMinutes) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const now = get("hour") * 60 + get("minute");
  if (fromMinutes === toMinutes) return false; // 空窗口
  if (fromMinutes < toMinutes) return now >= fromMinutes && now < toMinutes;
  // 跨午夜
  return now >= fromMinutes || now < toMinutes;
}

export function localMinutes(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

// 求“某时区、某当地日期的 HH:MM”对应的最早绝对时刻。
// 正确处理 DST：春季不存在的时刻（gap）取跳变后的那一刻；
// 秋季重复的时刻（fold）取第一次出现（最早）。
export function wallTimeInstant(timeZone, dateStr, minutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayStart = startOfCalendarDay(Date.UTC(y, m - 1, d, 12), timeZone);
  let guess = dayStart + minutes * MINUTE_MS;
  // 最多三次偏移校正（一天内偏移至多变化一次）。
  for (let i = 0; i < 3; i++) {
    const lm = localMinutes(guess, timeZone);
    const cd = calendarDate(guess, timeZone);
    if (cd === dateStr) {
      if (lm === minutes) return guess;
      guess += (minutes - lm) * MINUTE_MS;
    } else {
      guess = dayStart + minutes * MINUTE_MS - MINUTE_MS;
    }
  }
  // 兜底：分钟级扫描；春季 gap（目标挂钟时刻不存在）前跳到跳变后的第一刻。
  const dayEnd = startOfCalendarDay(dayStart + 25 * 60 * MINUTE_MS, timeZone);
  let prevLm = -1;
  for (let t = dayStart; t < dayEnd; t += MINUTE_MS) {
    if (calendarDate(t, timeZone) !== dateStr) continue;
    const lm = localMinutes(t, timeZone);
    if (lm === minutes && lm !== prevLm) return t; // 秋季 fold 取第一次
    if (lm > minutes && prevLm < minutes) return t; // 春季 gap 前跳
    prevLm = lm;
  }
  return dayEnd;
}

// 停用时段结束的绝对时刻：从 atMs 起第一次离开该窗口的时刻。
export function windowExitInstant(atMs, timeZone, fromMinutes, toMinutes) {
  const today = calendarDate(atMs, timeZone);
  const nowMin = localMinutes(atMs, timeZone);
  if (fromMinutes < toMinutes) {
    return wallTimeInstant(timeZone, today, toMinutes);
  }
  // 跨午夜窗口（如 22:00-06:00）
  if (nowMin >= fromMinutes) {
    const [y, m, d] = today.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    return wallTimeInstant(timeZone, tomorrow, toMinutes);
  }
  return wallTimeInstant(timeZone, today, toMinutes);
}

export { MINUTE_MS };
