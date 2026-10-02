// 半开区间 [start, end)，单位毫秒（epoch）。所有观看记录归并都建立在这组操作上。

export function interval(startMs, endMs) {
  return { start: startMs, end: endMs };
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 把 iv 裁剪到 range 内；不相交返回 null。
export function clipInterval(iv, range) {
  const start = Math.max(iv.start, range.start);
  const end = Math.min(iv.end, range.end);
  return start < end ? { start, end } : null;
}

// 归并：排序后合并所有相交或相接的区间。跨设备重叠、重传重复都只计一份。
export function unionIntervals(list) {
  const sorted = list
    .filter((iv) => iv && iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

export function totalMs(list) {
  return list.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
}
