// 画像：推断数据可撤销。撤销后，所有新决策不得再使用这些推断
// （决策通过 activeInferences 取数，天然过滤）；撤销不影响付费凭证。

import { DomainError, forbidden, notFound } from "../core/errors.js";
import { newId } from "../core/ids.js";

export function addInference(store, clock, membershipId, input) {
  if (typeof input?.label !== "string" || !input.label.trim()) {
    throw new DomainError("validation_failed", "画像推断需要 label", { status: 400 });
  }
  const inference = {
    inference_id: newId("inf"),
    membership_id: membershipId,
    surface: input.surface ?? null,
    label: input.label.trim(),
    created_at: clock.now().toISOString(),
    withdrawn_at: null,
  };
  (store.state.inferences[membershipId] ??= []).push(inference);
  return inference;
}

export function activeInferences(store, membershipId) {
  return (store.state.inferences[membershipId] ?? []).filter((i) => i.withdrawn_at == null);
}

// 成年用户撤销历史画像：全部推断标记 withdrawn_at，新决策不再使用。
// 已完成的付费凭证在独立账本中，不受影响、仍可核对。
export function withdrawProfile(store, clock, membership, actor) {
  if (membership.type !== "adult") {
    throw forbidden("只有成年用户可以撤销历史画像；青少年账号由监护人管理");
  }
  if (actor?.actor_id !== membership.membership_id) {
    throw forbidden("只能撤销本人的画像");
  }
  const list = store.state.inferences[membership.membership_id] ?? [];
  const nowIso = clock.now().toISOString();
  let count = 0;
  for (const inf of list) {
    if (inf.withdrawn_at == null) {
      inf.withdrawn_at = nowIso;
      count += 1;
    }
  }
  const withdrawal = { withdrawn_at: nowIso, withdrawn_count: count };
  (membership.profile_withdrawals ??= []).push(withdrawal);
  return withdrawal;
}

export function latestWithdrawal(membership) {
  const list = membership.profile_withdrawals ?? [];
  return list.length ? list[list.length - 1] : null;
}

export function requireMembership(store, membershipId) {
  const m = store.state.memberships[membershipId];
  if (!m) throw notFound("会员", membershipId);
  return m;
}
