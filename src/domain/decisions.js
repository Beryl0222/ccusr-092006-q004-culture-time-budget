// 决策引擎：每次"能否开始/继续观看""提醒是否发送"都经过这里，
// 产出带人话解释的决策。决策只读取当前约定与未撤销的画像。

import { budgetStatus, continuousStretch } from "./budget.js";
import { activeGrantsFor } from "./emergency.js";
import {
  explainBlockedWindow,
  explainBreakRequired,
  explainBudgetExhausted,
  explainDelayedReminder,
  explainEmergency,
  explainNoAgreementTeen,
  explainSuppressedReminder,
} from "./explanations.js";
import { activeInferences } from "./profile.js";
import { effectiveBlockedWindows, appliesToMatches } from "./agreements.js";
import { localDateOf, minutesOfLocalDay, dayStartUtc, weekdayOf } from "../core/timezone.js";

export const REMINDER_KINDS = Object.freeze(["chapter_update", "live_reservation", "live_extension", "follow_up"]);

// 提醒强度决定哪些提醒种类可以发出。
const INTENSITY_KINDS = {
  off: [],
  low: ["live_reservation"],
  standard: ["live_reservation", "chapter_update"],
  high: ["live_reservation", "chapter_update", "live_extension", "follow_up"],
};

export function currentAgreement(store, membershipId) {
  const versions = store.state.agreements[membershipId];
  return versions && versions.length ? versions[versions.length - 1] : null;
}

// now 是否落在（应用例外后的）停用时段内；返回命中的时段与其结束时刻。
export function blockedWindowAt(agreement, tz, now) {
  const ymd = localDateOf(tz, now);
  const weekday = weekdayOf(tz, now);
  const windows = effectiveBlockedWindows(agreement, ymd, weekday);
  if (!windows.length) return null;
  const mins = minutesOfLocalDay(tz, now);
  const dayStartMs = dayStartUtc(tz, ymd).getTime();
  for (const w of windows) {
    const s = Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3, 5));
    const e = Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3, 5));
    let inside = false;
    let untilMinutes = e;
    if (s < e) {
      inside = mins >= s && mins < e;
      untilMinutes = e;
    } else {
      // 跨午夜时段：如 22:30–07:00
      inside = mins >= s || mins < e;
      untilMinutes = mins >= s ? e + 1440 : e;
    }
    if (inside) {
      return { window: w, untilUtc: new Date(dayStartMs + untilMinutes * 60_000) };
    }
  }
  return null;
}

function surfaceExempt(agreement, surface, ymd, weekday) {
  return (agreement?.exceptions ?? []).some(
    (ex) => ex.type === "surface_exempt" && ex.surface === surface && appliesToMatches(ex.applies_to, ymd, weekday),
  );
}

// 会话决策：ALLOW 或 BLOCK（blocked_window / budget_exhausted / break_required / agreement_missing）。
export function evaluateSession(ctx, membership, { surface, contentRef = null }) {
  const now = ctx.clock.now();
  const agreement = currentAgreement(ctx.store, membership.membership_id);
  const grants = contentRef ? activeGrantsFor(ctx.store, now, contentRef) : [];
  const emergencyOverride = grants.some((g) => g.override_hard_blocks);

  if (!agreement) {
    if (membership.type === "teen") {
      return { kind: "BLOCK", reason: "agreement_missing", explanation: explainNoAgreementTeen(), used_inferences: [] };
    }
    return { kind: "ALLOW", reason: "no_agreement", remaining_seconds: null, used_inferences: [] };
  }

  if (emergencyOverride) {
    const grant = grants.find((g) => g.override_hard_blocks);
    return {
      kind: "ALLOW",
      reason: "emergency_override",
      emergency: true,
      explanation: explainEmergency({ grant }),
      used_inferences: [],
    };
  }

  const tz = membership.time_zone;
  const ymd = localDateOf(tz, now);
  const weekday = weekdayOf(tz, now);

  const hit = blockedWindowAt(agreement, tz, now);
  if (hit && !surfaceExempt(agreement, surface, ymd, weekday)) {
    return {
      kind: "BLOCK",
      reason: "blocked_window",
      explanation: explainBlockedWindow({
        agreement,
        membership,
        window: hit.window,
        untilUtc: hit.untilUtc,
        surface,
        now,
      }),
      used_inferences: [],
    };
  }

  const budget = budgetStatus(ctx.store, membership, agreement, now);
  if (budget.remaining_seconds != null && budget.remaining_seconds <= 0) {
    return {
      kind: "BLOCK",
      reason: "budget_exhausted",
      explanation: explainBudgetExhausted({ agreement, membership, budget, surface }),
      used_inferences: [],
    };
  }

  if (agreement.continuous_limit_minutes != null) {
    const stretch = continuousStretch(ctx.store, membership.membership_id, now.getTime(), agreement.session_gap_minutes);
    const limitMs = agreement.continuous_limit_minutes * 60_000;
    if (stretch.active && stretch.continuous_ms >= limitMs) {
      const breakUntil = new Date(Math.max(stretch.last_end_ms, now.getTime()) + agreement.break_minutes * 60_000);
      return {
        kind: "BLOCK",
        reason: "break_required",
        explanation: explainBreakRequired({
          agreement,
          membership,
          breakUntil,
          limitMinutes: agreement.continuous_limit_minutes,
          surface,
        }),
        used_inferences: [],
      };
    }
  }

  return {
    kind: "ALLOW",
    reason: "within_agreement",
    remaining_seconds: budget.remaining_seconds,
    local_date: budget.local_date,
    used_inferences: [],
  };
}

// 提醒决策：SEND_NOW / DELAY / SUPPRESS。紧急公益内容（已审批）直接送达。
export function evaluateReminder(ctx, membership, reminder) {
  const now = ctx.clock.now();
  const agreement = currentAgreement(ctx.store, membership.membership_id);
  const grants = reminder.content_ref ? activeGrantsFor(ctx.store, now, reminder.content_ref) : [];

  if (grants.length) {
    return {
      kind: "SEND_NOW",
      reason: "emergency_grant",
      explanation: explainEmergency({ grant: grants[0] }),
      used_inferences: [],
    };
  }

  const intensity = agreement?.reminder_intensity ?? "standard";
  if (!INTENSITY_KINDS[intensity]?.includes(reminder.kind)) {
    return {
      kind: "SUPPRESS",
      reason: "intensity",
      explanation: explainSuppressedReminder({ agreement, reminder, intensity }),
      used_inferences: [],
    };
  }

  if (agreement) {
    const tz = membership.time_zone;
    const hit = blockedWindowAt(agreement, tz, now);
    const ymd = localDateOf(tz, now);
    const weekday = weekdayOf(tz, now);
    if (hit && !surfaceExempt(agreement, reminder.surface, ymd, weekday)) {
      return {
        kind: "DELAY",
        reason: "blocked_window",
        deliver_at: hit.untilUtc.toISOString(),
        explanation: explainDelayedReminder({ agreement, membership, reminder, untilUtc: hit.untilUtc }),
        used_inferences: [],
      };
    }
  }

  // 个性化只使用未撤销的画像推断；撤销后这里恒为空。
  const matched = activeInferences(ctx.store, membership.membership_id).filter((i) => i.surface === reminder.surface);
  const used = matched.slice(0, 1).map((i) => i.inference_id);
  return {
    kind: "SEND_NOW",
    reason: "within_agreement",
    used_inferences: used,
    preview: used.length ? `根据你的兴趣：${matched[0].label}` : null,
  };
}
