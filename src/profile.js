// 画像与凭证：
// - 画像推断随用随记；成年用户撤销后，决策引擎不再读取这些推断。
//   撤销时刻之前“已经发生”的判定不追溯改写，之后的新决策一律视为无画像。
// - 已完成付费的凭证是不可变台账（财务/税务核对需要），撤销画像不删除凭证；
//   对凭证的任何访问都写 AUDIT_ACCESS 留痕，仅限依法核对用途。

export class ProfileAndReceipts {
  constructor(store) {
    this.store = store;
    this.inferences = new Map(); // memberId -> [{key, value, recorded_at, tag}]
    this.withdrawals = new Map(); // memberId -> [{withdrawn_at, scope}]
    this.receipts = new Map(); // memberId -> [receipt...]
    this.audit = [];
    store.subscribe((e) => this._apply(e));
    for (const e of store.all()) this._apply(e);
  }

  _apply(event) {
    if (event.kind === "PROFILE_INFERENCE_RECORDED") {
      const list = this.inferences.get(event.subject_id) ?? [];
      list.push({ recorded_at: event.occurred_at, ...event.payload });
      this.inferences.set(event.subject_id, list);
    } else if (event.kind === "PROFILE_WITHDRAWN") {
      const list = this.withdrawals.get(event.subject_id) ?? [];
      list.push({ withdrawn_at: event.occurred_at, ...event.payload });
      this.withdrawals.set(event.subject_id, list);
    } else if (event.kind === "PAYMENT_RECORDED") {
      const list = this.receipts.get(event.subject_id) ?? [];
      list.push({ paid_at: event.occurred_at, ...event.payload });
      this.receipts.set(event.subject_id, list);
    } else if (event.kind === "AUDIT_ACCESS") {
      this.audit.push({ at: event.occurred_at, ...event.payload });
    }
  }

  recordInference(memberId, { key, value, tag = null, at = null }) {
    return this.store.append(
      "PROFILE_INFERENCE_RECORDED",
      memberId,
      { key, value, tag },
      { occurredAt: at },
    ).event;
  }

  // 撤销历史画像推断。scope: "ALL" 或指定 key 列表。
  withdraw(memberId, { scope = "ALL", keys = null, reason = "", at = null } = {}) {
    return this.store.append(
      "PROFILE_WITHDRAWN",
      memberId,
      { scope, keys, reason },
      { occurredAt: at },
    ).event;
  }

  recordPayment(memberId, receipt, { at = null }) {
    return this.store.append("PAYMENT_RECORDED", memberId, { ...receipt }, { occurredAt: at }).event;
  }

  isWithdrawn(memberId, atMs, key = null) {
    const atIso = new Date(atMs).toISOString();
    return (this.withdrawals.get(memberId) ?? []).some((w) => {
      if (w.withdrawn_at > atIso) return false;
      if (w.scope === "ALL") return true;
      return key && Array.isArray(w.keys) && w.keys.includes(key);
    });
  }

  // 决策引擎取画像的唯一入口：撤销后返回空，不允许新决策再读到推断。
  activeInferences(memberId, atMs) {
    if (this.isWithdrawn(memberId, atMs)) return [];
    return (this.inferences.get(memberId) ?? []).filter((i) => i.recorded_at <= new Date(atMs).toISOString());
  }

  // 依法核对已完成付费凭证：读取并写审计留痕。画像撤销不影响此能力。
  inspectReceipts(memberId, { inspectorId, legalBasis, at = null, receiptId = null }) {
    let items = this.receipts.get(memberId) ?? [];
    if (receiptId) items = items.filter((r) => r.receipt_id === receiptId);
    this.store.append(
      "AUDIT_ACCESS",
      memberId,
      {
        inspector_id: inspectorId,
        legal_basis: legalBasis,
        receipt_ids: items.map((r) => r.receipt_id),
        purpose: "PAYMENT_RECONCILIATION",
      },
      { occurredAt: at },
    );
    return items.map(({ idempotency_key, ...rest }) => rest);
  }
}
