// 存储层：默认内存态，可选 JSON 文件持久化（写临时文件后原子改名）。
// 所有集合都是 JSON 可序列化的普通对象/数组，快照即状态。

import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function emptyState() {
  return {
    memberships: {}, // membership_id -> 会员（成人或青少年子账号）
    agreements: {}, // membership_id -> [约定版本，按时间递增]
    records: {}, // `${membership_id}:${record_id}` -> 消费记录（幂等键）
    devices: {}, // membership_id -> { device_id: {first_seen_at, last_seen_at} }
    lives: {}, // live_id -> 直播场次
    reservations: {}, // live_id -> [membership_id]
    allowances: {}, // membership_id -> [续看预授权范围]
    inferences: {}, // membership_id -> [画像推断]
    receipts: [], // 付费凭证哈希链（只追加，画像撤销不影响）
    notifications: [], // 通知（含延后提醒、续看提示、监护通知）
    interventions: [], // 干预记录（阻断/延后/抑制），账户页展示用
    grants: {}, // grant_id -> 紧急公益内容审批
    events: [], // 领域事件日志，字段对齐 culture_time_budget 资料约定
  };
}

export class MemoryPersistence {
  load() {
    return null;
  }
  save() {}
}

export class JsonFilePersistence {
  constructor(path) {
    this.path = path;
  }
  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return { ...emptyState(), ...parsed };
    } catch {
      return null;
    }
  }
  save(state) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path);
  }
}

export function createStore(persistence = new MemoryPersistence()) {
  const state = persistence.load() ?? emptyState();
  return {
    state,
    save() {
      persistence.save(state);
    },
  };
}
