// 预算：同一会员体系下所有产品面、所有设备共用一份时间预算。
// 归并方式：区间内重叠部分只计一次（跨设备同时看不多扣）；
// 跨午夜的记录按本地日界切分归属，总时长守恒。

import { clipInterval, totalMs, unionIntervals } from "../core/intervals.js";
import { dayBoundsUtc, localDateOf, weekdayOf } from "../core/timezone.js";
import { appliesToMatches } from "./agreements.js";
import { recordsOfMembership } from "./consumption.js";

// 某一天的有效预算分钟数 = 基础预算 + 当日适用的 budget_bonus 例外。
export function effectiveBudgetMinutes(agreement, ymd, weekday) {
  if (!agreement || agreement.daily_budget_minutes == null) return null;
  let minutes = agreement.daily_budget_minutes;
  for (const ex of agreement.exceptions ?? []) {
    if (ex.type === "budget_bonus" && appliesToMatches(ex.applies_to, ymd, weekday)) {
      minutes += ex.minutes;
    }
  }
  return minutes;
}

// 某本地日的已用量：把重叠到当天的记录裁剪后做区间归并。
export function usageForLocalDay(store, membership, ymd) {
  const tz = membership.time_zone;
  const bounds = dayBoundsUtc(tz, ymd);
  const range = { start: bounds.start.getTime(), end: bounds.end.getTime() };
  const clipped = [];
  for (const rec of recordsOfMembership(store, membership.membership_id)) {
    const piece = clipInterval({ start: rec.start_ms, end: rec.end_ms }, range);
    if (piece) clipped.push(piece);
  }
  const merged = unionIntervals(clipped);
  return {
    local_date: ymd,
    intervals: merged,
    consumed_seconds: Math.round(totalMs(merged) / 1000),
  };
}

export function budgetStatus(store, membership, agreement, now) {
  const tz = membership.time_zone;
  const ymd = localDateOf(tz, now);
  const weekday = weekdayOf(tz, now);
  const budgetMinutes = effectiveBudgetMinutes(agreement, ymd, weekday);
  const usage = usageForLocalDay(store, membership, ymd);
  const budgetSeconds = budgetMinutes == null ? null : budgetMinutes * 60;
  return {
    local_date: ymd,
    budget_seconds: budgetSeconds,
    consumed_seconds: usage.consumed_seconds,
    remaining_seconds: budgetSeconds == null ? null : budgetSeconds - usage.consumed_seconds,
  };
}

// 连续使用：从最近记录向回找"间隔不超过 gap 的最长链条"。
// 链条末端距 now 超过 gap 视为已经休息过，不在连续使用中。
export function continuousStretch(store, membershipId, nowMs, gapMinutes) {
  const gapMs = gapMinutes * 60_000;
  const ivs = recordsOfMembership(store, membershipId)
    .map((r) => ({ start: r.start_ms, end: r.end_ms }))
    .filter((iv) => iv.start <= nowMs);
  const merged = unionIntervals(ivs);
  let stretchStart = null;
  let lastEnd = null;
  for (const iv of merged) {
    if (iv.start > nowMs) break;
    if (lastEnd === null || iv.start - lastEnd > gapMs) stretchStart = iv.start;
    lastEnd = Math.max(lastEnd ?? 0, iv.end);
  }
  if (lastEnd === null || nowMs - lastEnd > gapMs) {
    return { active: false, continuous_ms: 0, last_end_ms: lastEnd };
  }
  return { active: true, continuous_ms: nowMs - stretchStart, last_end_ms: lastEnd };
}
