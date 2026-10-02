// 测试公共辅助：固定时钟 + 内存态服务。

import { FixedClock } from "../src/core/clock.js";
import { createService } from "../src/service.js";

export const GUARDIAN = "guardian-1";
export const TZ = "Asia/Shanghai";

export function makeService(startIso = "2026-10-02T21:00:00+08:00") {
  const clock = new FixedClock(startIso);
  const service = createService({ clock });
  return { service, clock };
}

export function makeAdult(service, over = {}) {
  return service.createMembership({ type: "adult", time_zone: TZ, ...over });
}

export function makeTeen(service, over = {}) {
  return service.createMembership({ type: "teen", time_zone: TZ, guardian_id: GUARDIAN, ...over });
}

export function guardianActor() {
  return { actor_id: GUARDIAN, role: "guardian" };
}

export function selfActor(membershipId) {
  return { actor_id: membershipId, role: "self" };
}

// 一份常用约定：22:30–07:00 停用，每日 120 分钟，连续 45 分钟休息 10 分钟。
export function standardAgreement(over = {}) {
  return {
    title: "家庭使用约定",
    blocked_windows: [{ start: "22:30", end: "07:00" }],
    daily_budget_minutes: 120,
    continuous_limit_minutes: 45,
    break_minutes: 10,
    reminder_intensity: "standard",
    ...over,
  };
}

export function rec(over = {}) {
  return {
    record_id: "r1",
    device_id: "phone-1",
    surface: "short_drama",
    source: "manual",
    started_at: "2026-10-02T20:00:00+08:00",
    ended_at: "2026-10-02T20:30:00+08:00",
    ...over,
  };
}
