// 约定（Agreement）：用户或监护人设定的一版控制约定，作用于同一会员体系。
// 包含：每日停用时段、每日共用预算、连续使用上限、提醒强度、允许例外。
// 约定按版本追加，永不修改历史版本——账户页解释需要引用"当时那条约定"。

import { newId } from "../core/ids.js";

export const REMINDER_INTENSITIES = Object.freeze(["off", "low", "standard", "high"]);
const INTENSITY_RANK = { off: 0, low: 1, standard: 2, high: 3 };
export const INTENSITY_LABELS = {
  off: "关闭（不发送任何提醒）",
  low: "低（仅你主动预约的直播）",
  standard: "标准（预约直播与追更章节）",
  high: "高（包含后续提醒）",
};

export const EXCEPTION_TYPES = Object.freeze(["window_relax", "surface_exempt", "budget_bonus"]);

export function parseHhmm(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof text === "string" ? text : "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isYmd(text) {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text);
}

// 例外/规则的适用条件：不填表示每天适用。
export function appliesToMatches(appliesTo, ymd, weekday) {
  if (!appliesTo) return true;
  const { dates, weekdays } = appliesTo;
  if (!dates && !weekdays) return true;
  if (dates && dates.includes(ymd)) return true;
  if (weekdays && weekdays.includes(weekday)) return true;
  return false;
}

export function validateAgreementInput(input) {
  const problems = [];
  if (input == null || typeof input !== "object") return ["body"];
  const b = input;

  if (b.title != null && typeof b.title !== "string") problems.push("title");

  if (b.daily_budget_minutes != null) {
    if (!Number.isInteger(b.daily_budget_minutes) || b.daily_budget_minutes < 1 || b.daily_budget_minutes > 1440) {
      problems.push("daily_budget_minutes");
    }
  }

  if (b.blocked_windows != null) {
    if (!Array.isArray(b.blocked_windows)) {
      problems.push("blocked_windows");
    } else {
      b.blocked_windows.forEach((w, i) => {
        const s = parseHhmm(w?.start);
        const e = parseHhmm(w?.end);
        if (s == null || e == null) problems.push(`blocked_windows[${i}]`);
        else if (s === e) problems.push(`blocked_windows[${i}]（起止相同）`);
      });
    }
  }

  if (b.continuous_limit_minutes != null) {
    if (!Number.isInteger(b.continuous_limit_minutes) || b.continuous_limit_minutes < 5 || b.continuous_limit_minutes > 720) {
      problems.push("continuous_limit_minutes");
    }
    if (b.break_minutes == null) problems.push("break_minutes（设置连续上限时必填）");
  }
  if (b.break_minutes != null) {
    if (!Number.isInteger(b.break_minutes) || b.break_minutes < 1 || b.break_minutes > 120) {
      problems.push("break_minutes");
    }
  }
  const gap = b.session_gap_minutes ?? 5;
  if (!Number.isInteger(gap) || gap < 1 || gap > 60) problems.push("session_gap_minutes");
  if (b.continuous_limit_minutes != null && b.break_minutes != null && b.break_minutes <= gap) {
    problems.push("break_minutes（须大于 session_gap_minutes，否则休息无法生效）");
  }

  if (b.reminder_intensity != null && !REMINDER_INTENSITIES.includes(b.reminder_intensity)) {
    problems.push("reminder_intensity");
  }

  if (b.exceptions != null) {
    if (!Array.isArray(b.exceptions)) {
      problems.push("exceptions");
    } else {
      b.exceptions.forEach((ex, i) => {
        if (!EXCEPTION_TYPES.includes(ex?.type)) {
          problems.push(`exceptions[${i}].type`);
          return;
        }
        if (ex.type === "window_relax" && parseHhmm(ex.relaxed_start) == null) {
          problems.push(`exceptions[${i}].relaxed_start`);
        }
        if (ex.type === "surface_exempt" && typeof ex.surface !== "string") {
          problems.push(`exceptions[${i}].surface`);
        }
        if (ex.type === "budget_bonus" && (!Number.isInteger(ex.minutes) || ex.minutes < 1 || ex.minutes > 720)) {
          problems.push(`exceptions[${i}].minutes`);
        }
        const at = ex.applies_to;
        if (at != null) {
          if (at.dates != null && (!Array.isArray(at.dates) || !at.dates.every(isYmd))) {
            problems.push(`exceptions[${i}].applies_to.dates`);
          }
          if (at.weekdays != null && (!Array.isArray(at.weekdays) || !at.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
            problems.push(`exceptions[${i}].applies_to.weekdays`);
          }
        }
      });
    }
  }
  return problems;
}

export function makeAgreement({ membershipId, actor, input, version, now }) {
  return {
    agreement_id: newId("agr"),
    membership_id: membershipId,
    version,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "使用约定",
    created_at: now.toISOString(),
    created_by: { actor_id: actor.actor_id, role: actor.role }, // role: "self" | "guardian"
    daily_budget_minutes: input.daily_budget_minutes ?? null,
    blocked_windows: (input.blocked_windows ?? []).map((w) => ({ start: w.start, end: w.end })),
    continuous_limit_minutes: input.continuous_limit_minutes ?? null,
    break_minutes: input.break_minutes ?? null,
    session_gap_minutes: input.session_gap_minutes ?? 5,
    reminder_intensity: input.reminder_intensity ?? "standard",
    exceptions: (input.exceptions ?? []).map((ex) => ({
      exception_id: ex.exception_id ?? newId("exc"),
      label: typeof ex.label === "string" ? ex.label : "",
      type: ex.type,
      applies_to: ex.applies_to ?? null,
      relaxed_start: ex.relaxed_start ?? null,
      surface: ex.surface ?? null,
      minutes: ex.minutes ?? null,
    })),
  };
}

// 应用 window_relax 例外后的有效停用时段（只放宽起点，不缩紧）。
export function effectiveBlockedWindows(agreement, ymd, weekday) {
  const base = agreement?.blocked_windows ?? [];
  const relaxes = (agreement?.exceptions ?? []).filter(
    (ex) => ex.type === "window_relax" && appliesToMatches(ex.applies_to, ymd, weekday),
  );
  return base
    .map((w) => {
      let start = w.start;
      for (const r of relaxes) {
        const relaxed = parseHhmm(r.relaxed_start);
        const current = parseHhmm(start);
        if (relaxed != null && current != null && relaxed > current) start = r.relaxed_start;
      }
      return { ...w, start };
    })
    .filter((w) => parseHhmm(w.start) !== parseHhmm(w.end));
}

// 在 48 小时画布上计算停用时段覆盖的分钟集合，用于"是否变松"判定。
function coverageSet(windows) {
  const cov = new Array(2880).fill(false);
  for (const w of windows) {
    const s = parseHhmm(w.start);
    const e = parseHhmm(w.end);
    if (s == null || e == null || s === e) continue;
    if (s < e) {
      for (let i = s; i < e; i += 1) cov[i] = true;
    } else {
      for (let i = s; i < 1440; i += 1) cov[i] = true;
      for (let i = 0; i < e; i += 1) cov[1440 + i] = true;
    }
  }
  return cov;
}

// 判断 next 是否比 prev 更宽松。青少年子账号不得自行放宽，只能收紧。
export function isLooser(prev, next) {
  if (prev.daily_budget_minutes != null) {
    if (next.daily_budget_minutes == null || next.daily_budget_minutes > prev.daily_budget_minutes) return true;
  }
  const prevCov = coverageSet(prev.blocked_windows ?? []);
  const nextCov = coverageSet(next.blocked_windows ?? []);
  for (let i = 0; i < 2880; i += 1) {
    if (prevCov[i] && !nextCov[i]) return true;
  }
  if (prev.continuous_limit_minutes != null) {
    if (next.continuous_limit_minutes == null || next.continuous_limit_minutes > prev.continuous_limit_minutes) return true;
    const prevBreak = prev.break_minutes ?? 0;
    const nextBreak = next.break_minutes ?? 0;
    if (nextBreak < prevBreak) return true;
  }
  if (INTENSITY_RANK[next.reminder_intensity ?? "standard"] < INTENSITY_RANK[prev.reminder_intensity ?? "standard"]) {
    return true;
  }
  const prevExIds = new Set((prev.exceptions ?? []).map((e) => e.exception_id));
  if ((next.exceptions ?? []).some((e) => !prevExIds.has(e.exception_id))) return true;
  return false;
}

// 账户页用的"人话"条款摘要。每条都有稳定 clause_id，干预解释按 id 引用。
export function summarizeClauses(agreement) {
  const setBy = agreement.created_by.role === "guardian" ? "监护人" : "本人";
  const setAt = agreement.created_at;
  const clauses = [];
  const windows = agreement.blocked_windows ?? [];
  clauses.push({
    clause_id: "blocked_windows",
    label: windows.length
      ? `每日 ${windows.map((w) => `${w.start}–${w.end}`).join("、")} 停用`
      : "未设停用时段",
    set_by: setBy,
    set_at: setAt,
  });
  clauses.push({
    clause_id: "daily_budget",
    label:
      agreement.daily_budget_minutes != null
        ? `每日总时长 ${agreement.daily_budget_minutes} 分钟（短剧、直播、网文及各设备共用一份）`
        : "不限每日总时长",
    set_by: setBy,
    set_at: setAt,
  });
  clauses.push({
    clause_id: "continuous_limit",
    label:
      agreement.continuous_limit_minutes != null
        ? `连续使用 ${agreement.continuous_limit_minutes} 分钟后需休息 ${agreement.break_minutes} 分钟`
        : "不限制连续使用时长",
    set_by: setBy,
    set_at: setAt,
  });
  clauses.push({
    clause_id: "reminder_intensity",
    label: `提醒强度：${INTENSITY_LABELS[agreement.reminder_intensity] ?? agreement.reminder_intensity}`,
    set_by: setBy,
    set_at: setAt,
  });
  for (const ex of agreement.exceptions ?? []) {
    clauses.push({
      clause_id: `exception:${ex.exception_id}`,
      label: ex.label || describeException(ex),
      set_by: setBy,
      set_at: setAt,
    });
  }
  return clauses;
}

function describeException(ex) {
  if (ex.type === "window_relax") return `例外：适用日期停用时段推迟到 ${ex.relaxed_start} 开始`;
  if (ex.type === "surface_exempt") return `例外：${ex.surface} 不受停用时段限制`;
  if (ex.type === "budget_bonus") return `例外：适用日期每日时长增加 ${ex.minutes} 分钟`;
  return `例外：${ex.type}`;
}
