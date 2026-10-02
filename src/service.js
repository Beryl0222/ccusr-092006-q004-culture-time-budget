// 应用服务：把事件存储、可信时间、账本、约定、审批、画像、引擎装配成一个后端，
// 并提供“离线批量摄入”“心跳锚点”“时间线白话解释”等对外能力。

import { EmergencyReview } from "./approvals.js";
import { AgreementBook, RULES } from "./agreements.js";
import { DecisionEngine } from "./engine.js";
import { Ledger } from "./ledger.js";
import { Members } from "./membership.js";
import { ProfileAndReceipts } from "./profile.js";
import { EventStore } from "./store.js";
import { TrustedTimeline } from "./trusted_time.js";
import { calendarDate, MINUTE_MS, startOfCalendarDay } from "./time.js";

const PRODUCT_LABEL = { LIVE: "直播", SHORT_DRAMA: "短剧", NOVEL: "网文" };
const FEATURE_LABEL = {
  PLAYBACK: "观看",
  LIVE_LINK: "连麦",
  SCHEDULED_NOTIFICATION: "开播预约提醒",
  CHAPTER_UNLOCK: "章节解锁",
  CHAPTER_NOTIFICATION: "章节更新提醒",
  AUTOPLAY: "自动续看",
};

export class CultureTimeService {
  constructor({ filePath = null, clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.store = new EventStore({ filePath, clock });
    this.members = new Members(this.store);
    this.agreements = new AgreementBook(this.store);
    this.ledger = new Ledger(this.store);
    this.approvals = new EmergencyReview(this.store);
    this.profile = new ProfileAndReceipts(this.store);
    this.engine = new DecisionEngine({
      store: this.store,
      members: this.members,
      agreements: this.agreements,
      ledger: this.ledger,
      approvals: this.approvals,
      profile: this.profile,
      clock,
    });
    this.timeline = new TrustedTimeline();
    this.suspicious = []; // 可信时间校验失败、挂起待核对的记录
  }

  // 设备在线心跳：校准设备时钟与服务端时钟。
  heartbeat({ member_id, device_id, device_ms, device_seq = null, at = null }) {
    const serverMs = at ?? this.clock();
    this.timeline.anchor(device_id, serverMs, device_ms, device_seq);
    return { server_ms: serverMs };
  }

  // 在线实时记账：先做判定，再入账。返回判定与记账结果。
  consume(req) {
    const atMs = req.at_ms ?? this.clock();
    const decision = this.engine.evaluate({ ...req, at_ms: atMs });
    let record = null;
    if (decision.action === "ALLOW" && req.duration_ms) {
      // 在线记录同样要过可信时间锚点。
      const attested = this.timeline.attest(req.device_id, {
        device_clock_start: req.device_ms - req.duration_ms,
        device_clock_end: req.device_ms,
        device_seq: req.device_seq ?? 1,
        client_record_id: req.client_record_id,
      });
      if (attested.trusted) {
        record = this.ledger.record(
          req.member_id,
          {
            device_id: req.device_id,
            product: req.product,
            client_record_id: req.client_record_id,
            start_ms: attested.iv.start,
            end_ms: Math.min(attested.iv.end, decision.explanation_data.hard_stop_at_ms ?? attested.iv.end),
            exempt: Boolean(decision.explanation_data.exempt),
          },
          { at: atMs },
        );
        this.timeline.advance(
          req.device_id,
          { device_seq: req.device_seq ?? 1, client_record_id: req.client_record_id },
          attested.iv,
        );
      } else {
        this.suspicious.push({ req: { ...req, at_ms: atMs }, reason: attested.reason });
      }
    }
    this.engine.releaseDueReminders(atMs);
    return { decision, record: record ? { duplicated: record.duplicated, added_ms: record.addedMs } : null };
  }

  // 离线设备恢复联网：按可信时间换算 → 归并入账（幂等，不重复扣）→ 重放被收起的提醒。
  ingestOffline({ member_id, device_id, anchor: anchorRecord, records, at = null }) {
    const serverMs = at ?? this.clock();
    this.timeline.anchor(device_id, serverMs, anchorRecord.device_ms, anchorRecord.device_seq ?? null);
    const accepted = [];
    const rejected = [];
    const duplicates = [];
    for (const rec of records) {
      // 重传先按客户端记录号幂等识别：不多扣额度，也不触发“序号回退”误判。
      if (this.ledger.hasRecord(member_id, rec.client_record_id)) {
        duplicates.push(rec.client_record_id);
        accepted.push({ client_record_id: rec.client_record_id, added_ms: 0, duplicated: true });
        continue;
      }
      const { iv, trusted, reason } = this.timeline.attest(device_id, rec);
      if (!trusted) {
        rejected.push({ client_record_id: rec.client_record_id, reason });
        this.suspicious.push({ member_id, device_id, rec, reason });
        continue;
      }
      const exempt = rec.content_id
        ? Boolean(this.approvals.activeGrant(rec.content_id, iv.start, { liveSessionId: rec.live_session_id ?? null }))
        : false;
      const r = this.ledger.record(member_id, {
        device_id,
        product: rec.product,
        client_record_id: rec.client_record_id,
        start_ms: iv.start,
        end_ms: iv.end,
        was_offline: true,
        exempt,
      });
      this.timeline.advance(device_id, rec, iv);
      accepted.push({ client_record_id: rec.client_record_id, added_ms: r.addedMs, duplicated: r.duplicated, exempt });
    }
    const totalAdded = accepted.reduce((s, r) => s + r.added_ms, 0);
    this.store.append(
      "CROSS_DEVICE_MERGED",
      member_id,
      { device_id: device_id, accepted, rejected, total_added_ms: totalAdded },
      { occurredAt: serverMs },
    );
    const released = this.engine.releaseDueReminders(serverMs);
    return { accepted, rejected, total_added_ms: totalAdded, released_reminders: released };
  }

  // ---------- 账户页：白话时间线 ----------
  // 把一次决策事件翻译成普通用户能看懂的话，并注明来自哪一版约定。
  explainDecision(event) {
    const d = event.payload;
    const data = d.explanation_data ?? {};
    const what = [PRODUCT_LABEL[d.product], FEATURE_LABEL[d.feature]].filter(Boolean).join("的");
    const lines = {
      [RULES.R_WINDOW]: () => {
        const resume = new Date(data.resume_at_ms).toLocaleString("zh-CN", { hour12: false });
        return `你设定的「${data.window.label}（${fmtMin(data.window.from_min)}–${fmtMin(data.window.to_min)}）」正在生效，${what}被暂停；${resume} 之后会自动恢复。`;
      },
      [RULES.R_DAILY_CAP]: () => {
        const resume = new Date(data.resume_at_ms).toLocaleString("zh-CN", { hour12: false });
        return `今天的共享时间预算（${data.cap_ms / MINUTE_MS} 分钟，直播/短剧/网文共用）已经用完，${what}被暂停；${resume} 进入新的一天后恢复。`;
      },
      [RULES.R_CONTINUOUS]: () =>
        `你已经连续使用 ${Math.round(data.continuous_ms / MINUTE_MS)} 分钟，达到约定的连续上限（${data.max_ms / MINUTE_MS} 分钟）。请先休息，${new Date(data.resume_at_ms).toLocaleString("zh-CN", { hour12: false })} 后可继续。`,
      [RULES.R_REMINDER_QUIET]: () =>
        `这条${FEATURE_LABEL[d.feature] ?? "提醒"}撞上了你的停用时段，为了不把你拉回来，已被收起，改在 ${new Date(data.release_at_ms).toLocaleString("zh-CN", { hour12: false })} 发出。`,
      [RULES.R_REMINDER_CAP]: () =>
        `今天的时间预算已经用完，这条${FEATURE_LABEL[d.feature] ?? "提醒"}被延后到明天 ${new Date(data.release_at_ms).toLocaleString("zh-CN", { hour12: false })}，而不是现在打扰你。`,
      REMINDER_SILENT: () => `你把提醒强度设为“免打扰”，这条${FEATURE_LABEL[d.feature] ?? "提醒"}不会弹出（可随时在设置里改回）。`,
      [RULES.R_DEVICE]: () =>
        `这台设备没有被认可（${data.device_reason}）。青少年账号的新设备需要监护人认可后才能使用，已通知监护人。`,
      [RULES.R_EXTENSION]: () => {
        if (data.reason === "NOT_PRE_AUTHORIZED")
          return "这场直播临时延长了，但你事先没有允许“延长时提示续看”，所以不会弹提示把你拉回直播间。";
        if (data.reason === "EXCEEDS_AUTHORIZED_RANGE")
          return `直播延长了 ${Math.round(data.extra_ms / MINUTE_MS)} 分钟，超出你事先允许的 ${data.max_extra_ms / MINUTE_MS} 分钟范围，因此不提示续看。`;
        if (d.action === "PROMPT")
          return `直播临时延长 ${Math.round(data.extra_ms / MINUTE_MS)} 分钟，在你事先允许的 ${data.max_extra_ms / MINUTE_MS} 分钟范围内，向你确认是否续看；你不确认就不会继续播放。`;
        return `直播延长相关的操作被${d.action === "BLOCK" ? "暂停" : "转交监护人"}，原因与你的其他约定一致。`;
      },
      [RULES.R_EMERGENCY]: () => "这是经人工单独审批通过的紧急公益内容，本次观看不占用你的个人时间预算。",
      [RULES.R_EXCEPTION]: () => "本次操作使用了你事先允许的一次例外，约定的限制临时让行。",
    };
    const text = lines[d.rule_code]
      ? lines[d.rule_code]()
      : d.action === "ALLOW"
        ? `本次${what}正常放行。`
        : `本次${what}的处理结果：${d.action}。`;
    return {
      decision_event_id: event.event_id,
      at: event.occurred_at,
      action: d.action,
      rule_code: d.rule_code,
      agreement_version: d.agreement_version,
      product: d.product,
      feature: d.feature,
      text,
    };
  }

  // 会员账户页时间线：决策、延后的提醒、监护通知、续看提示，统一白话。
  accountTimeline(memberId) {
    const member = this.members.get(memberId);
    const isGuardian = member && !member.is_teen;
    const items = [];
    for (const e of this.store.all()) {
      if (e.kind === "DECISION_MADE" && e.subject_id === memberId) {
        items.push({ type: "DECISION", ...this.explainDecision(e) });
      } else if (e.kind === "REMINDER_DEFERRED" && e.subject_id === memberId) {
        items.push({
          type: "REMINDER_RELEASED",
          at: e.occurred_at,
          text: `之前收起的一条提醒已于 ${new Date(e.payload.released_at_ms).toLocaleString("zh-CN", { hour12: false })} 重新发出：${e.payload.reason}。`,
          rule_code: e.payload.rule_code,
        });
      } else if (e.kind === "CONTINUE_PROMPT_SHOWN" && e.subject_id === memberId) {
        const decision = this.store.byId.get(e.payload.decision_event_id);
        items.push({ type: "CONTINUE_PROMPT", ...(decision ? this.explainDecision(decision) : { text: "一次续看确认" }) });
      } else if (e.kind === "GUARDIAN_NOTIFIED") {
        if ((isGuardian && e.subject_id === memberId) || e.payload.teen_id === memberId) {
          items.push({
            type: "GUARDIAN_NOTICE",
            at: e.occurred_at,
            text: `监护通知：${e.payload.summary}（依据约定第 ${e.payload.agreement_version} 版，规则 ${e.payload.rule_code}）。`,
            rule_code: e.payload.rule_code,
            agreement_version: e.payload.agreement_version,
          });
        }
      } else if (e.kind === "PROFILE_WITHDRAWN" && e.subject_id === memberId) {
        items.push({
          type: "PROFILE_WITHDRAWN",
          at: e.occurred_at,
          text: "你已撤销历史画像推断。从这一刻起，新的提醒和判定不再使用这些推断；已完成的付费凭证仍会依法保留备查。",
        });
      }
    }
    items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return items;
  }

  // 某会员当日预算概览（账户页卡片用）。
  budgetToday(memberId, atMs = this.clock()) {
    const member = this.members.get(memberId);
    const agreement = this.agreements.versionAt(memberId, atMs);
    if (!member || !agreement) return null;
    const dayStart = startOfCalendarDay(atMs, agreement.time_zone);
    const nextDay = startOfCalendarDay(dayStart + 25 * MINUTE_MS * 60, agreement.time_zone);
    const used = this.ledger.usedInWindow(memberId, dayStart, nextDay);
    return {
      date: calendarDate(atMs, agreement.time_zone),
      time_zone: agreement.time_zone,
      cap_ms: agreement.daily_cap_ms,
      used_ms: used,
      remaining_ms: Math.max(0, agreement.daily_cap_ms - used),
      by_product: this._usedByProduct(memberId, dayStart, nextDay),
    };
  }

  _usedByProduct(memberId, fromMs, toMs) {
    // 用原始入账记录落在窗口内的 claimed 时长近似分产品（重叠扣减已在总预算里处理）。
    const out = {};
    for (const r of this.ledger.raw.get(memberId) ?? []) {
      const start = Math.max(r.start_ms, fromMs);
      const end = Math.min(r.end_ms, toMs);
      if (end > start) out[r.product] = (out[r.product] ?? 0) + (end - start);
    }
    return out;
  }
}

function fmtMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
