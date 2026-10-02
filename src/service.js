// 应用服务：编排领域模块，落库干预/通知/事件，供 HTTP 层与测试调用。
// 账户页需要的"这次干预来自哪条约定"全部由这里的解释字段承载。

import { DomainError, forbidden, notFound, validation } from "./core/errors.js";
import { newId } from "./core/ids.js";
import { isValidTimeZone, localDateOf, weekdayOf, dayStartUtc } from "./core/timezone.js";
import {
  isLooser,
  makeAgreement,
  summarizeClauses,
  validateAgreementInput,
} from "./domain/agreements.js";
import { budgetStatus, effectiveBudgetMinutes, usageForLocalDay } from "./domain/budget.js";
import { ingestRecords, SURFACES } from "./domain/consumption.js";
import { currentAgreement, evaluateReminder, evaluateSession, REMINDER_KINDS } from "./domain/decisions.js";
import { createGrant } from "./domain/emergency.js";
import {
  explainExtensionPrompted,
  explainExtensionSuppressed,
  explainGuardianNotice,
} from "./domain/explanations.js";
import {
  addContinuationAllowance,
  createLive,
  requestExtension,
  reserveLive,
} from "./domain/extensions.js";
import {
  addInference,
  activeInferences,
  latestWithdrawal,
  requireMembership,
  withdrawProfile,
} from "./domain/profile.js";
import { issueReceipt, verifyReceipt } from "./domain/receipts.js";
import { createStore } from "./store/store.js";

export function createService({ clock, persistence } = {}) {
  const store = createStore(persistence);
  const ctx = { store, clock };

  // ---- 基础设施 ----

  function emit(kind, subjectId, payload) {
    const event = {
      event_id: newId("evt"),
      kind,
      occurred_at: clock.now().toISOString(),
      subject_id: subjectId,
      payload,
    };
    store.state.events.push(event);
    return event;
  }

  function addIntervention(membershipId, kind, explanation, meta = {}) {
    const intervention = {
      intervention_id: newId("itv"),
      membership_id: membershipId,
      kind,
      occurred_at: clock.now().toISOString(),
      explanation,
      meta,
    };
    store.state.interventions.push(intervention);
    return intervention;
  }

  function addNotification(recipientKind, recipientId, type, title, body, extra = {}) {
    const notification = {
      notification_id: newId("ntf"),
      recipient_kind: recipientKind,
      recipient_id: recipientId,
      type,
      title,
      body,
      created_at: clock.now().toISOString(),
      ...extra,
    };
    store.state.notifications.push(notification);
    return notification;
  }

  // 青少年账号的监护通知：同步记入孩子的干预记录，账户页可见"这次通知来自哪条约定"。
  function notifyGuardian(teen, trigger, detail, agreement) {
    if (teen.type !== "teen" || !teen.guardian_id) return null;
    const explanation = explainGuardianNotice({ agreement, teen, trigger, detail });
    const notification = addNotification("guardian", teen.guardian_id, "GUARDIAN_ALERT", explanation.headline, detail, {
      explanation,
      teen_membership_id: teen.membership_id,
    });
    addIntervention(teen.membership_id, "guardian_notification", explanation, { trigger });
    emit("GUARDIAN_NOTIFIED", teen.membership_id, { trigger, guardian_id: teen.guardian_id });
    return notification;
  }

  // ---- 会员与约定 ----

  function createMembership(input) {
    const problems = [];
    if (!["adult", "teen"].includes(input?.type)) problems.push("type（adult|teen）");
    if (!isValidTimeZone(input?.time_zone ?? "")) problems.push("time_zone");
    if (input?.guardian_id != null && typeof input.guardian_id !== "string") problems.push("guardian_id");
    if (problems.length) throw validation(problems);
    const membership = {
      membership_id: input.membership_id ?? newId("mbr"),
      type: input.type,
      time_zone: input.time_zone,
      guardian_id: input.guardian_id ?? null,
      display_name: typeof input.display_name === "string" ? input.display_name : null,
      created_at: clock.now().toISOString(),
      profile_withdrawals: [],
    };
    store.state.memberships[membership.membership_id] = membership;
    store.save();
    return membership;
  }

  function updateMembership(membershipId, patch) {
    const membership = requireMembership(store, membershipId);
    if (patch.time_zone != null) {
      if (!isValidTimeZone(patch.time_zone)) throw validation(["time_zone"]);
      membership.time_zone = patch.time_zone; // 只改日界归属，历史区间是 UTC 绝对时刻，不增不减
    }
    if (patch.guardian_id !== undefined) membership.guardian_id = patch.guardian_id;
    if (patch.display_name !== undefined) membership.display_name = patch.display_name;
    store.save();
    return membership;
  }

  function setAgreement(membershipId, actor, input) {
    const membership = requireMembership(store, membershipId);
    const problems = validateAgreementInput(input);
    if (problems.length) throw validation(problems);
    if (!actor || typeof actor.actor_id !== "string" || !["self", "guardian"].includes(actor.role)) {
      throw validation(["actor（须含 actor_id 与 role: self|guardian）"]);
    }
    if (actor.role === "guardian" && membership.guardian_id !== actor.actor_id) {
      throw forbidden("操作者不是该账号登记的监护人");
    }
    if (actor.role === "self" && actor.actor_id !== membershipId) {
      throw forbidden("只能操作本人账号的约定");
    }
    const versions = (store.state.agreements[membershipId] ??= []);
    const current = versions[versions.length - 1] ?? null;

    if (membership.type === "teen") {
      // 青少年子账号：只能由监护人设定；本人仅可收紧，不得放宽。
      if (actor.role !== "guardian") {
        if (!current) throw forbidden("青少年账号的首份约定须由监护人设定");
        const candidate = makeAgreement({ membershipId, actor, input, version: current.version + 1, now: clock.now() });
        if (isLooser(current, candidate)) {
          throw forbidden("青少年账号不能自行放宽约定，请联系监护人");
        }
        versions.push(candidate);
        emit("BUDGET_SET", membershipId, { agreement_id: candidate.agreement_id, version: candidate.version, role: actor.role });
        store.save();
        return candidate;
      }
    } else if (actor.role !== "self" || actor.actor_id !== membershipId) {
      throw forbidden("成年账号的约定只能由本人设定");
    }

    const agreement = makeAgreement({ membershipId, actor, input, version: (current?.version ?? 0) + 1, now: clock.now() });
    versions.push(agreement);
    emit("BUDGET_SET", membershipId, { agreement_id: agreement.agreement_id, version: agreement.version, role: actor.role });
    store.save();
    return agreement;
  }

  // ---- 消费摄入与预算 ----

  function ingestConsumption(membershipId, raws) {
    const membership = requireMembership(store, membershipId);
    const { results, newDevices } = ingestRecords(store, clock, membership, raws);
    for (const r of results) {
      if (r.status === "accepted" || r.status === "adjusted") {
        emit("CONSUMPTION_RECORDED", membershipId, { record_id: r.record_id, status: r.status });
      }
    }
    // 青少年换设备绕开限制：预算本来就在服务端按账号归并，同时把新设备告知监护人。
    for (const deviceId of newDevices) {
      if (membership.type === "teen") {
        notifyGuardian(
          membership,
          "new_device",
          `孩子在一台新设备（${deviceId}）上开始使用。时长仍按账号统一计算，换设备不会获得额外额度。`,
          currentAgreement(store, membershipId),
        );
      }
    }
    store.save();
    return { results };
  }

  function getBudget(membershipId, date = null) {
    const membership = requireMembership(store, membershipId);
    const agreement = currentAgreement(store, membershipId);
    const now = clock.now();
    const ymd = date ?? localDateOf(membership.time_zone, now);
    const status = budgetStatus(store, membership, agreement, now);
    if (ymd !== status.local_date) {
      // 查询非今天：按当天日界重算用量，预算分钟数按当日例外计算（星期取当地正午，避免时区偏移误判）。
      const usage = usageForLocalDay(store, membership, ymd);
      const localNoon = new Date(dayStartUtc(membership.time_zone, ymd).getTime() + 12 * 3_600_000);
      const minutes = effectiveBudgetMinutes(agreement, ymd, weekdayOf(membership.time_zone, localNoon));
      const budgetSeconds = minutes == null ? null : minutes * 60;
      return {
        local_date: ymd,
        budget_seconds: budgetSeconds,
        consumed_seconds: usage.consumed_seconds,
        remaining_seconds: budgetSeconds == null ? null : budgetSeconds - usage.consumed_seconds,
      };
    }
    return status;
  }

  // ---- 决策 ----

  function checkSession(membershipId, input) {
    const membership = requireMembership(store, membershipId);
    if (!SURFACES.includes(input?.surface)) throw validation(["surface"]);
    const decision = evaluateSession(ctx, membership, { surface: input.surface, contentRef: input.content_ref ?? null });
    if (decision.kind === "BLOCK") {
      const intervention = addIntervention(membershipId, "block", decision.explanation, {
        surface: input.surface,
        reason: decision.reason,
      });
      emit("LIMIT_REACHED", membershipId, { reason: decision.reason, surface: input.surface });
      if (membership.type === "teen") {
        notifyGuardian(
          membership,
          decision.reason,
          `孩子于 ${intervention.occurred_at} 尝试使用${input.surface === "live" ? "直播" : input.surface === "novel" ? "网文" : "短剧"}被阻止：${decision.explanation.headline}。`,
          currentAgreement(store, membershipId),
        );
      }
      return { ...decision, intervention_id: intervention.intervention_id };
    }
    return decision;
  }

  function planReminder(membershipId, reminder) {
    const membership = requireMembership(store, membershipId);
    const problems = [];
    if (!REMINDER_KINDS.includes(reminder?.kind)) problems.push("kind");
    if (!SURFACES.includes(reminder?.surface)) problems.push("surface");
    if (problems.length) throw validation(problems);

    const decision = evaluateReminder(ctx, membership, reminder);
    if (decision.kind === "SEND_NOW") {
      const n = addNotification("membership", membershipId, "REMINDER", reminder.title ?? "你有一条新提醒", reminder.body ?? "", {
        explanation: decision.explanation ?? null,
        used_inferences: decision.used_inferences,
        deliver_at: clock.now().toISOString(),
      });
      return { ...decision, notification_id: n.notification_id };
    }
    if (decision.kind === "DELAY") {
      const n = addNotification("membership", membershipId, "DELAYED_REMINDER", reminder.title ?? "你有一条新提醒", reminder.body ?? "", {
        explanation: decision.explanation,
        deliver_at: decision.deliver_at,
        used_inferences: [],
      });
      addIntervention(membershipId, "delayed_reminder", decision.explanation, { reminder_kind: reminder.kind });
      emit("REMINDER_DELAYED", membershipId, { reminder_kind: reminder.kind, deliver_at: decision.deliver_at });
      return { ...decision, notification_id: n.notification_id };
    }
    addIntervention(membershipId, "suppressed_reminder", decision.explanation, { reminder_kind: reminder.kind });
    return decision;
  }

  // ---- 直播延长 ----

  function requestLiveExtension(liveId, actor, input) {
    const { request, extensionMinutes, outcomes, live } = requestExtension(store, clock, liveId, actor, input);
    let prompted = 0;
    let suppressed = 0;
    for (const outcome of outcomes) {
      if (outcome.prompted) {
        prompted += 1;
        const explanation = explainExtensionPrompted({ allowance: outcome.allowance, live, extensionMinutes });
        addNotification("membership", outcome.membership_id, "EXTENSION_PROMPT", explanation.headline, explanation.detail, {
          explanation,
        });
        emit("EXCEPTION_REVIEWED", outcome.membership_id, { extension_id: request.extension_id, decision: "prompted" });
      } else {
        suppressed += 1;
        const explanation = explainExtensionSuppressed({
          live,
          extensionMinutes,
          reason: outcome.reason,
          allowance: outcome.allowance,
        });
        addIntervention(outcome.membership_id, "suppressed_extension_prompt", explanation, {
          extension_id: request.extension_id,
        });
        emit("EXCEPTION_REVIEWED", outcome.membership_id, { extension_id: request.extension_id, decision: "suppressed" });
      }
    }
    store.save();
    return { ...request, extension_minutes: extensionMinutes, prompted, suppressed, outcomes };
  }

  // ---- 紧急公益审批 ----

  function createEmergencyGrant(input) {
    const grant = createGrant(store, clock, input);
    emit("EMERGENCY_GRANTED", grant.grant_id, { content_ref: grant.content_ref, override_hard_blocks: grant.override_hard_blocks });
    store.save();
    return grant;
  }

  // ---- 画像与凭证 ----

  function withdraw(membershipId, actor) {
    const membership = requireMembership(store, membershipId);
    const result = withdrawProfile(store, clock, membership, actor);
    emit("PROFILE_WITHDRAWN", membershipId, { withdrawn_count: result.withdrawn_count });
    store.save();
    return result;
  }

  function issue(input) {
    const receipt = issueReceipt(store, clock, input);
    emit("RECEIPT_ISSUED", input.membership_id, { receipt_id: receipt.receipt_id, amount: receipt.amount, currency: receipt.currency });
    store.save();
    return receipt;
  }

  // ---- 账户页 ----

  function getAccountPage(membershipId) {
    const membership = requireMembership(store, membershipId);
    const agreement = currentAgreement(store, membershipId);
    const now = clock.now();
    const budget = budgetStatus(store, membership, agreement, now);
    const interventions = store.state.interventions
      .filter((i) => i.membership_id === membershipId)
      .slice(-50)
      .reverse();
    const notifications = store.state.notifications
      .filter((n) => n.recipient_kind === "membership" && n.recipient_id === membershipId)
      .slice(-50)
      .reverse();
    return {
      membership: {
        membership_id: membership.membership_id,
        type: membership.type,
        time_zone: membership.time_zone,
        guardian_id: membership.guardian_id,
      },
      now: now.toISOString(),
      today: budget,
      agreement: agreement
        ? {
            agreement_id: agreement.agreement_id,
            version: agreement.version,
            title: agreement.title,
            clauses: summarizeClauses(agreement),
          }
        : null,
      interventions,
      notifications,
      profile: {
        active_inferences: activeInferences(store, membershipId).length,
        last_withdrawal: latestWithdrawal(membership),
      },
    };
  }

  function listGuardianNotifications(guardianId) {
    return store.state.notifications
      .filter((n) => n.recipient_kind === "guardian" && n.recipient_id === guardianId)
      .slice()
      .reverse();
  }

  return {
    store,
    clock,
    // 会员
    createMembership,
    updateMembership,
    getMembership: (id) => requireMembership(store, id),
    setAgreement,
    getCurrentAgreement: (id) => currentAgreement(store, id),
    // 消费与预算
    ingestConsumption,
    getBudget,
    // 决策
    checkSession,
    planReminder,
    // 直播
    createLive: (input) => {
      const live = createLive(store, clock, input);
      store.save();
      return live;
    },
    reserveLive: (liveId, membershipId) => {
      const r = reserveLive(store, clock, liveId, membershipId);
      store.save();
      return r;
    },
    addContinuationAllowance: (membershipId, input, actor) => {
      requireMembership(store, membershipId);
      const a = addContinuationAllowance(store, clock, membershipId, input, actor);
      store.save();
      return a;
    },
    requestLiveExtension,
    // 紧急审批
    createEmergencyGrant,
    listEmergencyGrants: () => Object.values(store.state.grants),
    // 画像与凭证
    addInference: (membershipId, input) => {
      requireMembership(store, membershipId);
      const inf = addInference(store, clock, membershipId, input);
      store.save();
      return inf;
    },
    withdrawProfile: withdraw,
    issueReceipt: issue,
    verifyReceipt: (receiptId) => verifyReceipt(store, receiptId),
    // 账户页与通知
    getAccountPage,
    listGuardianNotifications,
    listEvents: () => store.state.events,
  };
}
