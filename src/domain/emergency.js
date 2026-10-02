// 紧急公益内容：走单独审批，不走常规的直播延长/例外通道。
// 规则：至少 1 名 public_interest_reviewer 审批；若要覆盖硬性阻断（停用时段等），
// 需要 2 名不同审批人。审批有明确生效窗口，到期自动失效。

import { DomainError } from "../core/errors.js";
import { newId } from "../core/ids.js";

export function createGrant(store, clock, input) {
  const problems = [];
  if (typeof input?.title !== "string" || !input.title.trim()) problems.push("title");
  if (typeof input?.content_ref !== "string" || !input.content_ref) problems.push("content_ref");
  const startsAt = Date.parse(input?.starts_at);
  const endsAt = Date.parse(input?.ends_at);
  if (Number.isNaN(startsAt)) problems.push("starts_at");
  if (Number.isNaN(endsAt)) problems.push("ends_at");
  if (!Number.isNaN(startsAt) && !Number.isNaN(endsAt) && endsAt <= startsAt) {
    problems.push("ends_at（须晚于 starts_at）");
  }
  const approvals = Array.isArray(input?.approvals) ? input.approvals : [];
  if (approvals.length < 1) problems.push("approvals（至少 1 名审批人）");
  for (const a of approvals) {
    if (a?.role !== "public_interest_reviewer" || typeof a?.approver_id !== "string" || !a.approver_id) {
      problems.push("approvals（审批人须为 public_interest_reviewer）");
      break;
    }
  }
  const overrideHard = input?.override_hard_blocks === true;
  if (overrideHard) {
    const distinct = new Set(approvals.map((a) => a.approver_id));
    if (distinct.size < 2) problems.push("approvals（覆盖硬性阻断须 2 名不同审批人）");
  }
  if (problems.length) {
    throw new DomainError("validation_failed", `紧急审批字段校验未通过：${problems.join("、")}`, {
      status: 400,
      details: { problems },
    });
  }

  const grant = {
    grant_id: newId("grt"),
    title: input.title.trim(),
    content_ref: input.content_ref,
    scope: input.scope ?? { all: true },
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    override_hard_blocks: overrideHard,
    approvals: approvals.map((a) => ({
      approver_id: a.approver_id,
      role: a.role,
      approved_at: clock.now().toISOString(),
    })),
    created_at: clock.now().toISOString(),
  };
  store.state.grants[grant.grant_id] = grant;
  return grant;
}

// 当前生效、且覆盖某内容引用的审批。
export function activeGrantsFor(store, now, contentRef) {
  const nowMs = now.getTime();
  return Object.values(store.state.grants).filter((g) => {
    if (contentRef && g.content_ref !== contentRef) return false;
    return Date.parse(g.starts_at) <= nowMs && nowMs < Date.parse(g.ends_at);
  });
}
