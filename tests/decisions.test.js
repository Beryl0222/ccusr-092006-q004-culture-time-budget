import assert from "node:assert/strict";
import test from "node:test";
import { validateEvent } from "../src/culture_time_budget.js";
import {
  GUARDIAN,
  guardianActor,
  makeAdult,
  makeService,
  makeTeen,
  rec,
  selfActor,
  standardAgreement,
} from "./helper.js";

test("停用时段内阻断，并给出可引用的约定出处", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());

  const d = service.checkSession(m.membership_id, { surface: "short_drama" });
  assert.equal(d.kind, "BLOCK");
  assert.equal(d.reason, "blocked_window");
  assert.match(d.explanation.headline, /停用时段/);
  assert.equal(d.explanation.clauses[0].clause_id, "blocked_windows");
  assert.equal(d.explanation.clauses[0].set_by, "本人");
  assert.ok(d.explanation.clauses[0].agreement_id);
  assert.equal(d.explanation.facts.blocked_until_local, "10月3日 07:00");

  // 账户页能查到这次干预
  const page = service.getAccountPage(m.membership_id);
  assert.equal(page.interventions.length, 1);
  assert.equal(page.interventions[0].kind, "block");
  assert.equal(page.interventions[0].explanation.clauses[0].clause_id, "blocked_windows");
});

test("停用时段外允许，并返回剩余额度", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  const d = service.checkSession(m.membership_id, { surface: "live" });
  assert.equal(d.kind, "ALLOW");
  assert.equal(d.remaining_seconds, 120 * 60);
});

test("surface_exempt 例外：网文不受停用时段限制，短剧仍被阻断", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(
    m.membership_id,
    selfActor(m.membership_id),
    standardAgreement({
      exceptions: [{ type: "surface_exempt", surface: "novel", label: "睡前可读网文" }],
    }),
  );
  assert.equal(service.checkSession(m.membership_id, { surface: "novel" }).kind, "ALLOW");
  assert.equal(service.checkSession(m.membership_id, { surface: "short_drama" }).kind, "BLOCK");
});

test("window_relax 例外：仅适用日期放宽停用起点", () => {
  // 2026-10-02 是周五；例外把周五的停用起点从 22:30 推迟到 23:30
  const { service, clock } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(
    m.membership_id,
    selfActor(m.membership_id),
    standardAgreement({
      exceptions: [
        { type: "window_relax", relaxed_start: "23:30", applies_to: { weekdays: [5] }, label: "周五晚点睡" },
      ],
    }),
  );
  assert.equal(service.checkSession(m.membership_id, { surface: "live" }).kind, "ALLOW"); // 周五 23:00 放行
  clock.set("2026-10-03T23:00:00+08:00"); // 周六同时刻
  assert.equal(service.checkSession(m.membership_id, { surface: "live" }).kind, "BLOCK");
});

test("每日共用预算用尽后阻断，解释引用预算条款", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement({ daily_budget_minutes: 60 }));
  service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-02T20:00:00+08:00", ended_at: "2026-10-02T21:00:00+08:00" }),
  ]);
  const d = service.checkSession(m.membership_id, { surface: "novel" });
  assert.equal(d.kind, "BLOCK");
  assert.equal(d.reason, "budget_exhausted");
  assert.equal(d.explanation.clauses[0].clause_id, "daily_budget");
});

test("连续使用达上限要求休息，休息结束后恢复", () => {
  const { service, clock } = makeService("2026-10-02T20:52:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-02T20:00:00+08:00", ended_at: "2026-10-02T20:50:00+08:00" }),
  ]);
  const d = service.checkSession(m.membership_id, { surface: "short_drama" });
  assert.equal(d.kind, "BLOCK");
  assert.equal(d.reason, "break_required");
  assert.equal(d.explanation.clauses[0].clause_id, "continuous_limit");
  assert.equal(d.explanation.facts.break_until_local, "10月2日 21:02");

  clock.set("2026-10-02T21:03:00+08:00"); // 休息完成
  assert.equal(service.checkSession(m.membership_id, { surface: "short_drama" }).kind, "ALLOW");
});

test("提醒在停用时段内被延后到时段结束，并说明出处", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());

  const d = service.planReminder(m.membership_id, { kind: "chapter_update", surface: "novel", title: "你追的章节更新了" });
  assert.equal(d.kind, "DELAY");
  assert.equal(d.deliver_at, "2026-10-02T23:00:00.000Z"); // 上海次日 07:00
  assert.equal(d.explanation.clauses[0].clause_id, "blocked_windows");

  const page = service.getAccountPage(m.membership_id);
  assert.equal(page.interventions[0].kind, "delayed_reminder");
  assert.equal(page.notifications[0].type, "DELAYED_REMINDER");
});

test("提醒强度：off 全部抑制；low 只发预约直播", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement({ reminder_intensity: "off" }));
  const suppressed = service.planReminder(m.membership_id, { kind: "live_reservation", surface: "live" });
  assert.equal(suppressed.kind, "SUPPRESS");
  assert.equal(suppressed.explanation.clauses[0].clause_id, "reminder_intensity");

  const m2 = makeAdult(service);
  service.setAgreement(m2.membership_id, selfActor(m2.membership_id), standardAgreement({ reminder_intensity: "low" }));
  assert.equal(service.planReminder(m2.membership_id, { kind: "chapter_update", surface: "novel" }).kind, "SUPPRESS");
  assert.equal(service.planReminder(m2.membership_id, { kind: "live_reservation", surface: "live" }).kind, "SEND_NOW");
});

test("青少年：首份约定须监护人设定；本人只能收紧不能放宽", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const teen = makeTeen(service);

  assert.throws(
    () => service.setAgreement(teen.membership_id, selfActor(teen.membership_id), standardAgreement()),
    /监护人/,
  );
  service.setAgreement(teen.membership_id, guardianActor(), standardAgreement());

  // 本人收紧（120 → 60 分钟）：允许
  const tighter = service.setAgreement(
    teen.membership_id,
    selfActor(teen.membership_id),
    standardAgreement({ daily_budget_minutes: 60 }),
  );
  assert.equal(tighter.daily_budget_minutes, 60);

  // 本人放宽（60 → 180 分钟）：拒绝
  assert.throws(
    () => service.setAgreement(teen.membership_id, selfActor(teen.membership_id), standardAgreement({ daily_budget_minutes: 180 })),
    /放宽/,
  );
  // 监护人可以放宽
  const looser = service.setAgreement(teen.membership_id, guardianActor(), standardAgreement({ daily_budget_minutes: 180 }));
  assert.equal(looser.daily_budget_minutes, 180);
});

test("青少年被阻断时监护人收到通知，孩子账户页也能看到出处", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const teen = makeTeen(service);
  service.setAgreement(teen.membership_id, guardianActor(), standardAgreement());

  const d = service.checkSession(teen.membership_id, { surface: "live" });
  assert.equal(d.kind, "BLOCK");
  assert.equal(d.explanation.clauses[0].set_by, "监护人");

  const notices = service.listGuardianNotifications(GUARDIAN);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "GUARDIAN_ALERT");

  const page = service.getAccountPage(teen.membership_id);
  const kinds = page.interventions.map((i) => i.kind);
  assert.ok(kinds.includes("block"));
  assert.ok(kinds.includes("guardian_notification"));
});

test("青少年无约定一律阻断；成人无约定放行", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const teen = makeTeen(service);
  assert.equal(service.checkSession(teen.membership_id, { surface: "live" }).reason, "agreement_missing");
  const adult = makeAdult(service);
  assert.equal(service.checkSession(adult.membership_id, { surface: "live" }).kind, "ALLOW");
});

test("事件日志全部符合领域资料约定", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const teen = makeTeen(service);
  service.setAgreement(teen.membership_id, guardianActor(), standardAgreement());
  service.ingestConsumption(teen.membership_id, [rec()]);
  service.checkSession(teen.membership_id, { surface: "live" });
  service.planReminder(teen.membership_id, { kind: "chapter_update", surface: "novel" });

  assert.ok(service.listEvents().length >= 4);
  for (const event of service.listEvents()) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.kind} 应符合资料约定`);
  }
});
