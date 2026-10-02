# 碎片文化消费节律保护后端

把“每日停用时间、连续使用上限、提醒强度、允许例外”统一到**同一会员体系**的后端：
直播连麦、短剧自动连播、网文章节解锁与开播/更新提醒共同消耗**一份时间预算**；
跨设备、离线恢复、跨午夜与时区切换都不能凭空增加或减少时长。
每一次阻断、延后提醒或监护通知都引用当时生效的**约定版本与规则码**，
账户页用普通用户看得懂的话说明“这是因为哪条约定”。

无第三方依赖，仅使用 Node.js 内置能力（`node:http`、`Intl` 时区、`node:test`）。

## 快速开始

```bash
npm test          # 25 个测试
npm start         # 启动 HTTP 服务，默认 http://localhost:8080
PORT=9000 npm start
EVENT_LOG=./data/runtime/events.jsonl npm start   # 事件持久化到 JSONL
```

## 它保证了什么

| 需求 | 实现位置 | 保证方式 |
| --- | --- | --- |
| 三产品共用一份预算 | `src/ledger.js` | 记账以“会员”为单位，不区分 App；区间先取并集再计费 |
| 跨设备同时播放只扣一次 | `mergeIntervals` (`src/time.js`) | 两台设备的重叠区间并集，只算新增时长 |
| 离线重传不多扣 | `Ledger.record` + `service.ingestOffline` | `client_record_id` 幂等，重传 `added_ms=0` |
| 可信时间、防改时钟 | `src/trusted_time.js` | 在线锚点校准设备时钟；序号回退/未来时钟记录被拒并挂起 |
| 跨午夜切分、总量守恒 | `splitByCalendarDay` (`src/time.js`) | 绝对毫秒记账，按会员时区切自然日；DST 日 23/25 小时正确处理 |
| 停用时段硬停 + 恢复时刻 | `engine.js`（`R_WINDOW`） | 判定携带 `resume_at_ms` |
| 全天预算 / 连续上限 | `engine.js`（`R_DAILY_CAP`、`R_CONTINUOUS`） | 连续段内短离开不重置；休息满约定时长才恢复 |
| 提醒强度 | `REMINDER_LEVELS` | SILENT 不弹不补发；SOFT 可提前取出；STANDARD 准时补发；STRICT 不可跳过 |
| 青少年跨设备绕行 | `membership.js` + 设备门 | 未被监护人认可的设备 → `ESCALATE` 并通知监护人 |
| 直播延长续看 | `evaluateContinuePrompt` | 仅在用户事先允许的延长分钟数内出现一次确认提示；不确认不播 |
| 紧急公益 | `src/approvals.js`（`R_EMERGENCY`） | 人工单独审批签发豁免单；豁免内容不占个人预算 |
| 画像撤销 | `src/profile.js`（`R_PROFILE`） | 撤销后新决策读到的推断为空；历史判定不追溯 |
| 付费凭证依法核对 | `PAYMENT_RECORDED` + `AUDIT_ACCESS` | 凭证不可变；每次核对必须给法定依据并留痕 |
| 白话可解释 | `explainDecision` / `accountTimeline` / `GET /members/:id/page` | 每条结论注明约定版本、规则码与恢复时间 |

## 约定（Agreement）

约定以**版本**发布（`POST /members/:id/agreements`），历史判定永久引用当时的版本号：

```json
{
  "time_zone": "Asia/Shanghai",
  "blocked_windows": [{ "from": "22:00", "to": "06:00", "label": "睡前停用" }],
  "daily_cap_minutes": 120,
  "continuous_max_minutes": 90,
  "continuous_break_minutes": 10,
  "reminder_level": "STANDARD",
  "reminder_defer_minutes": 10,
  "extension_allow_prompt": true,
  "extension_max_extra_minutes": 30
}
```

青少年子账号的约定由监护人发布（`published_by` 记监护人）。
例外（`POST /members/:id/exceptions`）带生效区间、产品/功能范围和可让行的规则码，
例如只豁免停用时段、不豁免每日预算。

## 判定动作与规则码

- 动作：`ALLOW` 放行 / `PROMPT` 续看确认 / `DEFER` 提醒延后 / `HOLD` 永久收起 / `BLOCK` 硬停 / `ESCALATE` 转监护人
- 规则码：`R_WINDOW`、`R_DAILY_CAP`、`R_CONTINUOUS`、`R_REMINDER_QUIET`、`R_REMINDER_CAP`、
  `R_DEVICE`、`R_EXTENSION`、`R_EMERGENCY`、`R_EXCEPTION`、`R_PROFILE`

每次判定落一条不可变的 `DECISION_MADE` 事件；`GET /decisions/:eventId` 返回该判定的白话解释。

## 主要 HTTP 接口

```
POST /members                      开户（is_teen=true 为青少年子账号）
POST /families/link                挂接青少年与监护人
POST /members/:id/devices          设备登记（青少年设备须 approved）
POST /members/:id/agreements       发布约定新版本
POST /members/:id/exceptions       授予例外（时间窗 + 规则码范围）
POST /devices/heartbeat            设备在线时钟锚点
POST /consume                      在线消费（先判定后记账）
POST /consume/offline              离线批量恢复（可信换算 + 幂等归并）
POST /decisions/evaluate           预检（开播/解锁/提醒前）
POST /reminders/release            释放到点的收起提醒
POST /reminders/:id/release-early  SOFT 提醒提前取出
POST /live/continue-prompt         直播延长的续看提示判定
POST /emergency/tickets|approve|reject   紧急公益单独审批
POST /members/:id/profile/withdraw       撤销画像推断
POST /members/:id/payments               登记不可变付费凭证
POST /members/:id/receipts/inspect       依法核对（写 AUDIT_ACCESS）
GET  /members/:id/timeline         账户页白话时间线（JSON）
GET  /members/:id/page             账户页（HTML）
GET  /members/:id/budget           当日共享预算概览
GET  /decisions/:eventId           单次判定白话解释
```

## 代码结构

```
src/
  culture_time_budget.js 事件种类与最小字段校验（领域资料，保持向后兼容）
  time.js                时区/午夜/DST、分钟区间并查集
  trusted_time.js        设备时钟锚点与可信时间换算
  store.js               仅追加事件存储（JSONL，可回放重建）
  membership.js          会员、家庭、设备认可
  agreements.js          约定版本与例外
  ledger.js              统一预算账（含公益豁免账）
  approvals.js           紧急公益审批工单与豁免单
  profile.js             画像推断/撤销、付费凭证、核对审计
  engine.js              统一判定引擎
  service.js             装配层：摄入流水线与白话时间线
  http.js                node:http 适配层与账户页
tests/                   25 个测试（时间守恒、幂等、跨设备、监护、审批、画像、HTTP）
data/sample.json         虚构事件样例（仅格式核对）
```

## 设计要点

- **事件溯源**：所有状态都是不可变事件的投影；重启/换库后回放日志即可重建，且重放幂等。
- **绝对时间记账**：时长永远以毫秒绝对值计算，时区只决定“属于哪一天/哪个停用窗”，
  因此改设备时区、跨午夜、DST 都无法刷新预算。
- **解释先于策略**：规则码是稳定机器标识，中文文案只存在于账户页映射层；
  各端不再各自解释为什么被拦。
