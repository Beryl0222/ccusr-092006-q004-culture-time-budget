import assert from "node:assert/strict";
import test from "node:test";
import { makeAdult, makeService, makeTeen, rec, standardAgreement, guardianActor } from "./helper.js";

test("重传幂等：同一 record_id 重复上报不多扣额度", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, { actor_id: m.membership_id, role: "self" }, standardAgreement());

  const first = service.ingestConsumption(m.membership_id, [rec()]);
  assert.equal(first.results[0].status, "accepted");
  const second = service.ingestConsumption(m.membership_id, [rec()]);
  assert.equal(second.results[0].status, "duplicate");

  const budget = service.getBudget(m.membership_id);
  assert.equal(budget.consumed_seconds, 30 * 60); // 只计一次
});

test("跨设备重叠归并：手机与平板同时看只计一份", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, { actor_id: m.membership_id, role: "self" }, standardAgreement());

  service.ingestConsumption(m.membership_id, [
    rec({ record_id: "a", device_id: "phone", started_at: "2026-10-02T20:00:00+08:00", ended_at: "2026-10-02T20:30:00+08:00" }),
    rec({ record_id: "b", device_id: "tablet", started_at: "2026-10-02T20:15:00+08:00", ended_at: "2026-10-02T20:45:00+08:00" }),
  ]);
  const budget = service.getBudget(m.membership_id);
  assert.equal(budget.consumed_seconds, 45 * 60); // 并集 20:00–20:45
});

test("可信时间：结束时刻超出服务端接收时刻被截断并标记", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  const { results } = service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-02T20:30:00+08:00", ended_at: "2026-10-02T22:00:00+08:00" }),
  ]);
  assert.equal(results[0].status, "adjusted");
  assert.deepEqual(results[0].adjustments, ["clamped_future_end"]);
  const budget = service.getBudget(m.membership_id);
  assert.equal(budget.consumed_seconds, 40 * 60); // 20:30–21:10（含 10 分钟容差）
});

test("可信时间：整段都在未来的记录被拒绝，不计额度", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  const { results } = service.ingestConsumption(m.membership_id, [
    rec({ started_at: "2026-10-03T10:00:00+08:00", ended_at: "2026-10-03T11:00:00+08:00" }),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(service.getBudget(m.membership_id).consumed_seconds, 0);
});

test("结束早于开始、超长记录的处理", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  const bad = service.ingestConsumption(m.membership_id, [
    rec({ record_id: "bad", started_at: "2026-10-02T10:00:00+08:00", ended_at: "2026-10-02T09:00:00+08:00" }),
  ]);
  assert.equal(bad.results[0].status, "rejected");

  const capped = service.ingestConsumption(m.membership_id, [
    rec({ record_id: "long", started_at: "2026-10-02T01:00:00+08:00", ended_at: "2026-10-02T20:00:00+08:00" }),
  ]);
  assert.equal(capped.results[0].status, "adjusted");
  assert.deepEqual(capped.results[0].adjustments, ["duration_capped"]);
});

test("青少年新设备触发监护通知（换设备绕不开账号级预算）", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const teen = makeTeen(service);
  service.setAgreement(teen.membership_id, guardianActor(), standardAgreement());

  service.ingestConsumption(teen.membership_id, [rec({ record_id: "d1", device_id: "phone-1" })]);
  service.ingestConsumption(teen.membership_id, [
    rec({ record_id: "d2", device_id: "phone-2", started_at: "2026-10-02T20:30:00+08:00", ended_at: "2026-10-02T21:00:00+08:00" }),
  ]);

  const notices = service.listGuardianNotifications("guardian-1");
  assert.equal(notices.length, 2); // 两台新设备各一条
  assert.match(notices[0].body, /新设备/);
  // 两台设备各 30 分钟，账号级合计 60 分钟
  assert.equal(service.getBudget(teen.membership_id).consumed_seconds, 60 * 60);
});
