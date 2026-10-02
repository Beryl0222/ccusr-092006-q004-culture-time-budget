import assert from "node:assert/strict";
import test from "node:test";

import { CultureTimeService } from "../src/service.js";
import { MINUTE_MS as T } from "../src/time.js";

const DAY = 24 * 60 * T;

function baseAgreement(over = {}) {
  return {
    time_zone: "Asia/Shanghai",
    blocked_windows: [{ from: "22:00", to: "06:00", label: "睡前停用" }],
    daily_cap_minutes: 120,
    continuous_max_minutes: 90,
    continuous_break_minutes: 10,
    reminder_level: "STANDARD",
    reminder_defer_minutes: 10,
    extension_allow_prompt: true,
    extension_max_extra_minutes: 30,
    ...over,
  };
}

function setup(initial = Date.parse("2026-09-20T12:00:00+08:00")) {
  const ctl = { t: initial };
  const svc = new CultureTimeService({ clock: () => ctl.t });
  return { svc, ctl };
}

function onboard(svc, memberId, { teen = false, guardian = null, devices = ["dev1"], agreement = baseAgreement() } = {}) {
  if (teen && guardian && !svc.members.get(guardian)) {
    svc.members.register(guardian, { is_teen: false, time_zone: agreement.time_zone, at: svc.clock() });
  }
  svc.members.register(memberId, { is_teen: teen, guardian_id: guardian, time_zone: agreement.time_zone, at: svc.clock() });
  if (teen && guardian) svc.members.linkTeen(memberId, guardian, { at: svc.clock() });
  for (const d of devices) {
    svc.members.registerDevice(memberId, d, { approved: true, approvedBy: guardian, at: svc.clock() });
    svc.heartbeat({ member_id: memberId, device_id: d, device_ms: svc.clock(), device_seq: 0, at: svc.clock() });
  }
  svc.agreements.publish(memberId, agreement, { by: guardian ?? memberId, at: svc.clock() });
}

// 用离线摄入记账（区间以服务端绝对时刻给出，设备时钟与服务端一致）。
// 恢复时刻取最后一段消费结束之后：离线记录不可能晚于恢复时点。
const seqs = new Map();
function record(svc, memberId, deviceId, segs) {
  const next = (seqs.get(deviceId) ?? 0) + 1;
  seqs.set(deviceId, next + segs.length);
  const recoverAt = Math.max(svc.clock(), ...segs.map((x) => x.end)) + 1000;
  return svc.ingestOffline({
    member_id: memberId,
    device_id: deviceId,
    anchor: { device_ms: recoverAt, device_seq: 10_000 + next + segs.length },
    records: segs.map((s, i) => ({
      client_record_id: s.id,
      product: s.product ?? "SHORT_DRAMA",
      content_id: s.content_id,
      live_session_id: s.live_session_id,
      device_clock_start: s.start,
      device_clock_end: s.end,
      device_seq: next + i,
    })),
    at: recoverAt,
  });
}

test("直播、短剧、网文共用一份预算；跨设备重叠只扣一次", () => {
  const { svc } = setup();
  onboard(svc, "u1", { devices: ["dev1", "dev2"] });
  const t = svc.clock();
  const r = record(svc, "u1", "dev1", [
    { id: "a", product: "LIVE", start: t, end: t + 30 * T },
  ]);
  assert.equal(r.total_added_ms, 30 * T);
  // dev2 同时段看短剧（重叠 20 分钟）+ 网文 10 分钟
  const r2 = record(
    svc,
    "u1",
    "dev2",
    [
      { id: "b", product: "SHORT_DRAMA", start: t + 10 * T, end: t + 30 * T },
      { id: "c", product: "NOVEL", start: t + 30 * T, end: t + 40 * T },
    ],
    { seqStart: 20 },
  );
  assert.equal(r2.total_added_ms, 10 * T); // 重叠 20 分钟不重复扣，只新增 10 分钟
  const budget = svc.budgetToday("u1");
  assert.equal(budget.used_ms, 40 * T);
});

test("睡前停用时段：短剧硬停，开播提醒被收起并在次日 06:00 补发", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1");
  now.t = Date.parse("2026-09-20T22:30:00+08:00");
  const block = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "SHORT_DRAMA",
    feature: "PLAYBACK",
  });
  assert.equal(block.action, "BLOCK");
  assert.equal(block.rule_code, "R_WINDOW");
  assert.equal(block.explanation_data.resume_at_ms, Date.parse("2026-09-21T06:00:00+08:00"));

  const rm = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "LIVE",
    feature: "SCHEDULED_NOTIFICATION",
    reminder_id: "rm-1",
    title: "主播开播了",
  });
  assert.equal(rm.action, "DEFER");

  // 23:00 还不能发
  assert.deepEqual(svc.engine.releaseDueReminders(Date.parse("2026-09-20T23:00:00+08:00")), []);
  // 次日 06:00 释放
  const released = svc.engine.releaseDueReminders(Date.parse("2026-09-21T06:00:00+08:00"));
  assert.deepEqual(released, ["rm-1"]);
});

test("全天预算用尽后阻断，跨午夜进入新一天自动恢复", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ daily_cap_minutes: 60 }) });
  now.t = Date.parse("2026-09-20T20:00:00+08:00");
  record(svc, "u1", "dev1", [{ id: "x", start: now.t, end: now.t + 60 * T }]);
  now.t = Date.parse("2026-09-20T21:30:00+08:00");
  const blocked = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_UNLOCK",
  });
  assert.equal(blocked.action, "BLOCK");
  assert.equal(blocked.rule_code, "R_DAILY_CAP");
  // 跨午夜后恢复（即使设备仍连着）
  now.t = Date.parse("2026-09-21T06:30:00+08:00");
  const allowed = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_UNLOCK",
  });
  assert.equal(allowed.action, "ALLOW");
});

test("连续使用达到上限后必须休息；短于休息时长的离开不重置", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T10:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ continuous_max_minutes: 50, continuous_break_minutes: 10 }) });
  now.t = Date.parse("2026-09-20T10:00:00+08:00");
  record(svc, "u1", "dev1", [{ id: "s1", start: now.t, end: now.t + 50 * T }]);
  now.t = now.t + 50 * T + 5 * T; // 离开 5 分钟，不足休息
  const more = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "SHORT_DRAMA",
    feature: "AUTOPLAY",
  });
  assert.equal(more.action, "BLOCK");
  assert.equal(more.rule_code, "R_CONTINUOUS");
  // 休息满 10 分钟后放行
  const after = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "SHORT_DRAMA",
    feature: "AUTOPLAY",
    at_ms: svc.clock() + 6 * T,
  });
  assert.equal(after.action, "ALLOW");
});

test("青少年在未认可设备上使用会升级给监护人并发通知，认可后可用", () => {
  const { svc } = setup();
  onboard(svc, "teen1", { teen: true, guardian: "dad1" });
  const d = svc.engine.evaluate({
    member_id: "teen1",
    device_id: "stranger-device",
    product: "LIVE",
    feature: "LIVE_LINK",
  });
  assert.equal(d.action, "ESCALATE");
  const notices = svc.store.all().filter((e) => e.kind === "GUARDIAN_NOTIFIED");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].subject_id, "dad1");
  assert.match(notices[0].payload.summary, /未被认可/);

  svc.members.registerDevice("teen1", "stranger-device", { approved: true, approvedBy: "dad1" });
  const ok = svc.engine.evaluate({
    member_id: "teen1",
    device_id: "stranger-device",
    product: "LIVE",
    feature: "LIVE_LINK",
  });
  assert.equal(ok.action, "ALLOW");
});

test("离线恢复：重传幂等不多扣、时钟回拨记录被拒、跨午夜归并不凭空加时", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ daily_cap_minutes: 600 }) });
  now.t = Date.parse("2026-09-20T23:50:00+08:00");
  // 设备离线期间：23:50-00:20 跨午夜看了 30 分钟
  const first = record(svc, "u1", "dev1", [
    { id: "off-1", start: now.t, end: now.t + 30 * T },
  ]);
  assert.equal(first.total_added_ms, 30 * T);
  // 整批重传
  const retry = record(svc, "u1", "dev1", [{ id: "off-1", start: now.t, end: now.t + 30 * T }]);
  assert.equal(retry.total_added_ms, 0);
  assert.equal(retry.accepted[0].duplicated, true);

  // 伪造的时钟回拨记录（序号倒退）被拒绝
  now.t = Date.parse("2026-09-21T08:00:00+08:00");
  const bad = svc.ingestOffline({
    member_id: "u1",
    device_id: "dev1",
    anchor: { device_ms: now.t, device_seq: 20_000 },
    records: [
      {
        client_record_id: "evil",
        product: "SHORT_DRAMA",
        device_clock_start: now.t - 10 * T,
        device_clock_end: now.t,
        device_seq: 5, // 远小于已接受序号
      },
    ],
    at: now.t,
  });
  assert.equal(bad.rejected[0].reason, "SEQ_ROLLBACK");
  assert.equal(bad.total_added_ms, 0);

  // 两天用量相加严格等于 30 分钟
  const agreement = svc.agreements.current("u1");
  const d1s = Date.parse("2026-09-20T00:00:00+08:00");
  const d2s = Date.parse("2026-09-21T00:00:00+08:00");
  const d3s = d2s + DAY;
  const used =
    svc.ledger.usedInWindow("u1", d1s, d2s) + svc.ledger.usedInWindow("u1", d2s, d3s);
  assert.equal(used, 30 * T);
  void agreement;
});

test("直播延长：仅事先授权范围内才提示续看，停用时段内不提示", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ extension_allow_prompt: true, extension_max_extra_minutes: 30 }) });
  now.t = Date.parse("2026-09-20T21:00:00+08:00");
  const planned = now.t + 60 * T; // 22:00 计划结束
  // 延长 20 分钟：在范围内 → PROMPT
  const ok = svc.engine.evaluateContinuePrompt({
    member_id: "u1",
    device_id: "dev1",
    live_session_id: "live-1",
    planned_end_ms: planned,
    new_end_ms: planned + 20 * T,
  });
  assert.equal(ok.action, "PROMPT");
  assert.equal(ok.rule_code, "R_EXTENSION");

  // 延长 45 分钟：超出范围 → BLOCK，不提示
  const tooFar = svc.engine.evaluateContinuePrompt({
    member_id: "u1",
    device_id: "dev1",
    live_session_id: "live-1",
    planned_end_ms: planned,
    new_end_ms: planned + 45 * T,
  });
  assert.equal(tooFar.action, "BLOCK");
  assert.equal(tooFar.explanation_data.reason, "EXCEEDS_AUTHORIZED_RANGE");

  // 用户未事先允许续看提示 → 不提示
  svc.members.register("u2", { time_zone: "Asia/Shanghai" });
  svc.members.registerDevice("u2", "dev1");
  svc.agreements.publish("u2", baseAgreement({ extension_allow_prompt: false }), {});
  const noAuth = svc.engine.evaluateContinuePrompt({
    member_id: "u2",
    device_id: "dev1",
    live_session_id: "live-2",
    planned_end_ms: planned,
    new_end_ms: planned + 5 * T,
  });
  assert.equal(noAuth.action, "BLOCK");
  assert.equal(noAuth.explanation_data.reason, "NOT_PRE_AUTHORIZED");
});

test("紧急公益内容单独审批后放行且不占个人预算", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ daily_cap_minutes: 30 }) });
  now.t = Date.parse("2026-09-20T20:00:00+08:00");
  // 先用掉 30 分钟预算
  record(svc, "u1", "dev1", [{ id: "used", start: now.t, end: now.t + 30 * T }]);
  const content = "emergency-flood-relief";
  svc.approvals.submit(
    { ticket_id: "tk-1", content_id: content, title: "防汛紧急公益直播", submitted_by: "ops1" },
    { at: now.t },
  );
  svc.approvals.approve("tk-1", content, {
    reviewerId: "reviewer1",
    validFromMs: now.t,
    validToMs: now.t + 3 * 60 * T,
  });
  // 预算已尽，但公益内容仍放行
  const d = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "LIVE",
    feature: "PLAYBACK",
    content_id: content,
  });
  assert.equal(d.action, "ALLOW");
  assert.equal(d.rule_code, "R_EMERGENCY");
  assert.equal(d.explanation_data.exempt, true);
  // 入账标记 exempt，不扣个人预算
  const r = record(svc, "u1", "dev1", [{ id: "em-1", content_id: content, product: "LIVE", start: now.t, end: now.t + 40 * T }]);
  // 公益区间不进个人账户：added 仍为 0（40 分钟与已用区间无重叠也不计费）
  assert.equal(r.total_added_ms, 0);
  assert.equal(svc.budgetToday("u1").used_ms, 30 * T);

  // 未审批的普通内容仍被预算阻断
  const normal = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "LIVE",
    feature: "PLAYBACK",
    content_id: "ordinary-show",
  });
  assert.equal(normal.action, "BLOCK");
});

test("成年用户撤销画像后，新决策不再使用推断；付费凭证仍可依法核对并留痕", () => {
  const { svc, ctl: now } = setup();
  onboard(svc, "u1");
  svc.profile.recordInference("u1", { key: "favorite_genre", value: "悬疑", tag: "watch-history" });
  svc.profile.recordPayment(
    "u1",
    { receipt_id: "rc-1", order_id: "od-1", amount: "19.90", content_id: "book-9", paid_at_ms: now.t },
    { at: now.t },
  );

  const before = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_NOTIFICATION",
    reminder_id: "rm-p1",
    personalization_key: "favorite_genre",
  });
  assert.deepEqual(before.explanation_data.personalization, { key: "favorite_genre", value: "悬疑" });

  svc.profile.withdraw("u1", { scope: "ALL", reason: "用户行使撤销权" });
  const after = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_NOTIFICATION",
    reminder_id: "rm-p2",
    personalization_key: "favorite_genre",
  });
  assert.equal(after.explanation_data.personalization, null);
  assert.equal(after.explanation_data.profile_withdrawn, true);
  assert.deepEqual(svc.profile.activeInferences("u1", svc.clock()), []);

  // 凭证仍可核对，且核对动作本身有审计留痕
  const receipts = svc.profile.inspectReceipts("u1", {
    inspectorId: "finance-bot",
    legalBasis: "税务稽查协助通知书 #2026-09",
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt_id, "rc-1");
  const audit = svc.store.all().filter((e) => e.kind === "AUDIT_ACCESS");
  assert.equal(audit.length, 1);
  assert.match(audit[0].payload.legal_basis, /税务/);
});

test("事先允许的例外只让行其覆盖的规则", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ daily_cap_minutes: 30 }) });
  now.t = Date.parse("2026-09-20T22:30:00+08:00");
  // 例外只豁免停用时段，不豁免每日预算
  svc.agreements.grantException("u1", {
    exception_id: "ex-1",
    valid_from: new Date(now.t - T).toISOString(),
    valid_to: new Date(now.t + 60 * T).toISOString(),
    scope: { product: "SHORT_DRAMA", feature: "PLAYBACK" },
    rule_codes: ["R_WINDOW"],
    note: "跨年夜追剧",
  });
  record(svc, "u1", "dev1", [{ id: "cap", start: Date.parse("2026-09-20T20:00:00+08:00"), end: Date.parse("2026-09-20T20:00:00+08:00") + 30 * T }]);
  const d = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "SHORT_DRAMA",
    feature: "PLAYBACK",
    at_ms: now.t,
  });
  // 停用时段被例外让行，但预算已尽，仍被阻断
  assert.equal(d.action, "BLOCK");
  assert.equal(d.rule_code, "R_DAILY_CAP");
});

test("账户页时间线用白话解释每次阻断/延后/通知，并标注约定版本", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "teen1", { teen: true, guardian: "dad1" });
  now.t = Date.parse("2026-09-20T22:30:00+08:00");
  svc.engine.evaluate({
    member_id: "teen1",
    device_id: "stranger-device",
    product: "LIVE",
    feature: "LIVE_LINK",
  });
  svc.engine.evaluate({
    member_id: "teen1",
    device_id: "dev1",
    product: "SHORT_DRAMA",
    feature: "PLAYBACK",
  });
  const guardianView = svc.accountTimeline("dad1");
  const notice = guardianView.find((i) => i.type === "GUARDIAN_NOTICE");
  assert.ok(notice);
  assert.match(notice.text, /监护通知/);
  assert.equal(notice.agreement_version, 1);

  const teenView = svc.accountTimeline("teen1");
  const blocked = teenView.find((i) => i.rule_code === "R_WINDOW");
  assert.ok(blocked);
  assert.match(blocked.text, /睡前停用/);
  assert.match(blocked.text, /22:00/);
  assert.equal(blocked.agreement_version, 1);
});

test("重放事件日志可重建全部状态", async () => {
  const { mkTmp } = await import("./helpers.js");
  const file = mkTmp();
  const t0 = Date.parse("2026-09-20T12:00:00+08:00");
  {
    const svc = new CultureTimeService({ filePath: file, clock: () => t0 });
    onboard(svc, "u1");
    record(svc, "u1", "dev1", [{ id: "p1", start: t0, end: t0 + 20 * T }]);
  }
  {
    const svc2 = new CultureTimeService({ filePath: file, clock: () => t0 });
    assert.equal(svc2.budgetToday("u1", t0).used_ms, 20 * T);
    assert.equal(svc2.agreements.current("u1").version, 1);
    // 重放后重传依然幂等
    const r = record(svc2, "u1", "dev1", [{ id: "p1", start: t0, end: t0 + 20 * T }]);
    assert.equal(r.total_added_ms, 0);
  }
});

test("提醒强度：SOFT 可提前取出，STANDARD 不可；SILENT 不补发", () => {
  const { svc, ctl: now } = setup(Date.parse("2026-09-20T20:00:00+08:00"));
  onboard(svc, "u1", { agreement: baseAgreement({ reminder_level: "SOFT" }) });
  now.t = Date.parse("2026-09-20T22:30:00+08:00");
  const soft = svc.engine.evaluate({
    member_id: "u1",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_NOTIFICATION",
    reminder_id: "rm-soft",
  });
  assert.equal(soft.action, "DEFER");
  // 23:00 用户想现在看：SOFT 允许提前取出
  const early = svc.engine.releaseReminderEarly("rm-soft", Date.parse("2026-09-20T23:00:00+08:00"));
  assert.deepEqual(early, { ok: true });

  // STANDARD 用户不能提前取出
  svc.members.register("u2", { time_zone: "Asia/Shanghai" });
  svc.members.registerDevice("u2", "dev1");
  svc.agreements.publish("u2", baseAgreement({ reminder_level: "STANDARD" }), {});
  const std = svc.engine.evaluate({
    member_id: "u2",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_NOTIFICATION",
    reminder_id: "rm-std",
    at_ms: Date.parse("2026-09-20T22:30:00+08:00"),
  });
  assert.equal(std.action, "DEFER");
  const refused = svc.engine.releaseReminderEarly("rm-std", Date.parse("2026-09-20T23:00:00+08:00"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "ONLY_SOFT_MAY_RELEASE_EARLY");

  // SILENT：永久收起，不补发
  svc.members.register("u3", { time_zone: "Asia/Shanghai" });
  svc.members.registerDevice("u3", "dev1");
  svc.agreements.publish("u3", baseAgreement({ reminder_level: "SILENT" }), {});
  svc.engine.evaluate({
    member_id: "u3",
    device_id: "dev1",
    product: "NOVEL",
    feature: "CHAPTER_NOTIFICATION",
    reminder_id: "rm-silent",
    at_ms: Date.parse("2026-09-20T22:30:00+08:00"),
  });
  const released = svc.engine.releaseDueReminders(Date.parse("2026-09-21T08:00:00+08:00"));
  assert.ok(!released.includes("rm-silent"));
});
