// 统一预算账：直播连麦、短剧连播、网文章节解锁与提醒背后的消费，
// 都记到同一会员的同一本账上。不同设备的区间先做并集再计费，
// 因此两台设备同时播放只扣一份，离线重传不多扣。

import { durationWithin, interval, mergeIntervals, totalDuration } from "./time.js";

export class Ledger {
  constructor(store) {
    this.store = store;
    this.intervals = new Map(); // memberId -> 归一化区间并集（计费）
    this.exemptIntervals = new Map(); // memberId -> 紧急公益豁免区间（不扣个人预算）
    this.seenRecords = new Map(); // memberId -> Set(client_record_id)
    this.raw = new Map(); // memberId -> [入账记录元数据]
    store.subscribe((e) => this._apply(e));
    for (const e of store.all()) this._apply(e);
  }

  _apply(event) {
    if (event.kind !== "CONSUMPTION_RECORDED") return;
    const p = event.payload;
    const memberId = event.subject_id;
    const seen = this.seenRecords.get(memberId) ?? new Set();
    if (seen.has(p.client_record_id)) return; // 回放幂等
    seen.add(p.client_record_id);
    this.seenRecords.set(memberId, seen);
    const iv = interval(p.start_ms, p.end_ms);
    const target = p.exempt ? this.exemptIntervals : this.intervals;
    target.set(memberId, mergeIntervals([...(target.get(memberId) ?? []), iv]));
    const rawList = this.raw.get(memberId) ?? [];
    rawList.push({
      client_record_id: p.client_record_id,
      device_id: p.device_id,
      product: p.product,
      start_ms: p.start_ms,
      end_ms: p.end_ms,
      added_ms: p.added_ms,
      recorded_at: event.occurred_at,
      was_offline: Boolean(p.was_offline),
    });
    this.raw.set(memberId, rawList);
  }

  // 入账一段可信消费。幂等键为 client_record_id；跨设备重叠自动只算新增。
  // 返回记账结果（duplicated 表示重传，addedMs 为真正新扣的时长）。
  record(memberId, entry, { at = null } = {}) {
    const { device_id, product, client_record_id, start_ms, end_ms, was_offline = false, exempt = false, idempotency_key = null } = entry;
    const seen = this.seenRecords.get(memberId) ?? new Set();
    if (seen.has(client_record_id)) {
      const raw = (this.raw.get(memberId) ?? []).find((r) => r.client_record_id === client_record_id);
      return { duplicated: true, addedMs: 0, interval: raw ? interval(raw.start_ms, raw.end_ms) : null };
    }
    const incoming = interval(start_ms, end_ms);
    const target = exempt ? this.exemptIntervals : this.intervals;
    const existing = target.get(memberId) ?? [];
    const merged = mergeIntervals([...existing, incoming]);
    // 对个人共享预算的真实扣减：公益豁免内容始终为 0。
    const addedMs = exempt ? 0 : totalDuration(merged) - totalDuration(existing);

    const { event } = this.store.append(
      "CONSUMPTION_RECORDED",
      memberId,
      {
        client_record_id,
        device_id,
        product,
        start_ms,
        end_ms,
        claimed_ms: end_ms - start_ms,
        added_ms: addedMs,
        was_offline,
        exempt,
        idempotency_key: idempotency_key ?? client_record_id,
      },
      { occurredAt: at, idempotencyKey: idempotency_key ?? client_record_id },
    );
    return { duplicated: false, addedMs, interval: incoming, merged, event };
  }

  // 离线设备批量恢复联网：逐段归并，产出一份归并报告，整批只算一次增量。
  ingestOfflineBatch(memberId, deviceId, records, { at = null } = {}) {
    const results = [];
    for (const rec of records) {
      const r = this.record(
        memberId,
        { ...rec, device_id: rec.device_id ?? deviceId, was_offline: true },
        { at },
      );
      results.push({ client_record_id: rec.client_record_id, duplicated: r.duplicated, added_ms: r.addedMs });
    }
    const totalAdded = results.reduce((s, r) => s + r.added_ms, 0);
    this.store.append(
      "CROSS_DEVICE_MERGED",
      memberId,
      { device_id: deviceId, records: results, total_added_ms: totalAdded },
      { occurredAt: at },
    );
    return { results, totalAddedMs: totalAdded };
  }

  merged(memberId) {
    return this.intervals.get(memberId) ?? [];
  }

  hasRecord(memberId, clientRecordId) {
    return (this.seenRecords.get(memberId) ?? new Set()).has(clientRecordId);
  }

  // 某自然日窗口内已用毫秒（窗口用绝对时刻给出，调用方按时区算边界）。
  usedInWindow(memberId, windowStartMs, windowEndMs) {
    return durationWithin(this.intervals.get(memberId) ?? [], windowStartMs, windowEndMs);
  }

  // 截至 atMs 的连续使用时长：相邻消费间隔小于 breakMs 视为同一段，
  // 但段内短暂离开（未达到休息时长）不计费——只累加实际区间长度。
  continuousUsage(memberId, atMs, breakMs) {
    const ivs = mergeIntervals(this.intervals.get(memberId) ?? []).filter((iv) => iv.start < atMs);
    if (!ivs.length) return { ms: 0, sinceMs: atMs, deadlineMs: atMs };
    let ms = 0;
    let streakStart = null;
    let lastEnd = null;
    let nextStart = null;
    for (let i = ivs.length - 1; i >= 0; i--) {
      const iv = ivs[i];
      const end = Math.min(iv.end, atMs);
      if (end <= iv.start) continue;
      if (lastEnd === null) {
        // 最近一次使用距现在超过休息时长：连续段已结束。
        if (atMs - end > breakMs) return { ms: 0, sinceMs: atMs, deadlineMs: atMs };
      } else if (nextStart - end > breakMs) {
        break; // 与后一段之间休息足够，连续段到此为止
      }
      ms += end - iv.start;
      streakStart = iv.start;
      lastEnd = end;
      nextStart = iv.start;
    }
    return {
      ms,
      sinceMs: streakStart ?? atMs,
      deadlineMs: lastEnd ?? atMs,
    };
  }
}
