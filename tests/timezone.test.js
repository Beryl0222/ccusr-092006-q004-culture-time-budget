import assert from "node:assert/strict";
import test from "node:test";
import {
  addDaysYmd,
  dayBoundsUtc,
  dayStartUtc,
  localDateOf,
  minutesOfLocalDay,
  offsetMinutesAt,
  splitByLocalDays,
  weekdayOf,
} from "../src/core/timezone.js";

test("上海日界：本地日起点对应前一日 16:00Z", () => {
  assert.equal(dayStartUtc("Asia/Shanghai", "2026-10-02").toISOString(), "2026-10-01T16:00:00.000Z");
  const bounds = dayBoundsUtc("Asia/Shanghai", "2026-10-02");
  assert.equal(bounds.end.getTime() - bounds.start.getTime(), 24 * 3_600_000);
});

test("纽约 DST：春季切换当天只有 23 小时", () => {
  assert.equal(offsetMinutesAt("America/New_York", new Date("2026-03-01T12:00:00Z")), -300);
  assert.equal(offsetMinutesAt("America/New_York", new Date("2026-04-01T12:00:00Z")), -240);
  assert.equal(dayStartUtc("America/New_York", "2026-03-08").toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(dayStartUtc("America/New_York", "2026-03-09").toISOString(), "2026-03-09T04:00:00.000Z");
  const bounds = dayBoundsUtc("America/New_York", "2026-03-08");
  assert.equal(bounds.end.getTime() - bounds.start.getTime(), 23 * 3_600_000);
});

test("跨午夜切分：分片归属不同本地日且总时长守恒", () => {
  const iv = {
    start: Date.parse("2026-10-02T15:30:00Z"), // 上海 23:30
    end: Date.parse("2026-10-02T16:30:00Z"), // 上海 次日 00:30
  };
  const pieces = splitByLocalDays("Asia/Shanghai", iv);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].localDate, "2026-10-02");
  assert.equal(pieces[1].localDate, "2026-10-03");
  const total = pieces.reduce((acc, p) => acc + (p.end - p.start), 0);
  assert.equal(total, iv.end - iv.start);
});

test("本地日期与分钟数", () => {
  const at = new Date("2026-10-02T15:00:00Z"); // 上海 23:00
  assert.equal(localDateOf("Asia/Shanghai", at), "2026-10-02");
  assert.equal(minutesOfLocalDay("Asia/Shanghai", at), 23 * 60);
  assert.equal(weekdayOf("Asia/Shanghai", at), 5); // 2026-10-02 是周五
});

test("addDaysYmd 跨年跨月闰年", () => {
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysYmd("2028-02-28", 1), "2028-02-29");
});
