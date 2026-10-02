// culture_time_budget 领域资料的基础结构。
//
// 全部后端围绕同一组不可变事件工作：约定变更、消费记账、引擎判定、
// 例外审批、画像撤销、付费凭证。任何一次“阻断 / 延后提醒 / 监护通知”
// 都必须能回溯到具体事件与约定版本，账户页据此给出白话解释。

export const EVENT_KINDS = Object.freeze([
  // 账户与会员体系
  "MEMBER_REGISTERED", // 会员开户（成年用户或青少年子账号）
  "TEEN_LINKED", // 青少年子账号挂接到监护人家庭
  "DEVICE_REGISTERED", // 设备登记到会员

  // 约定（用户或监护人设定的节律规则）
  "AGREEMENT_DRAFTED", // 约定草案
  "AGREEMENT_PUBLISHED", // 约定生效（携带版本号与生效时刻）
  "EXCEPTION_GRANTED", // 单次/周期性例外（用户事先允许的范围）

  // 消费与预算
  "CONSUMPTION_RECORDED", // 一段观看/阅读/连麦消费
  "BUDGET_SET", // 预算口径调整（保留兼容旧样例）
  "CROSS_DEVICE_MERGED", // 离线设备恢复联网后的归并结果
  "DECISION_MADE", // 引擎对一次请求的判定（阻断/延后/放行/提示）

  // 提醒、通知、连播、解锁
  "REMINDER_DEFERRED", // 提醒被延后（弱提醒不打断）
  "REMINDER_HELD", // 提醒被整体压制（睡眠时段等）
  "GUARDIAN_NOTIFIED", // 发给监护人的通知
  "CONTINUE_PROMPT_SHOWN", // 直播延长后的“续看提示”
  "CONTINUE_PROMPT_CHOSEN", // 用户对续看提示的选择

  // 审批
  "EXCEPTION_REVIEWED", // 例外/紧急公益内容的人工审批结论
  "EMERGENCY_GRANTED", // 紧急公益内容单独审批通过

  // 画像与凭证
  "PROFILE_INFERENCE_RECORDED", // 系统产生的一条画像推断
  "PROFILE_WITHDRAWN", // 成年用户撤销历史画像推断
  "PAYMENT_RECORDED", // 已完成付费的不可变凭证
  "AUDIT_ACCESS", // 出于法定义务核对凭证等敏感访问的审计留痕
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 判定动作。BLOCK 硬停；DEFER 延后提醒/预约；PROMPT 仅在事先授权范围内提示续看；
// ALLOW 放行；HOLD 压制提醒；ESCALATE 转监护人审批。
export const DECISION_ACTIONS = Object.freeze(["ALLOW", "PROMPT", "DEFER", "HOLD", "BLOCK", "ESCALATE"]);

// 提醒强度：SILENT 不弹；SOFT 可延后；STANDARD 普通；STRICT 不可跳过。
export const REMINDER_LEVELS = Object.freeze(["SILENT", "SOFT", "STANDARD", "STRICT"]);
