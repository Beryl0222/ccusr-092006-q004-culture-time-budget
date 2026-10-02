import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarDate,
  durationWithin,
  inLocalWindow,
  interval,
  mergeInto,
  mergeIntervals,
  splitByCalendarDay,
  startOfCalendarDay,
  totalDuration,
  wallTimeInstant,
  windowExitInstant,
} from "../src/time.js";

const T = 60_000;

test("区间归并：重叠与相邻只算一次", () => {
  const merged = mergeIntervals([interval(0, 10 * T), interval(5 * T, 20 * T), interval(30 * T, 40 * T)]);
  assert.deepEqual(merged, [interval(0, 20 * T), interval(30 * T, 40 * T)]);
  assert.equal(totalDuration(merged), 30 * T);
});

test("mergeInto：重传与跨设备重叠不多扣", () => {
  const existing = [interval(0, 10 * T)];
  // 完全重传：零增量
  assert.equal(mergeInto(existing, [interval(0, 10 * T)]).addedMs, 0);
  // 部分重叠（另一台设备同时播放）：只算新增的 5 分钟
  const r = mergeInto(existing, [interval(8 * T, 15 * T)]);
  assert.equal(r.addedMs, 5 * T);
  assert.equal(totalDuration(r.merged), 15 * T);
});

test("窗口内时长统计", () => {
  const ivs = [interval(0, 10 * T), interval(20 * T, 30 * T)];
  assert.equal(durationWithin(ivs, 5 * T, 25 * T), 10 * T);
});

test("时区自然日切分：跨午夜的一段消费被切成两天", () => {
  // 北京时间 2026-09-20 23:50 到次日 00:20（UTC 15:50-16:20）
  const start = Date.parse("2026-09-20T23:50:00+08:00");
  const iv = interval(start, start + 30 * T);
  const pieces = splitByCalendarDay(iv, "Asia/Shanghai");
  assert.deepEqual(pieces.map((p) => p.day), ["2026-09-20", "2026-09-21"]);
  assert.equal(pieces[0].iv.end - pieces[0].iv.start, 10 * T);
  assert.equal(pieces[1].iv.end - pieces[1].iv.start, 20 * T);
  // 绝对时长守恒：切分不凭空增加时长
  assert.equal(totalDuration(pieces.map((p) => p.iv)), 30 * T);
});

test("换时区不会增加当天时长：同一绝对时刻在不同时区归属不同日期，但总量守恒", () => {
  const iv = interval(Date.parse("2026-09-20T23:30:00+08:00"), Date.parse("2026-09-21T00:30:00+08:00"));
  const sh = splitByCalendarDay(iv, "Asia/Shanghai");
  const utc = splitByCalendarDay(iv, "UTC");
  assert.equal(totalDuration(sh.map((p) => p.iv)), 60 * T);
  assert.equal(totalDuration(utc.map((p) => p.iv)), 60 * T);
  // UTC 下整段都在 2026-09-20（当地 15:30-16:30）
  assert.deepEqual(utc.map((p) => p.day), ["2026-09-20"]);
});

test("当地零点与跨午夜停用时段判定", () => {
  const at23 = Date.parse("2026-09-20T23:00:00+08:00");
  const at07 = Date.parse("2026-09-20T07:00:00+08:00");
  assert.equal(startOfCalendarDay(at23, "Asia/Shanghai"), Date.parse("2026-09-20T00:00:00+08:00"));
  assert.equal(calendarDate(at23, "Asia/Shanghai"), "2026-09-20");
  assert.equal(inLocalWindow(at23, "Asia/Shanghai", 22 * 60, 6 * 60), true);
  assert.equal(inLocalWindow(at07, "Asia/Shanghai", 22 * 60, 6 * 60), false);
});

test("windowExitInstant：跨午夜窗口在次日 06:00 退出", () => {
  const at23 = Date.parse("2026-09-20T23:00:00+08:00");
  const exit = windowExitInstant(at23, "Asia/Shanghai", 22 * 60, 6 * 60);
  assert.equal(exit, Date.parse("2026-09-21T06:00:00+08:00"));
});

test("wallTimeInstant 处理 DST（纽约春季跳变）", () => {
  // 2026-03-08 美国东部 02:00 不存在，墙上 03:00 = UTC 07:00
  const three = wallTimeInstant("America/New_York", "2026-03-08", 3 * 60);
  assert.equal(new Date(three).toISOString(), "2026-03-08T07:00:00.000Z");
  const midnight = startOfCalendarDay(three, "America/New_York");
  assert.equal(new Date(midnight).toISOString(), "2026-03-08T05:00:00.000Z");
});
