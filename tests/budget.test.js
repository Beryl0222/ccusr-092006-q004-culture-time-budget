import assert from "node:assert/strict";
import test from "node:test";
import { makeAdult, makeService, rec, standardAgreement, selfActor } from "./helper.js";

test("跨午夜：记录按本地日切开归属，两天合计守恒", () => {
  const { service } = makeService("2026-10-03T01:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-02T23:30:00+08:00", ended_at: "2026-10-03T00:30:00+08:00" }),
  ]);
  const day1 = service.getBudget(m.membership_id, "2026-10-02");
  const day2 = service.getBudget(m.membership_id, "2026-10-03");
  assert.equal(day1.consumed_seconds, 30 * 60);
  assert.equal(day2.consumed_seconds, 30 * 60);
  assert.equal(day1.consumed_seconds + day2.consumed_seconds, 60 * 60); // 不增不减
});

test("改时区不凭空增加时长：同一批 UTC 区间，两天合计不变", () => {
  const { service } = makeService("2026-10-03T01:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-02T23:30:00+08:00", ended_at: "2026-10-03T00:30:00+08:00" }),
  ]);
  const before =
    service.getBudget(m.membership_id, "2026-10-02").consumed_seconds +
    service.getBudget(m.membership_id, "2026-10-03").consumed_seconds;

  service.updateMembership(m.membership_id, { time_zone: "UTC" });
  const after =
    service.getBudget(m.membership_id, "2026-10-02").consumed_seconds +
    service.getBudget(m.membership_id, "2026-10-03").consumed_seconds;
  assert.equal(before, after); // 60 分钟，只是归属的日子不同
  assert.equal(service.getBudget(m.membership_id, "2026-10-02").consumed_seconds, 60 * 60);
});

test("budget_bonus 例外：适用日期预算增加", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(
    m.membership_id,
    selfActor(m.membership_id),
    standardAgreement({
      daily_budget_minutes: 60,
      exceptions: [
        { type: "budget_bonus", minutes: 30, applies_to: { dates: ["2026-10-02"] }, label: "国庆加量" },
      ],
    }),
  );
  service.ingestConsumption(m.membership_id, [rec()]);
  const today = service.getBudget(m.membership_id, "2026-10-02");
  assert.equal(today.budget_seconds, 90 * 60);
  const other = service.getBudget(m.membership_id, "2026-10-04");
  assert.equal(other.budget_seconds, 60 * 60);
});
