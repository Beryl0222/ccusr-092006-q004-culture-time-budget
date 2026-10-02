import assert from "node:assert/strict";
import test from "node:test";
import { makeAdult, makeService, makeTeen, selfActor, standardAgreement } from "./helper.js";

test("撤销画像前：提醒个性化会使用活跃推断", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.addInference(m.membership_id, { surface: "novel", label: "偏好悬疑短篇" });

  const d = service.planReminder(m.membership_id, { kind: "chapter_update", surface: "novel" });
  assert.equal(d.kind, "SEND_NOW");
  assert.equal(d.used_inferences.length, 1);
  assert.match(d.preview, /悬疑/);
});

test("成年用户撤销画像后：新决策不再使用历史推断", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  service.setAgreement(m.membership_id, selfActor(m.membership_id), standardAgreement());
  service.addInference(m.membership_id, { surface: "novel", label: "偏好悬疑短篇" });
  service.addInference(m.membership_id, { surface: "live", label: "常看深夜电台" });

  const result = service.withdrawProfile(m.membership_id, selfActor(m.membership_id));
  assert.equal(result.withdrawn_count, 2);

  const d = service.planReminder(m.membership_id, { kind: "chapter_update", surface: "novel" });
  assert.equal(d.kind, "SEND_NOW");
  assert.deepEqual(d.used_inferences, []); // 不再使用任何历史推断
  assert.equal(d.preview, null);

  const page = service.getAccountPage(m.membership_id);
  assert.equal(page.profile.active_inferences, 0);
  assert.ok(page.profile.last_withdrawal);
});

test("青少年不能撤销画像；不能替他人撤销", () => {
  const { service } = makeService();
  const teen = makeTeen(service);
  assert.throws(() => service.withdrawProfile(teen.membership_id, selfActor(teen.membership_id)), /成年/);
  const adult = makeAdult(service);
  assert.throws(() => service.withdrawProfile(adult.membership_id, { actor_id: "someone-else", role: "self" }), /本人/);
});

test("撤销画像不影响付费凭证：凭证仍可依法核对", () => {
  const { service } = makeService("2026-10-02T21:00:00+08:00");
  const m = makeAdult(service);
  const r1 = service.issueReceipt({ membership_id: m.membership_id, amount: 12.0, currency: "CNY", item: "章节解锁" });
  const r2 = service.issueReceipt({ membership_id: m.membership_id, amount: 30.0, currency: "CNY", item: "直播打赏" });

  service.addInference(m.membership_id, { surface: "novel", label: "偏好悬疑短篇" });
  service.withdrawProfile(m.membership_id, selfActor(m.membership_id));

  for (const r of [r1, r2]) {
    const v = service.verifyReceipt(r.receipt_id);
    assert.equal(v.valid, true);
    assert.equal(v.receipt.membership_id, m.membership_id);
  }
});

test("凭证哈希链：篡改任一历史凭证即校验失败", () => {
  const { service } = makeService();
  const m = makeAdult(service);
  const r1 = service.issueReceipt({ membership_id: m.membership_id, amount: 12.0, currency: "CNY", item: "章节解锁" });
  const r2 = service.issueReceipt({ membership_id: m.membership_id, amount: 30.0, currency: "CNY", item: "直播打赏" });
  assert.equal(service.verifyReceipt(r2.receipt_id).valid, true);

  // 直接改账本里的金额（模拟篡改）
  service.store.state.receipts.find((r) => r.receipt_id === r1.receipt_id).amount = 1200.0;
  const v = service.verifyReceipt(r2.receipt_id);
  assert.equal(v.valid, false);
  assert.ok(v.problems.length > 0);
});
