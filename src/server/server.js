// 服务入口：node src/server/server.js
// 环境变量：PORT（默认 8787）、DATA_FILE（可选，JSON 快照持久化路径）。

import { createServer } from "node:http";
import { SystemClock } from "../core/clock.js";
import { createService } from "../service.js";
import { JsonFilePersistence, MemoryPersistence } from "../store/store.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const dataFile = process.env.DATA_FILE;

const service = createService({
  clock: new SystemClock(),
  persistence: dataFile ? new JsonFilePersistence(dataFile) : new MemoryPersistence(),
});

const server = createServer(createApp(service));
server.listen(port, () => {
  console.log(`culture-time-budget 后端已启动：http://127.0.0.1:${port}`);
  if (dataFile) console.log(`状态快照：${dataFile}`);
});
