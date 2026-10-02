// culture_time_budget 领域资料的基础结构。
// 事件种类与后端 src/service.js 发出的事件日志保持一致。

export const EVENT_KINDS = Object.freeze([
  "BUDGET_SET", // 约定版本创建（每日时段/预算/连续上限/提醒强度/例外）
  "CONSUMPTION_RECORDED", // 消费记录被接受（含调整后接受）
  "LIMIT_REACHED", // 会话被阻断（停用时段/预算用尽/需休息）
  "EXCEPTION_REVIEWED", // 例外审议：直播延长续看提示的允许或抑制
  "PROFILE_WITHDRAWN", // 成年用户撤销历史画像
  "REMINDER_DELAYED", // 提醒因停用时段被延后
  "GUARDIAN_NOTIFIED", // 监护通知已发出
  "EMERGENCY_GRANTED", // 紧急公益内容通过单独审批
  "RECEIPT_ISSUED", // 付费凭证已开具（哈希链）
]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
