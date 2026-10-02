import assert from "node:assert/strict";
import test from "node:test";
import { makeAdult, makeService, selfActor, standardAgreement } from "./helper.js";

const GRANT_WINDOW = {
  starts_at: "2026-10-02T00:00:00+08:00",
  ends_at: "2026-10-03T00:00:00+08:00",
};

test("紧急公益内容必须走单独审批：缺审批人直接拒绝", () => {
  const { service } = makeService();
  assert.throws(
    () => service.createEmergencyGrant({ title: "台风预警", content_ref: "live:typhoon", ...GRANT_WINDOW, approvals: [] }),
    /审批人/,
  );
  assert.throws(
    () =>
      service.createEmergencyGrant({
        title: "台风预警",
        content_ref: "live:typhoon",
        ...GRANT_WINDOW,
        approvals: [{ approver_id: "ops-1", role: "content_ops" }],
      }),
    /public_interest_reviewer/,
  );
});

test("覆盖硬性阻断需要两名不同审批人", () => {
  const { service } = makeService();
  assert.throws(
    () =>
      service.createEmergencyGrant({
        title: "地震速报",
        content_ref: "live:quake",
        ...GRANT_WINDOW,
        override_hard_blocks: true,
        approvals: [{ approver_id: "rev-1", role: "public_interest_reviewer" }],
      }),
    /2 名/,
  );
  const grant = service.createEmergencyGrant({
    title: "地震速报",
    content_ref: "live:quake",
    ...GRANT_WINDOW,
    override_hard_blocks: true,
    approvals: [
      { approver_id: "rev-1", role: "public_interest_reviewer" },
      { approver_id: "rev-2", role: "public_interest_reviewer" },
    ],
  });
  assert.ok(grant.grant_id);
});

test("审批生效期内：停用时段中的紧急提醒直接送达并注明审批出处", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.createEmergencyGrant({
    title: "台风预警直播",
    content_ref: "live:typhoon",
    ...GRANT_WINDOW,
    approvals: [{ approver_id: "rev-1", role: "public_interest_reviewer" }],
  });

  const d = service.planReminder(m.membership_id, {
    kind: "live_reservation",
    surface: "live",
    content_ref: "live:typhoon",
    title: "台风预警",
  });
  assert.equal(d.kind, "SEND_NOW");
  assert.equal(d.reason, "emergency_grant");
  assert.match(d.explanation.headline, /紧急公益内容/);
  assert.match(d.explanation.clauses[0].clause_id, /^grant:/);

  // 普通内容仍被延后
  const normal = service.planReminder(m.membership_id, { kind: "chapter_update", surface: "novel" });
  assert.equal(normal.kind, "DELAY");
});

test("双人审批的覆盖可以放行停用时段中的观看，单人审批不行", () => {
  const { service } = makeService("2026-10-02T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());

  service.createEmergencyGrant({
    title: "普通公益直播",
    content_ref: "live:charity",
    ...GRANT_WINDOW,
    approvals: [{ approver_id: "rev-1", role: "public_interest_reviewer" }],
  });
  // 无硬性覆盖：会话仍被阻断
  assert.equal(
    service.checkSession(m.membership_id, { surface: "live", content_ref: "live:charity" }).kind,
    "BLOCK",
  );

  service.createEmergencyGrant({
    title: "地震速报",
    content_ref: "live:quake",
    ...GRANT_WINDOW,
    override_hard_blocks: true,
    approvals: [
      { approver_id: "rev-1", role: "public_interest_reviewer" },
      { approver_id: "rev-2", role: "public_interest_reviewer" },
    ],
  });
  const d = service.checkSession(m.membership_id, { surface: "live", content_ref: "live:quake" });
  assert.equal(d.kind, "ALLOW");
  assert.equal(d.reason, "emergency_override");
});

test("审批到期后恢复原有限制", () => {
  const { service } = makeService("2026-10-05T23:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.createEmergencyGrant({
    title: "台风预警直播",
    content_ref: "live:typhoon",
    ...GRANT_WINDOW, // 10-03 已到期
    override_hard_blocks: true,
    approvals: [
      { approver_id: "rev-1", role: "public_interest_reviewer" },
      { approver_id: "rev-2", role: "public_interest_reviewer" },
    ],
  });
  const d = service.checkSession(m.membership_id, { surface: "live", content_ref: "live:typhoon" });
  assert.equal(d.kind, "BLOCK");
});
