// 解释生成器：把每次阻断、延后提醒、监护通知翻译成普通用户能看懂的话，
// 并且明确引用"来自哪条约定"（agreement_id + clause_id + 谁设定的）。

import { localParts } from "../core/timezone.js";
import { summarizeClauses } from "./agreements.js";
import { SURFACE_LABELS } from "./consumption.js";

export function surfaceLabel(surface) {
  return SURFACE_LABELS[surface] ?? surface;
}

function fmtLocal(tz, date) {
  const p = localParts(tz, date);
  return `${p.month}月${p.day}日 ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function fmtHm(tz, date) {
  const p = localParts(tz, date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

// 从约定中挑出指定条款，附上约定标识，供账户页展示出处。
export function clauseRefs(agreement, clauseIds) {
  if (!agreement) return [];
  const all = summarizeClauses(agreement);
  return all
    .filter((c) => clauseIds.includes(c.clause_id))
    .map((c) => ({
      agreement_id: agreement.agreement_id,
      agreement_version: agreement.version,
      agreement_title: agreement.title,
      ...c,
    }));
}

function remedyFor(agreement, extra) {
  const who = agreement?.created_by?.role === "guardian" ? "监护人" : "本人";
  const base =
    who === "监护人" ? "如需调整，请联系监护人在账户页修改约定。" : "如需调整，可在账户页修改约定。";
  return extra ? `${extra}${base}` : base;
}

export function explainBlockedWindow({ agreement, membership, window, untilUtc, surface, now }) {
  const tz = membership.time_zone;
  return {
    headline: `现在处于停用时段，${surfaceLabel(surface)}暂时不能继续`,
    detail:
      `当前时间 ${fmtHm(tz, now)} 处于每日 ${window.start}–${window.end} 的停用时段内；` +
      `短剧、直播、网文共用同一份约定。停用时段将于 ${fmtLocal(tz, untilUtc)} 结束。`,
    clauses: clauseRefs(agreement, ["blocked_windows"]),
    facts: {
      surface,
      local_time: fmtHm(tz, now),
      blocked_until: untilUtc.toISOString(),
      blocked_until_local: fmtLocal(tz, untilUtc),
    },
    remedy: remedyFor(agreement, `也可以等到 ${fmtLocal(tz, untilUtc)} 之后再使用。`),
  };
}

export function explainBudgetExhausted({ agreement, membership, budget, surface }) {
  const minutes = Math.round((budget.budget_seconds ?? 0) / 60);
  return {
    headline: "今天的共用时长已经用完",
    detail:
      `约定每日总时长 ${minutes} 分钟，短剧、直播、网文以及你的所有设备共同消耗这一份时间。` +
      `今天（${budget.local_date}）已用 ${Math.round(budget.consumed_seconds / 60)} 分钟。`,
    clauses: clauseRefs(agreement, ["daily_budget"]),
    facts: {
      surface,
      local_date: budget.local_date,
      budget_seconds: budget.budget_seconds,
      consumed_seconds: budget.consumed_seconds,
    },
    remedy: remedyFor(agreement, "本地时间过午夜后会恢复额度。"),
  };
}

export function explainBreakRequired({ agreement, membership, breakUntil, limitMinutes, surface }) {
  const tz = membership.time_zone;
  return {
    headline: `已连续使用 ${limitMinutes} 分钟，需要休息一下`,
    detail:
      `约定连续使用 ${limitMinutes} 分钟后需休息 ${agreement.break_minutes} 分钟。` +
      `将于 ${fmtLocal(tz, breakUntil)} 恢复。`,
    clauses: clauseRefs(agreement, ["continuous_limit"]),
    facts: { surface, break_until: breakUntil.toISOString(), break_until_local: fmtLocal(tz, breakUntil) },
    remedy: remedyFor(agreement),
  };
}

export function explainNoAgreementTeen() {
  return {
    headline: "青少年账号需要先由监护人设定约定",
    detail: "这个账号是青少年子账号，监护人还没有设定任何使用约定，因此暂时不能使用。",
    clauses: [],
    facts: {},
    remedy: "请监护人在账户页创建约定后再试。",
  };
}

export function explainDelayedReminder({ agreement, membership, reminder, untilUtc }) {
  const tz = membership.time_zone;
  return {
    headline: `这条提醒已延后到 ${fmtLocal(tz, untilUtc)}`,
    detail:
      `为遵守每日停用时段约定，${surfaceLabel(reminder.surface)}的${reminderKindLabel(reminder.kind)}` +
      "不会在此刻打扰你，将在停用时段结束后送达。",
    clauses: clauseRefs(agreement, ["blocked_windows"]),
    facts: { reminder_kind: reminder.kind, deliver_at: untilUtc.toISOString() },
    remedy: remedyFor(agreement),
  };
}

export function explainSuppressedReminder({ agreement, reminder, intensity }) {
  return {
    headline: "这条提醒按你的提醒强度设置未发送",
    detail: `当前提醒强度为"${intensity}"，${reminderKindLabel(reminder.kind)}不在发送范围内。`,
    clauses: agreement ? clauseRefs(agreement, ["reminder_intensity"]) : [],
    facts: { reminder_kind: reminder.kind, intensity },
    remedy: remedyFor(agreement),
  };
}

export function explainGuardianNotice({ agreement, teen, trigger, detail }) {
  return {
    headline: "已按约定通知监护人",
    detail,
    clauses: clauseRefs(agreement, ["blocked_windows", "daily_budget", "continuous_limit"]),
    facts: { teen_membership_id: teen.membership_id, trigger },
    remedy: "如对约定有疑问，可与监护人沟通，由监护人在账户页调整。",
  };
}

export function explainExtensionPrompted({ allowance, live, extensionMinutes }) {
  return {
    headline: `你预约的直播延长了 ${extensionMinutes} 分钟，可以继续观看`,
    detail: `《${live.title}》的延长在你事先允许的续看范围内（${allowance.label}），因此为你提示。`,
    clauses: [
      {
        clause_id: `allowance:${allowance.allowance_id}`,
        label: allowance.label,
        set_by: "本人",
        set_at: allowance.created_at,
      },
    ],
    facts: { live_id: live.live_id, extension_minutes: extensionMinutes },
    remedy: "续看仍会正常消耗你的每日共用时长。",
  };
}

export function explainExtensionSuppressed({ live, extensionMinutes, reason, allowance }) {
  const clauses = allowance
    ? [
        {
          clause_id: `allowance:${allowance.allowance_id}`,
          label: allowance.label,
          set_by: "本人",
          set_at: allowance.created_at,
        },
      ]
    : [];
  return {
    headline: "直播延长了，但未提示你续看",
    detail: `《${live.title}》延长 ${extensionMinutes} 分钟，${reason}，因此没有打扰你。`,
    clauses,
    facts: { live_id: live.live_id, extension_minutes: extensionMinutes },
    remedy: "如需接收此类提示，可在账户页调整续看允许范围。",
  };
}

export function explainEmergency({ grant }) {
  return {
    headline: "这是一条经过审批的紧急公益内容",
    detail: `《${grant.title}》已通过单独审批（${grant.approvals.length} 名审批人），在 ${grant.ends_at} 前不受停用时段与提醒强度限制。`,
    clauses: [
      {
        clause_id: `grant:${grant.grant_id}`,
        label: `紧急公益内容审批：${grant.title}`,
        set_by: "平台审批",
        set_at: grant.created_at,
      },
    ],
    facts: { grant_id: grant.grant_id, content_ref: grant.content_ref },
    remedy: "此类内容不影响你的约定本身，审批到期后自动恢复原有限制。",
  };
}

export function reminderKindLabel(kind) {
  return (
    {
      chapter_update: "章节更新提醒",
      live_reservation: "预约直播提醒",
      live_extension: "直播延长提醒",
      follow_up: "后续提醒",
    }[kind] ?? kind
  );
}
