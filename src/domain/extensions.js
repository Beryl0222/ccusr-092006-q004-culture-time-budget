// 直播延长：创作者临时延长直播时，只有落在用户"事先允许的续看范围"内
// 才提示续看；范围外一律不打扰，但留下可解释的抑制记录。
// 紧急公益内容不走这里，走 emergency 的单独审批。

import { DomainError, forbidden, notFound } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { minutesOfLocalDay } from "../core/timezone.js";
import { parseHhmm } from "./agreements.js";

export function createLive(store, clock, input) {
  const problems = [];
  if (typeof input?.creator_id !== "string" || !input.creator_id) problems.push("creator_id");
  if (typeof input?.title !== "string" || !input.title.trim()) problems.push("title");
  const endMs = Date.parse(input?.scheduled_end_at);
  if (Number.isNaN(endMs)) problems.push("scheduled_end_at");
  if (problems.length) {
    throw new DomainError("validation_failed", `直播字段校验未通过：${problems.join("、")}`, {
      status: 400,
      details: { problems },
    });
  }
  const live = {
    live_id: newId("live"),
    creator_id: input.creator_id,
    title: input.title.trim(),
    scheduled_end_at: new Date(endMs).toISOString(),
    scheduled_end_ms: endMs,
    created_at: clock.now().toISOString(),
  };
  store.state.lives[live.live_id] = live;
  return live;
}

export function reserveLive(store, clock, liveId, membershipId) {
  const live = store.state.lives[liveId];
  if (!live) throw notFound("直播", liveId);
  const list = (store.state.reservations[liveId] ??= []);
  if (!list.includes(membershipId)) list.push(membershipId);
  return { live_id: liveId, membership_id: membershipId, reserved_at: clock.now().toISOString() };
}

// 用户事先设定的续看允许范围：可按创作者限定，含最大延长分钟与本地截止时刻。
export function addContinuationAllowance(store, clock, membershipId, input, actor) {
  const problems = [];
  const maxExtra = input?.max_extra_minutes;
  if (!Number.isInteger(maxExtra) || maxExtra < 1 || maxExtra > 240) problems.push("max_extra_minutes");
  if (input?.not_after != null && parseHhmm(input.not_after) == null) problems.push("not_after");
  if (problems.length) {
    throw new DomainError("validation_failed", `续看范围校验未通过：${problems.join("、")}`, {
      status: 400,
      details: { problems },
    });
  }
  const allowance = {
    allowance_id: newId("alw"),
    membership_id: membershipId,
    creator_id: input.creator_id ?? null,
    max_extra_minutes: maxExtra,
    not_after: input.not_after ?? null,
    label:
      typeof input.label === "string" && input.label.trim()
        ? input.label.trim()
        : `允许续看最多 ${maxExtra} 分钟${input.not_after ? `，且不晚于 ${input.not_after}` : ""}`,
    created_at: clock.now().toISOString(),
    created_by: actor?.actor_id ?? membershipId,
  };
  (store.state.allowances[membershipId] ??= []).push(allowance);
  return allowance;
}

// 判断某次延长是否落在该授权范围内。
export function allowanceCovers(allowance, live, newEndMs, membership) {
  if (allowance.creator_id && allowance.creator_id !== live.creator_id) {
    return { covers: false, reason: "该延长不属于你授权的创作者" };
  }
  const extensionMinutes = Math.round((newEndMs - live.scheduled_end_ms) / 60_000);
  if (extensionMinutes > allowance.max_extra_minutes) {
    return { covers: false, reason: `超出你允许的续看上限 ${allowance.max_extra_minutes} 分钟`, allowance };
  }
  if (allowance.not_after) {
    const localMinutes = minutesOfLocalDay(membership.time_zone, new Date(newEndMs));
    if (localMinutes > parseHhmm(allowance.not_after)) {
      return { covers: false, reason: `结束时间晚于你设定的 ${allowance.not_after}`, allowance };
    }
  }
  return { covers: true, allowance };
}

// 创作者发起延长：逐预约用户评估是否提示续看。
export function requestExtension(store, clock, liveId, actor, input) {
  const live = store.state.lives[liveId];
  if (!live) throw notFound("直播", liveId);
  if (actor?.actor_id !== live.creator_id) {
    throw forbidden("只有本场直播的创作者可以发起延长");
  }
  const newEndMs = Date.parse(input?.new_end_at);
  if (Number.isNaN(newEndMs) || newEndMs <= live.scheduled_end_ms) {
    throw new DomainError("validation_failed", "new_end_at 须晚于原定结束时间", { status: 400 });
  }
  const request = {
    extension_id: newId("ext"),
    live_id: liveId,
    creator_id: live.creator_id,
    new_end_at: new Date(newEndMs).toISOString(),
    new_end_ms: newEndMs,
    reason: typeof input.reason === "string" ? input.reason : "",
    created_at: clock.now().toISOString(),
  };
  const extensionMinutes = Math.round((newEndMs - live.scheduled_end_ms) / 60_000);
  const outcomes = [];
  for (const membershipId of store.state.reservations[liveId] ?? []) {
    const membership = store.state.memberships[membershipId];
    if (!membership) continue;
    const allowances = store.state.allowances[membershipId] ?? [];
    let decision = null;
    for (const alw of allowances) {
      const verdict = allowanceCovers(alw, live, newEndMs, membership);
      if (verdict.covers) {
        decision = { prompted: true, allowance: alw };
        break;
      }
      decision = decision ?? { prompted: false, reason: verdict.reason, allowance: verdict.allowance ?? null };
    }
    if (!decision) decision = { prompted: false, reason: "你尚未设置任何续看允许范围", allowance: null };
    outcomes.push({ membership_id: membershipId, ...decision });
  }
  return { request, extensionMinutes, outcomes, live };
}
