// 约定台账：每个会员的节律约定以“版本”方式发布。
// 任何判定都引用当时生效的版本号，账户页才能说清“这次阻断来自哪条约定”。
// 青少年子账号的约定由监护人发布，published_by 记监护人 id。

import { inLocalWindow } from "./time.js";

export const PRODUCTS = Object.freeze(["LIVE", "SHORT_DRAMA", "NOVEL"]);
// LIVE 直播连麦/预约；SHORT_DRAMA 短剧自动连播；NOVEL 网文章节解锁/提醒。
// 三者共同消耗同一份时间预算。

export const FEATURES = Object.freeze([
  "PLAYBACK", // 观看/阅读正文
  "LIVE_LINK", // 直播连麦
  "SCHEDULED_NOTIFICATION", // 开播预约提醒
  "CHAPTER_UNLOCK", // 章节解锁/自动续章
  "CHAPTER_NOTIFICATION", // 章节更新提醒
  "AUTOPLAY", // 自动连播下一集/下一章
]);

// 规则码：稳定的机器标识，写入 DECISION_MADE 事件；白话文案由账户页映射。
export const RULES = Object.freeze({
  R_WINDOW: "R_WINDOW", // 每日停用时段
  R_DAILY_CAP: "R_DAILY_CAP", // 全天共享时间预算
  R_CONTINUOUS: "R_CONTINUOUS", // 连续使用上限
  R_REMINDER_QUIET: "R_REMINDER_QUIET", // 提醒被停用时段收起
  R_REMINDER_CAP: "R_REMINDER_CAP", // 预算用尽，提醒延后
  R_DEVICE: "R_DEVICE", // 未被认可的设备
  R_EXTENSION: "R_EXTENSION", // 直播延长的事先授权范围
  R_EMERGENCY: "R_EMERGENCY", // 紧急公益单独审批
  R_EXCEPTION: "R_EXCEPTION", // 事先允许的例外
  R_PROFILE: "R_PROFILE", // 画像撤销
  R_REMINDER_RELEASED: "R_REMINDER_RELEASED", // 收起的提醒重新发出
});

export const RULE_LABELS = Object.freeze({
  R_WINDOW: "每日停用时段",
  R_DAILY_CAP: "全天共享时间预算",
  R_CONTINUOUS: "连续使用上限",
  R_REMINDER_QUIET: "提醒被停用时段收起",
  R_REMINDER_CAP: "预算用尽，提醒延后",
  R_DEVICE: "未被认可的设备",
  R_EXTENSION: "直播延长的事先授权范围",
  R_EMERGENCY: "紧急公益单独审批",
  R_EXCEPTION: "你事先允许的例外",
  R_PROFILE: "画像撤销",
  R_REMINDER_RELEASED: "收起的提醒重新发出",
});

function hhmmToMinutes(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

// 规范化一版约定。分钟一律转毫秒存储。
export function normalizeAgreement(input) {
  return {
    time_zone: input.time_zone,
    blocked_windows: (input.blocked_windows ?? []).map((w) => ({
      from_min: hhmmToMinutes(w.from),
      to_min: hhmmToMinutes(w.to),
      label: w.label ?? "停用时段",
    })),
    daily_cap_ms: input.daily_cap_minutes * 60_000,
    continuous: {
      max_ms: input.continuous_max_minutes * 60_000,
      break_ms: (input.continuous_break_minutes ?? 10) * 60_000,
    },
    reminder: {
      level: input.reminder_level ?? "STANDARD",
      defer_ms: (input.reminder_defer_minutes ?? 10) * 60_000,
    },
    // 创作者临时延长直播：只有落在此事先授权范围内才允许“提示续看”。
    extension: {
      allow_prompt: input.extension_allow_prompt ?? false,
      max_extra_ms: (input.extension_max_extra_minutes ?? 0) * 60_000,
    },
  };
}

export class AgreementBook {
  constructor(store) {
    this.store = store;
    this.published = new Map(); // memberId -> [版本...] 按 published_at 升序
    this.exceptions = new Map(); // memberId -> [例外...]
    store.subscribe((e) => this._apply(e));
    for (const e of store.all()) this._apply(e);
  }

  _apply(event) {
    if (event.kind === "AGREEMENT_PUBLISHED") {
      const list = this.published.get(event.subject_id) ?? [];
      list.push({ version: event.payload.version, published_at: event.occurred_at, ...event.payload.agreement });
      list.sort((a, b) => a.published_at.localeCompare(b.published_at));
      this.published.set(event.subject_id, list);
    } else if (event.kind === "EXCEPTION_GRANTED") {
      const list = this.exceptions.get(event.subject_id) ?? [];
      list.push({ granted_at: event.occurred_at, ...event.payload });
      this.exceptions.set(event.subject_id, list);
    }
  }

  draft(memberId, draft, { at = null } = {}) {
    this.store.append("AGREEMENT_DRAFTED", memberId, { draft }, { occurredAt: at });
  }

  // 发布新版本；版本号必须递增。
  publish(memberId, input, { by = null, at = null } = {}) {
    const list = this.published.get(memberId) ?? [];
    const version = (list[list.length - 1]?.version ?? 0) + 1;
    const agreement = normalizeAgreement(input);
    const { event } = this.store.append(
      "AGREEMENT_PUBLISHED",
      memberId,
      { version, agreement, published_by: by ?? memberId },
      { occurredAt: at },
    );
    return event;
  }

  grantException(memberId, exception, { at = null } = {}) {
    const { event } = this.store.append("EXCEPTION_GRANTED", memberId, { ...exception }, { occurredAt: at });
    return event;
  }

  // atMs 时刻生效的约定版本（历史回放：旧判定引用旧版本）。
  versionAt(memberId, atMs) {
    const list = this.published.get(memberId) ?? [];
    const atIso = new Date(atMs).toISOString();
    let current = null;
    for (const v of list) if (v.published_at <= atIso) current = v;
    return current;
  }

  current(memberId) {
    const list = this.published.get(memberId) ?? [];
    return list[list.length - 1] ?? null;
  }

  // 生效中的例外（可指定产品/功能与时间窗）。
  activeExceptions(memberId, atMs, { product = null, feature = null } = {}) {
    const atIso = new Date(atMs).toISOString();
    return (this.exceptions.get(memberId) ?? []).filter((x) => {
      if (x.valid_from > atIso || x.valid_to <= atIso) return false;
      if (product && x.scope?.product && x.scope.product !== product) return false;
      if (feature && x.scope?.feature && x.scope.feature !== feature) return false;
      return x.status !== "REVOKED";
    });
  }

  inBlockedWindow(memberId, atMs) {
    const agreement = this.versionAt(memberId, atMs);
    if (!agreement) return null;
    for (const w of agreement.blocked_windows) {
      if (inLocalWindow(atMs, agreement.time_zone, w.from_min, w.to_min)) return { window: w, agreement };
    }
    return null;
  }
}
