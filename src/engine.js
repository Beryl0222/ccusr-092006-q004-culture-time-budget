// 决策引擎：所有产品（直播、短剧、网文）的所有动作都在这里被同一套规则判定。
// 每次判定落一条 DECISION_MADE 事件，引用约定版本与规则码，
// 账户页凭它给出白话解释，而不是各端各自解释。

import { RULES } from "./agreements.js";
import {
  calendarDate,
  localMinutes,
  startOfCalendarDay,
  wallTimeInstant,
  windowExitInstant,
} from "./time.js";

const MINUTE = 60_000;

// 提醒类功能统一走通知判定。
const NOTIFICATION_FEATURES = new Set(["SCHEDULED_NOTIFICATION", "CHAPTER_NOTIFICATION"]);

function fmtTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export class DecisionEngine {
  constructor({ store, members, agreements, ledger, approvals, profile, clock = () => Date.now() }) {
    this.store = store;
    this.members = members;
    this.agreements = agreements;
    this.ledger = ledger;
    this.approvals = approvals;
    this.profile = profile;
    this.clock = clock;
    this.heldReminders = new Map(); // reminderId -> 持有记录
    this.prompts = new Map(); // promptId -> 续看提示
    store.subscribe((e) => this._project(e));
    for (const e of store.all()) this._project(e);
  }

  _project(event) {
    if (event.kind === "REMINDER_HELD") {
      this.heldReminders.set(event.payload.reminder_id, { held_at: event.occurred_at, ...event.payload });
    } else if (event.kind === "REMINDER_DEFERRED") {
      this.heldReminders.delete(event.payload.reminder_id);
    } else if (event.kind === "CONTINUE_PROMPT_SHOWN") {
      this.prompts.set(event.payload.prompt_id, { shown_at: event.occurred_at, ...event.payload });
    } else if (event.kind === "CONTINUE_PROMPT_CHOSEN") {
      const p = this.prompts.get(event.payload.prompt_id);
      if (p) p.choice = event.payload.choice;
    }
  }

  // ---------- 主入口 ----------
  evaluate(request) {
    const atMs = request.at_ms ?? this.clock();
    if (NOTIFICATION_FEATURES.has(request.feature)) return this._evaluateReminder(request, atMs);
    return this._evaluateAccess(request, atMs);
  }

  // 观看/连麦/连播/解锁等“真正消耗时间预算”的请求。
  _evaluateAccess(req, atMs) {
    const member = this.members.get(req.member_id);
    if (!member) return this._decide(req, atMs, null, "BLOCK", "UNKNOWN_MEMBER", {});

    // 1) 设备门：青少年在未认可设备上直接升级给监护人，不能绕开。
    const deviceCheck = this.members.isDeviceAllowed(req.member_id, req.device_id);
    if (!deviceCheck.ok) {
      const versionAt = this.agreements.versionAt(req.member_id, atMs)?.version ?? null;
      const d = this._decide(req, atMs, versionAt, "ESCALATE", RULES.R_DEVICE, {
        device_reason: deviceCheck.reason,
        device_id: req.device_id,
      });
      if (member.is_teen) this._notifyGuardian(req.member_id, d, atMs, "孩子尝试在一台未被认可的设备上使用");
      return d;
    }

    const agreement = this.agreements.versionAt(req.member_id, atMs);
    if (!agreement) return this._decide(req, atMs, null, "ALLOW", null, { note: "尚无约定，默认放行" });

    // 2) 紧急公益：持有效豁免单则放行，且不占个人预算。
    if (req.content_id) {
      const grant = this.approvals.activeGrant(req.content_id, atMs, { liveSessionId: req.live_session_id ?? null });
      if (grant) {
        return this._decide(req, atMs, agreement.version, "ALLOW", RULES.R_EMERGENCY, {
          grant_id: grant.grant_id,
          exempt: true,
        });
      }
    }

    // 生效例外按规则码决定能让行哪一条约定；"*" 表示全部。
    const exceptions = this.agreements.activeExceptions(req.member_id, atMs, {
      product: req.product,
      feature: req.feature,
    });
    const exceptionOverrides = (code) =>
      exceptions.some(
        (x) =>
          !x.rule_codes ||
          x.rule_codes.length === 0 ||
          x.rule_codes.includes("*") ||
          x.rule_codes.includes(code),
      );

    // 3) 停用时段
    const inWindow = this.agreements.inBlockedWindow(req.member_id, atMs);
    if (inWindow && !exceptionOverrides(RULES.R_WINDOW)) {
      const releaseAt = windowExitInstant(
        atMs,
        agreement.time_zone,
        inWindow.window.from_min,
        inWindow.window.to_min,
      );
      return this._decide(req, atMs, agreement.version, "BLOCK", RULES.R_WINDOW, {
        window: inWindow.window,
        resume_at_ms: releaseAt,
      });
    }

    // 4) 全天共享预算
    const tz = agreement.time_zone;
    const dayStart = startOfCalendarDay(atMs, tz);
    const nextDay = startOfCalendarDay(dayStart + 25 * 60 * MINUTE, tz);
    const used = this.ledger.usedInWindow(req.member_id, dayStart, nextDay);
    const remaining = agreement.daily_cap_ms - used;
    if (remaining <= 0 && !exceptionOverrides(RULES.R_DAILY_CAP)) {
      return this._decide(req, atMs, agreement.version, "BLOCK", RULES.R_DAILY_CAP, {
        used_ms: used,
        cap_ms: agreement.daily_cap_ms,
        resume_at_ms: nextDay,
      });
    }

    // 5) 连续使用上限
    const streak = this.ledger.continuousUsage(req.member_id, atMs, agreement.continuous.break_ms);
    if (streak.ms >= agreement.continuous.max_ms && !exceptionOverrides(RULES.R_CONTINUOUS)) {
      return this._decide(req, atMs, agreement.version, "BLOCK", RULES.R_CONTINUOUS, {
        continuous_ms: streak.ms,
        max_ms: agreement.continuous.max_ms,
        resume_at_ms: streak.deadlineMs + agreement.continuous.break_ms,
      });
    }

    // 6) 放行，并算出“硬性停止时刻”：停用时段起点 / 预算耗尽 / 连续上限，取最早。
    const capStop = remaining > 0 ? atMs + remaining : null;
    const continuousStop = streak.sinceMs + agreement.continuous.max_ms;
    let hardStop = capStop === null ? continuousStop : Math.min(capStop, continuousStop);
    for (const w of agreement.blocked_windows) {
      const enterAt = this._nextWindowEntry(atMs, tz, w.from_min, w.to_min);
      if (enterAt !== null) hardStop = Math.min(hardStop, enterAt);
    }
    return this._decide(req, atMs, agreement.version, "ALLOW", exceptions.length ? RULES.R_EXCEPTION : null, {
      remaining_ms: Math.max(0, remaining),
      hard_stop_at_ms: hardStop,
      via_exception: exceptions.length > 0,
    });
  }

  // 预约/章节提醒：不能把人在停用时段或预算耗尽时拉回来。
  _evaluateReminder(req, atMs) {
    const member = this.members.get(req.member_id);
    if (!member) return this._decide(req, atMs, null, "BLOCK", "UNKNOWN_MEMBER", {});
    const deviceCheck = this.members.isDeviceAllowed(req.member_id, req.device_id);
    if (!deviceCheck.ok) {
      const versionAt = this.agreements.versionAt(req.member_id, atMs)?.version ?? null;
      const d = this._decide(req, atMs, versionAt, "HOLD", RULES.R_DEVICE, {
        device_reason: deviceCheck.reason,
        device_id: req.device_id,
      });
      if (member.is_teen) this._notifyGuardian(req.member_id, d, atMs, "孩子在一台未被认可的设备上预约了提醒");
      return d;
    }
    const agreement = this.agreements.versionAt(req.member_id, atMs);
    if (!agreement) return this._decide(req, atMs, null, "ALLOW", null, {});

    // 事先允许的例外可按规则码让行提醒约束。
    const reminderExceptions = this.agreements.activeExceptions(req.member_id, atMs, {
      product: req.product,
      feature: req.feature,
    });
    const overrides = (code) =>
      reminderExceptions.some(
        (x) => !x.rule_codes || x.rule_codes.length === 0 || x.rule_codes.includes("*") || x.rule_codes.includes(code),
      );
    const hasException = reminderExceptions.length > 0;

    // 个性化（例如“按你常看的习惯”推荐）只能使用未被撤销的画像推断。
    let personalization = null;
    if (req.personalization_key) {
      const hit = this.profile.activeInferences(req.member_id, atMs).find((i) => i.key === req.personalization_key);
      if (hit) personalization = { key: hit.key, value: hit.value };
    }
    const reminderMeta = { personalization, reminder_level: agreement.reminder.level };

    // SILENT：免打扰，不弹也不补发；STRICT：保护不可被用户跳过；SOFT：可手动提前。
    if (agreement.reminder.level === "SILENT" && !hasException) {
      return this._holdReminder(req, atMs, agreement, null, "SILENT", reminderMeta);
    }

    const inWindow = this.agreements.inBlockedWindow(req.member_id, atMs);
    if (inWindow && !overrides(RULES.R_REMINDER_QUIET)) {
      const releaseAt = windowExitInstant(
        atMs,
        agreement.time_zone,
        inWindow.window.from_min,
        inWindow.window.to_min,
      );
      return this._holdReminder(req, atMs, agreement, releaseAt, RULES.R_REMINDER_QUIET, {
        window: inWindow.window,
        ...reminderMeta,
      });
    }
    const dayStart = startOfCalendarDay(atMs, agreement.time_zone);
    const nextDay = startOfCalendarDay(dayStart + 25 * 60 * MINUTE, agreement.time_zone);
    const used = this.ledger.usedInWindow(req.member_id, dayStart, nextDay);
    if (used >= agreement.daily_cap_ms && !overrides(RULES.R_REMINDER_CAP)) {
      // 今天时间预算已用完：延后到明天，而不是现在把人拉回来。
      return this._holdReminder(req, atMs, agreement, nextDay, RULES.R_REMINDER_CAP, {
        resume_at_ms: nextDay,
        ...reminderMeta,
      });
    }
    const decision = this._decide(req, atMs, agreement.version, "ALLOW", hasException ? RULES.R_EXCEPTION : null, {
      personalization,
      reminder_level: agreement.reminder.level,
      profile_withdrawn:
        Boolean(req.personalization_key) && this.profile.isWithdrawn(req.member_id, atMs),
      via_exception: hasException,
    });
    return decision;
  }

  _holdReminder(req, atMs, agreement, releaseAtMs, ruleCode, extra = {}) {
    const reminderId = req.reminder_id ?? `rm_${req.member_id}_${atMs}_${req.feature}`;
    const decision = this._decide(
      req,
      atMs,
      agreement.version,
      releaseAtMs === null ? "HOLD" : "DEFER",
      releaseAtMs === null ? "REMINDER_SILENT" : ruleCode,
      { reminder_id: reminderId, release_at_ms: releaseAtMs, ...extra },
    );
    this.store.append("REMINDER_HELD", req.member_id, {
      reminder_id: reminderId,
      member_id: req.member_id,
      product: req.product,
      feature: req.feature,
      title: req.title ?? "",
      held_at_ms: atMs,
      release_at_ms: releaseAtMs,
      rule_code: decision.rule_code,
      agreement_version: agreement.version,
      decision_event_id: decision.event_id,
      quiet: releaseAtMs === null,
    });
    decision.reminder_id = reminderId;
    return decision;
  }

  // 被收起的提醒到点释放（恢复联网或窗口结束时调用）。
  releaseDueReminders(atMs = this.clock()) {
    const released = [];
    for (const [id, held] of this.heldReminders) {
      if (held.quiet || held.release_at_ms === null || held.release_at_ms > atMs) continue;
      this.store.append("REMINDER_DEFERRED", held.member_id, {
        reminder_id: id,
        original_held_at_ms: held.held_at_ms,
        released_at_ms: atMs,
        rule_code: RULES.R_REMINDER_RELEASED,
        reason: "停用时段结束或预算进入新的一天，收起的提醒现在发出",
      });
      released.push(id);
    }
    return released;
  }

  // SOFT 强度的提醒允许用户手动提前取出；SILENT/STANDARD/STRICT 不允许。
  releaseReminderEarly(reminderId, atMs = this.clock()) {
    const held = this.heldReminders.get(reminderId);
    if (!held) return { ok: false, reason: "NOT_HELD" };
    if (held.quiet) return { ok: false, reason: "SILENT_CANNOT_RELEASE" };
    const agreement = this.agreements.versionAt(held.member_id, atMs);
    if (agreement?.reminder.level !== "SOFT") {
      return { ok: false, reason: "ONLY_SOFT_MAY_RELEASE_EARLY", level: agreement?.reminder.level };
    }
    this.store.append("REMINDER_DEFERRED", held.member_id, {
      reminder_id: reminderId,
      original_held_at_ms: held.held_at_ms,
      released_at_ms: atMs,
      rule_code: RULES.R_REMINDER_RELEASED,
      reason: "你选择了“现在提醒我”（柔和提醒可提前取出）",
      early: true,
    });
    return { ok: true };
  }

  // ---------- 直播延长：续看提示 ----------
  // 创作者临时延长直播时调用。只有用户“事先允许”的范围才允许出现续看提示。
  evaluateContinuePrompt({ member_id, device_id, live_session_id, planned_end_ms, new_end_ms, at_ms = null }) {
    const atMs = at_ms ?? this.clock();
    const agreement = this.agreements.versionAt(member_id, atMs);
    const base = { member_id, device_id, product: "LIVE", feature: "AUTOPLAY", at_ms: atMs };
    if (!agreement || !agreement.extension.allow_prompt) {
      return this._decide(base, atMs, agreement?.version ?? null, "BLOCK", RULES.R_EXTENSION, {
        reason: "NOT_PRE_AUTHORIZED",
      });
    }
    const extraMs = new_end_ms - planned_end_ms;
    if (extraMs <= 0) {
      return this._decide(base, atMs, agreement.version, "ALLOW", null, { note: "直播未延长" });
    }
    if (extraMs > agreement.extension.max_extra_ms) {
      return this._decide(base, atMs, agreement.version, "BLOCK", RULES.R_EXTENSION, {
        reason: "EXCEEDS_AUTHORIZED_RANGE",
        extra_ms: extraMs,
        max_extra_ms: agreement.extension.max_extra_ms,
      });
    }
    // 提示本身仍受设备门与停用时段约束：不能在睡眠时段把人拉回。
    const access = this._evaluateAccess(
      { member_id, device_id, product: "LIVE", feature: "PLAYBACK", at_ms: atMs },
      atMs,
    );
    if (access.action === "BLOCK" || access.action === "ESCALATE") {
      return this._decide(base, atMs, agreement.version, access.action, access.rule_code, {
        nested: access.explanation_data,
      });
    }
    const promptId = `cp_${live_session_id}_${atMs}`;
    const decision = this._decide(base, atMs, agreement.version, "PROMPT", RULES.R_EXTENSION, {
      prompt_id: promptId,
      live_session_id,
      extra_ms: extraMs,
      max_extra_ms: agreement.extension.max_extra_ms,
      hard_stop_at_ms: access.explanation_data.hard_stop_at_ms,
    });
    this.store.append("CONTINUE_PROMPT_SHOWN", member_id, {
      prompt_id: promptId,
      live_session_id,
      planned_end_ms,
      new_end_ms,
      extra_ms: extraMs,
      decision_event_id: decision.event_id,
    });
    decision.prompt_id = promptId;
    return decision;
  }

  choosePrompt(memberId, promptId, choice, { at = null } = {}) {
    return this.store.append(
      "CONTINUE_PROMPT_CHOSEN",
      memberId,
      { prompt_id: promptId, choice }, // ACCEPT / DISMISS
      { occurredAt: at },
    ).event;
  }

  // ---------- 内部工具 ----------
  _nextWindowEntry(atMs, timeZone, fromMin, toMin) {
    const date = calendarDate(atMs, timeZone);
    const today = wallTimeInstant(timeZone, date, fromMin);
    if (fromMin < toMin) return today > atMs ? today : wallTimeInstant(timeZone, this._nextDate(date), fromMin);
    // 跨午夜窗口：今天的起点若已过，明早到今晚的窗口起点其实仍是“今晚 fromMin”
    return today > atMs ? today : wallTimeInstant(timeZone, this._nextDate(date), fromMin);
  }

  _nextDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }

  _decide(req, atMs, agreementVersion, action, ruleCode, data) {
    const { event } = this.store.append(
      "DECISION_MADE",
      req.member_id,
      {
        action,
        rule_code: ruleCode,
        agreement_version: agreementVersion,
        product: req.product ?? null,
        feature: req.feature,
        device_id: req.device_id ?? null,
        at_ms: atMs,
        explanation_data: data,
      },
      { occurredAt: atMs },
    );
    return {
      action,
      rule_code: ruleCode,
      agreement_version: agreementVersion,
      event_id: event.event_id,
      explanation_data: data,
    };
  }

  _notifyGuardian(teenId, decision, atMs, plainSummary) {
    const teen = this.members.get(teenId);
    if (!teen?.guardian_id) return null;
    return this.store.append(
      "GUARDIAN_NOTIFIED",
      teen.guardian_id,
      {
        teen_id: teenId,
        rule_code: decision.rule_code,
        action: decision.action,
        agreement_version: decision.agreement_version,
        summary: plainSummary,
        decision_event_id: decision.event_id,
        device_id: decision.explanation_data?.device_id ?? null,
      },
      { occurredAt: atMs },
    ).event;
  }
}

export { fmtTime };
