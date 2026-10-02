import assert from "node:assert/strict";
import test from "node:test";
import { clipInterval, totalMs, unionIntervals } from "../src/core/intervals.js";

test("归并：重叠与相接区间合并为一段", () => {
  const merged = unionIntervals([
    { start: 0, end: 10 },
    { start: 5, end: 15 },
    { start: 15, end: 20 },
    { start: 30, end: 40 },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 20 },
    { start: 30, end: 40 },
  ]);
  assert.equal(totalMs(merged), 30);
});

test("归并：跨设备完全重叠只计一份", () => {
  const merged = unionIntervals([
    { start: 100, end: 200 },
    { start: 100, end: 200 },
    { start: 150, end: 250 },
  ]);
  assert.deepEqual(merged, [{ start: 100, end: 250 }]);
});

test("裁剪：区间外返回 null，部分相交取交集", () => {
  assert.equal(clipInterval({ start: 0, end: 10 }, { start: 20, end: 30 }), null);
  assert.deepEqual(clipInterval({ start: 0, end: 25 }, { start: 20, end: 30 }), { start: 20, end: 25 });
});
