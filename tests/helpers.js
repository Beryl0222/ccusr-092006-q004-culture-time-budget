import { tmpdir } from "node:os";
import { join } from "node:path";

export function mkTmp(prefix = "events-") {
  return join(tmpdir(), `${prefix}${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}
