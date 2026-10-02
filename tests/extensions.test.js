import assert from "node:assert/strict";
import test from "node:test";
import { makeAdult, makeService, selfActor, standardAgreement } from "./helper.js";

function setup() {
  const { service, clock } = makeService("2026-10-02T21:00:00+08:00");
  const live = service.createLive({
    creator_id: "creator-1",
    title: "周末歌会",
    scheduled_end_at: "2026-10-02T22:00:00+08:00",
  });
  return { service, clock, live };
}

test("延长落在预授权范围内才提示续看，范围外静默且可解释", () => {
  const { service, live } = setup();
  const a = makeAdult(service);
  const b = makeAdult(service);
  const c = makeAdult(service);
  const d = makeAdult(service);
  for (const m of [a, b, c, d]) {
    service.reserveLive(live.live_id, m.membership_id);
  }
  service.addContinuationAllowance(a.membership_id, { max_extra_minutes: 30 }, selfActor(a.membership_id));
  service.addContinuationAllowance(b.membership_id, { max_extra_minutes: 15 }, selfActor(b.membership_id));
  service.addContinuationAllowance(
    c.membership_id,
    { max_extra_minutes: 60, not_after: "22:00" },
    selfActor(c.membership_id),
  );
  // d 不设任何授权

  const result = service.requestLiveExtension(
    live.live_id,
    { actor_id: "creator-1" },
    { new_end_at: "2026-10-02T22:30:00+08:00", reason: "安可" },
  );
  assert.equal(result.extension_minutes, 30);
  assert.equal(result.prompted, 1);
  assert.equal(result.suppressed, 3);

  // a 收到提示，解释引用其授权条款
  const pageA = service.getAccountPage(a.membership_id);
  const prompt = pageA.notifications.find((n) => n.type === "EXTENSION_PROMPT");
  assert.ok(prompt);
  assert.match(prompt.explanation.clauses[0].clause_id, /^allowance:/);

  // b/c/d 没有提示，但账户页留有抑制记录与原因
  for (const m of [b, c, d]) {
    const page = service.getAccountPage(m.membership_id);
    assert.equal(page.notifications.filter((n) => n.type === "EXTENSION_PROMPT").length, 0);
    const suppressed = page.interventions.find((i) => i.kind === "suppressed_extension_prompt");
    assert.ok(suppressed, `${m.membership_id} 应有抑制记录`);
  }
  const pageB = service.getAccountPage(b.membership_id);
  assert.match(pageB.interventions[0].explanation.detail, /超出你允许的续看上限 15 分钟/);
  const pageC = service.getAccountPage(c.membership_id);
  assert.match(pageC.interventions[0].explanation.detail, /晚于你设定的 22:00/);
  const pageD = service.getAccountPage(d.membership_id);
  assert.match(pageD.interventions[0].explanation.detail, /尚未设置任何续看允许范围/);
});

test("只有创作者本人能发起延长；未预约用户不受影响", () => {
  const { service, live } = setup();
  const outsider = makeAdult(service);
  assert.throws(
    () => service.requestLiveExtension(live.live_id, { actor_id: outsider.membership_id }, { new_end_at: "2026-10-02T23:00:00+08:00" }),
    /创作者/,
  );
  const result = service.requestLiveExtension(
    live.live_id,
    { actor_id: "creator-1" },
    { new_end_at: "2026-10-02T22:15:00+08:00" },
  );
  assert.equal(result.outcomes.length, 0); // 没有预约者
});

test("授权可按创作者限定：其他创作者的延长不匹配", () => {
  const { service, live } = setup();
  const m = makeAdult(service);
  service.reserveLive(live.live_id, m.membership_id);
  service.addContinuationAllowance(
    m.membership_id,
    { creator_id: "someone-else", max_extra_minutes: 60 },
    selfActor(m.membership_id),
  );
  const result = service.requestLiveExtension(
    live.live_id,
    { actor_id: "creator-1" },
    { new_end_at: "2026-10-02T22:30:00+08:00" },
  );
  assert.equal(result.prompted, 0);
  assert.equal(result.suppressed, 1);
});

test("约定仍管看播：延长被提示后，停用时段内依然阻断", () => {
  const { service, clock, live } = setup();
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.reserveLive(live.live_id, m.membership_id);
  service.addContinuationAllowance(m.membership_id, { max_extra_minutes: 60 }, selfActor(m.membership_id));
  service.requestLiveExtension(live.live_id, { actor_id: "creator-1" }, { new_end_at: "2026-10-02T22:45:00+08:00" });

  clock.set("2026-10-02T22:40:00+08:00"); // 已进入 22:30 停用时段
  const d = service.checkSession(m.membership_id, { surface: "live" });
  assert.equal(d.kind, "BLOCK");
  assert.equal(d.reason, "blocked_window");
});
