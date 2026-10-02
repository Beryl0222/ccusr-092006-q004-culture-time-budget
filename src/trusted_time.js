// 可信时间：离线设备恢复联网后，不能用设备自己声称的时钟直接记账
// （否则改系统时间就能跨午夜“刷新”预算）。服务端用单调序号 + 服务端接收时刻
// 为每个设备建立“可信时间锚点”，设备上报的区间必须与其锚点链一致。
//
// 设备在离线期间产生的记录携带：
//   device_clock_start/end：设备本地起止时刻（毫秒）
//   device_seq：设备单调序号（每次记录 +1，不回退）
// 服务端按“锚点对齐”换算为服务端可信时刻：
//   服务端可信区间 = 设备区间 + (服务端锚点时刻 - 设备锚点时钟)
// 若设备时钟发生回拨/跳变，则用相邻在线锚点夹逼，夹不进的记录判为不可信。

import { interval } from "./time.js";

// anchors: Map<deviceId, {serverMs, deviceMs, seq}>
export class TrustedTimeline {
  constructor() {
    this.anchors = new Map(); // deviceId -> 最新在线锚点
    this.tail = new Map(); // deviceId -> 最新已接受记录的 { serverEndMs, seq }
  }

  // 设备在线心跳/请求时打点，建立校准锚点。
  anchor(deviceId, serverMs, deviceMs, seq = null) {
    const prev = this.anchors.get(deviceId);
    if (prev && seq !== null && seq < prev.seq) {
      throw new Error("设备可信序号回退，拒绝锚点");
    }
    this.anchors.set(deviceId, { serverMs, deviceMs, seq: seq ?? (prev ? prev.seq : 0) });
  }

  // 把一条设备侧区间换算为服务端可信区间。
  // 返回 { iv, trusted }。trusted=false 时调用方应把记录挂起人工核对，不记账、不扣额度。
  attest(deviceId, record) {
    const anchor = this.anchors.get(deviceId);
    if (!anchor) {
      return { iv: null, trusted: false, reason: "NO_ANCHOR" };
    }
    const offset = anchor.serverMs - anchor.deviceMs;
    const start = record.device_clock_start + offset;
    const end = record.device_clock_end + offset;

    // 基本一致性：时长为正，且不晚于最近一次在线锚点之后过远（离线不可能预知未来）。
    if (end <= start) return { iv: null, trusted: false, reason: "BAD_CLOCK_ORDER" };
    if (start > anchor.serverMs) return { iv: null, trusted: false, reason: "CLOCK_IN_FUTURE" };

    const lastTail = this.tail.get(deviceId);
    if (lastTail) {
      // 序号必须单调；允许同序号重传（幂等）。
      if (record.device_seq < lastTail.seq) return { iv: null, trusted: false, reason: "SEQ_ROLLBACK" };
      // 同一设备新记录的起点不得早于已入账尾部超过 1 分钟（防止把旧时间塞进新窗口）。
      if (record.device_seq === lastTail.seq && record.client_record_id !== lastTail.recordId) {
        return { iv: null, trusted: false, reason: "SEQ_COLLISION" };
      }
    }
    return { iv: interval(start, end), trusted: true, reason: null };
  }

  // 记录入账后推进尾部。
  advance(deviceId, record, iv) {
    this.tail.set(deviceId, {
      seq: record.device_seq,
      serverEndMs: iv.end,
      recordId: record.client_record_id,
    });
  }

  hasTail(deviceId, clientRecordId) {
    const t = this.tail.get(deviceId);
    return Boolean(t && t.recordId === clientRecordId);
  }
}
