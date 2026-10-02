// 消费记录摄入：可信时间归并的核心。
// - 幂等：同一 (membership_id, record_id) 重传只认第一次，不多扣额度；
// - 可信时间：区间以 UTC 绝对时刻存储，服务端接收时刻约束未来漂移；
// - 设备登记：首次出现的设备会被标记，青少年账号据此触发监护通知。

import { DomainError } from "../core/errors.js";

export const SURFACES = Object.freeze(["short_drama", "live", "novel"]);
export const SURFACE_LABELS = { short_drama: "短剧", live: "直播", novel: "网文" };

// 消耗同一份时间预算的来源：手动播放、短剧自动连播、直播预约、章节解锁、跨设备进度同步。
export const SOURCES = Object.freeze(["manual", "autoplay", "reservation", "chapter_unlock", "progress_sync"]);

const SKEW_TOLERANCE_MS = 10 * 60_000; // 客户端时钟允许的最大未来漂移
const MAX_RECORD_MS = 12 * 3_600_000; // 单条记录时长上限，超出截断并标记

export function recordsOfMembership(store, membershipId) {
  return Object.values(store.state.records).filter((r) => r.membership_id === membershipId);
}

export function ingestRecords(store, clock, membership, raws) {
  if (!Array.isArray(raws) || raws.length === 0) {
    throw new DomainError("validation_failed", "records 必须是非空数组", { status: 400 });
  }
  const nowMs = clock.now().getTime();
  const results = [];
  const newDevices = [];

  for (const raw of raws) {
    results.push(ingestOne(store, membership, raw, nowMs, newDevices));
  }
  return { results, newDevices };
}

function ingestOne(store, membership, raw, nowMs, newDevices) {
  const recordId = raw?.record_id;
  if (typeof recordId !== "string" || !recordId) {
    return { record_id: recordId ?? null, status: "rejected", problems: ["record_id"] };
  }
  const key = `${membership.membership_id}:${recordId}`;
  if (store.state.records[key]) {
    return { record_id: recordId, status: "duplicate" }; // 重传：不重复扣额度
  }

  const problems = [];
  if (!SURFACES.includes(raw.surface)) problems.push("surface");
  if (raw.source != null && !SOURCES.includes(raw.source)) problems.push("source");
  if (typeof raw.device_id !== "string" || !raw.device_id) problems.push("device_id");
  const startMs = Date.parse(raw.started_at);
  const endMs = Date.parse(raw.ended_at);
  if (Number.isNaN(startMs)) problems.push("started_at");
  if (Number.isNaN(endMs)) problems.push("ended_at");
  if (problems.length) return { record_id: recordId, status: "rejected", problems };

  let start = startMs;
  let end = endMs;
  const adjustments = [];

  if (end <= start) {
    return { record_id: recordId, status: "rejected", problems: ["ended_at（须晚于 started_at）"] };
  }
  // 可信时间：整段都在可容忍的未来之外，说明设备时钟不可信，拒绝而非凭空记账。
  if (start > nowMs + SKEW_TOLERANCE_MS) {
    return { record_id: recordId, status: "rejected", problems: ["started_at（超出可信时间范围）"] };
  }
  if (end > nowMs + SKEW_TOLERANCE_MS) {
    end = nowMs + SKEW_TOLERANCE_MS;
    adjustments.push("clamped_future_end");
  }
  if (end - start > MAX_RECORD_MS) {
    end = start + MAX_RECORD_MS;
    adjustments.push("duration_capped");
  }

  const deviceId = raw.device_id;
  const devices = (store.state.devices[membership.membership_id] ??= {});
  const firstSeen = !devices[deviceId];
  if (firstSeen) {
    devices[deviceId] = { first_seen_at: new Date(nowMs).toISOString(), last_seen_at: new Date(nowMs).toISOString() };
    newDevices.push(deviceId);
  } else {
    devices[deviceId].last_seen_at = new Date(nowMs).toISOString();
  }

  const record = {
    record_id: recordId,
    membership_id: membership.membership_id,
    device_id: deviceId,
    surface: raw.surface,
    source: raw.source ?? "manual",
    start_ms: start,
    end_ms: end,
    started_at: new Date(start).toISOString(),
    ended_at: new Date(end).toISOString(),
    adjustments,
    ingested_at: new Date(nowMs).toISOString(),
  };
  store.state.records[key] = record;
  return {
    record_id: recordId,
    status: adjustments.length ? "adjusted" : "accepted",
    adjustments,
    new_device: firstSeen ? deviceId : undefined,
  };
}
