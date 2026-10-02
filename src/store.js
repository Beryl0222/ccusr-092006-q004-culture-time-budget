// 仅追加事件存储。生产环境可替换为 Kafka/关系库，接口保持不变：
// append(event) 与 subscribe(handler)。所有状态都由事件投影得到，便于审计回放。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateEvent } from "./culture_time_budget.js";

let counter = 0;
function newEventId(kind) {
  counter += 1;
  return `evt_${Date.now().toString(36)}_${counter.toString(36)}_${kind.toLowerCase()}`;
}

export class EventStore {
  constructor({ filePath = null, clock = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.events = [];
    this.handlers = [];
    this.byId = new Map();
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line);
        this.events.push(event);
        this.byId.set(event.event_id, event);
      }
    }
  }

  subscribe(handler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  // 追加事件。idempotencyKey 用于客户端重传：同一键只落一次。
  append(kind, subjectId, payload, { eventId = null, occurredAt = null, idempotencyKey = null } = {}) {
    if (idempotencyKey) {
      const dup = this.events.find(
        (e) => e.payload && e.payload.idempotency_key === idempotencyKey && e.subject_id === subjectId,
      );
      if (dup) return { event: dup, duplicated: true };
    }
    const event = {
      event_id: eventId ?? newEventId(kind),
      kind,
      occurred_at: new Date(occurredAt ?? this.clock()).toISOString(),
      subject_id: subjectId,
      payload: { ...payload, idempotency_key: idempotencyKey ?? payload?.idempotency_key ?? null },
    };
    const problems = validateEvent(event);
    if (problems.length) throw new Error(`事件不合规: ${problems.join(",")}`);
    this._persist(event);
    this.events.push(event);
    this.byId.set(event.event_id, event);
    for (const handler of this.handlers) handler(event);
    return { event, duplicated: false };
  }

  _persist(event) {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }

  all() {
    return this.events.slice();
  }

  forSubject(subjectId) {
    return this.events.filter((e) => e.subject_id === subjectId);
  }
}
