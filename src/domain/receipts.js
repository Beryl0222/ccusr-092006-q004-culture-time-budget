// 付费凭证：只追加的哈希链账本。画像撤销、约定变更都不影响凭证，
// 任何一条被篡改都会使链上校验失败，满足"已完成的付费凭证仍可依法核对"。

import { createHash } from "node:crypto";
import { DomainError, notFound } from "../core/errors.js";
import { newId } from "../core/ids.js";

const GENESIS = "GENESIS";

function receiptHash(r) {
  const payload = JSON.stringify({
    receipt_id: r.receipt_id,
    membership_id: r.membership_id,
    amount: r.amount,
    currency: r.currency,
    item: r.item,
    paid_at: r.paid_at,
    prev_hash: r.prev_hash,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function issueReceipt(store, clock, input) {
  const problems = [];
  if (typeof input?.membership_id !== "string" || !store.state.memberships[input.membership_id]) {
    problems.push("membership_id");
  }
  if (typeof input?.amount !== "number" || !(input.amount > 0)) problems.push("amount");
  if (typeof input?.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) problems.push("currency");
  if (typeof input?.item !== "string" || !input.item.trim()) problems.push("item");
  if (input?.paid_at != null && Number.isNaN(Date.parse(input.paid_at))) problems.push("paid_at");
  if (problems.length) {
    throw new DomainError("validation_failed", `凭证字段校验未通过：${problems.join("、")}`, {
      status: 400,
      details: { problems },
    });
  }
  const prev = store.state.receipts[store.state.receipts.length - 1];
  const receipt = {
    receipt_id: newId("rcp"),
    membership_id: input.membership_id,
    amount: input.amount,
    currency: input.currency,
    item: input.item.trim(),
    paid_at: input.paid_at ?? clock.now().toISOString(),
    prev_hash: prev ? prev.hash : GENESIS,
  };
  receipt.hash = receiptHash(receipt);
  store.state.receipts.push(receipt);
  return receipt;
}

// 从链头重算到目标凭证，任一环节对不上即 invalid。
export function verifyReceipt(store, receiptId) {
  const idx = store.state.receipts.findIndex((r) => r.receipt_id === receiptId);
  if (idx < 0) throw notFound("凭证", receiptId);
  const problems = [];
  let expectedPrev = GENESIS;
  for (let i = 0; i <= idx; i += 1) {
    const r = store.state.receipts[i];
    if (r.prev_hash !== expectedPrev) problems.push(`第 ${i + 1} 张凭证的 prev_hash 与链不一致`);
    if (receiptHash(r) !== r.hash) problems.push(`第 ${i + 1} 张凭证内容被改动`);
    expectedPrev = r.hash;
  }
  return { receipt_id: receiptId, valid: problems.length === 0, problems, receipt: store.state.receipts[idx] };
}
