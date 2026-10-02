import { randomUUID } from "node:crypto";

// 生成带前缀的短 id，便于日志与账户页展示时辨认类型。
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
