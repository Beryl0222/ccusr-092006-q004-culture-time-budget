// 紧急公益内容走“单独审批”：不走普通例外、不由创作者自行声明，
// 由具备审批权限的审核员签发带有效期与内容标识的豁免单。
// 豁免只对指定作品/场次生效，不能被挪作普通内容的绕开通道。

export class EmergencyReview {
  constructor(store) {
    this.store = store;
    this.grants = new Map(); // contentId -> [grant...]
    this.reviews = []; // 所有审批工单（含驳回）
    store.subscribe((e) => this._apply(e));
    for (const e of store.all()) this._apply(e);
  }

  _apply(event) {
    if (event.kind === "EMERGENCY_GRANTED") {
      const list = this.grants.get(event.payload.content_id) ?? [];
      list.push({ granted_at: event.occurred_at, ...event.payload });
      this.grants.set(event.payload.content_id, list);
    } else if (event.kind === "EXCEPTION_REVIEWED") {
      this.reviews.push({ reviewed_at: event.occurred_at, ...event.payload });
    }
  }

  // 提交审批工单（紧急公益或存疑例外）。
  submit(ticket, { at = null } = {}) {
    const { event } = this.store.append(
      "EXCEPTION_REVIEWED",
      ticket.content_id,
      {
        ticket_id: ticket.ticket_id,
        kind: ticket.kind ?? "EMERGENCY_PUBLIC_WELFARE",
        content_id: ticket.content_id,
        title: ticket.title ?? "",
        submitted_by: ticket.submitted_by,
        decision: "PENDING",
        reason: ticket.reason ?? "",
      },
      { occurredAt: at },
    );
    return event;
  }

  // 审批通过，签发豁免单。
  approve(ticketId, contentId, { reviewerId, validFromMs, validToMs, scope = {}, at = null, note = "" }) {
    const reviewEvent = this.store.append(
      "EXCEPTION_REVIEWED",
      contentId,
      { ticket_id: ticketId, kind: "EMERGENCY_PUBLIC_WELFARE", content_id: contentId, decision: "APPROVED", reviewer_id: reviewerId, reason: note },
      { occurredAt: at },
    ).event;
    const grantEvent = this.store.append(
      "EMERGENCY_GRANTED",
      contentId,
      {
        grant_id: `gr_${ticketId}`,
        ticket_id: ticketId,
        content_id: contentId,
        reviewer_id: reviewerId,
        valid_from: new Date(validFromMs).toISOString(),
        valid_to: new Date(validToMs).toISOString(),
        scope,
        review_event_id: reviewEvent.event_id,
      },
      { occurredAt: at },
    ).event;
    return grantEvent;
  }

  reject(ticketId, contentId, { reviewerId, at = null, reason = "" }) {
    return this.store.append(
      "EXCEPTION_REVIEWED",
      contentId,
      { ticket_id: ticketId, kind: "EMERGENCY_PUBLIC_WELFARE", content_id: contentId, decision: "REJECTED", reviewer_id: reviewerId, reason },
      { occurredAt: at },
    ).event;
  }

  // 查询某内容在 atMs 是否持有有效紧急豁免。
  activeGrant(contentId, atMs, { liveSessionId = null } = {}) {
    const atIso = new Date(atMs).toISOString();
    const grants = (this.grants.get(contentId) ?? []).filter((g) => g.valid_from <= atIso && g.valid_to > atIso);
    if (!liveSessionId) return grants[0] ?? null;
    return grants.find((g) => !g.scope.live_session_id || g.scope.live_session_id === liveSessionId) ?? null;
  }
}
