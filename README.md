# 碎片文化消费节律保护

把控制权还给用户与监护人的后端服务：每日停用时段、连续使用上限、提醒强度、允许例外都作用于**同一会员体系**；直播预约、短剧自动连播、章节解锁、跨设备进度**共同消耗一份时间预算**。短剧、直播（含连麦）、网文统一受管。

本仓库同时保留领域资料（事件种类与字段约定，见 `src/culture_time_budget.js`），后端事件日志与之对齐。

## 运行

```bash
npm test          # 全部测试（node:test，无外部依赖）
npm start         # 启动后端，默认 127.0.0.1:8787
PORT=8791 DATA_FILE=./state.json npm start   # 指定端口与快照持久化文件
```

## 架构

```
src/
  core/         时钟抽象、区间归并、时区/本地日界（仅依赖 Intl）、错误与 id
  domain/       agreements   约定模型：停用时段/预算/连续上限/提醒强度/例外，含"是否变松"判定
                consumption  摄入：幂等去重、可信时间截断、设备登记
                budget       共用预算：区间并集计时长、连续使用链条
                decisions    决策引擎：ALLOW / BLOCK / SEND_NOW / DELAY / SUPPRESS
                explanations 人话解释：每次干预引用具体约定条款（谁设定、何时设定）
                extensions   直播延长 vs 用户预授权续看范围
                emergency    紧急公益内容单独审批（硬性覆盖需双人）
                profile      画像推断与撤销；receipts 付费凭证哈希链
  service.js    应用服务：编排、干预落库、监护通知、事件日志、账户页聚合
  server/       node:http 薄路由（无外部依赖）
  store/        内存态 + 可选 JSON 快照持久化
```

## 关键不变量

- **一份预算**：所有产品面、所有设备的观看区间按会员归并（区间并集），重叠只计一次；`source` 区分 manual / autoplay / reservation / chapter_unlock / progress_sync，但扣的是同一份额度。
- **幂等重传**：`(membership_id, record_id)` 去重，离线设备恢复联网后重复上报不多扣。
- **可信时间**：区间以 UTC 绝对时刻存储；结束时刻超出服务端接收时刻（容差 10 分钟）被截断并标记 `clamped_future_end`，整段未来的记录拒绝；单条上限 12 小时（`duration_capped`）。
- **跨午夜/时区守恒**：记录按本地日界切分归属，切分不改变总时长；修改会员时区只改归属，不改总量（有测试守护）。
- **青少年防绕过**：预算是服务端账号级的，换设备拿不到新额度；新设备首现即通知监护人。青少年首份约定须监护人设定，本人只能收紧不能放宽（逐条款比较：预算、时段覆盖、连续上限、提醒强度、例外）。
- **直播延长**：创作者延长时，仅当延长落在用户事先设定的续看范围（最大分钟数、本地截止时刻、可按创作者限定）内才提示；范围外不打扰，但账户页留有抑制记录与原因。提示不等于放行——观看时仍受约定约束。
- **紧急公益**：单独审批（≥1 名 public_interest_reviewer；覆盖硬性阻断需 2 名不同审批人），有明确生效窗口，到期自动恢复；每次送达/放行都引用审批单号。
- **可解释**：每次阻断、延后提醒、监护通知都带 `explanation`：`headline`（人话）、`clauses`（agreement_id + clause_id + 设定人 + 设定时间）、`facts`、`remedy`。账户页 `GET /memberships/:id/account-page` 直接可渲染。
- **画像撤销**：成年用户撤销后，所有推断标记 `withdrawn_at`，新决策（提醒个性化等）只读活跃推断，撤销后恒为空；付费凭证在独立哈希链账本中，不受影响、随时可核对（篡改即校验失败）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/memberships` | 创建会员（`type: adult\|teen`，`time_zone`，`guardian_id`） |
| PATCH | `/memberships/:id` | 改时区/监护人；不改历史时长 |
| POST | `/memberships/:id/agreements` | 新约定版本（`actor:{actor_id,role}`；青少年放宽需监护人） |
| GET | `/memberships/:id/agreements/current` | 当前约定 |
| POST | `/memberships/:id/consumption/batch` | 批量上报观看记录（幂等，离线同步入口） |
| GET | `/memberships/:id/budget?date=YYYY-MM-DD` | 当日/指定日预算用量 |
| POST | `/memberships/:id/decisions/session` | 能否开始/继续观看（`surface`，可选 `content_ref`） |
| POST | `/memberships/:id/decisions/reminder` | 提醒发送决策（章节更新/预约直播等） |
| GET | `/memberships/:id/account-page` | 账户页聚合：预算、条款人话摘要、干预与通知（含解释） |
| GET | `/memberships/:id/interventions` | 干预记录 |
| POST | `/memberships/:id/continuation-allowances` | 设定续看允许范围 |
| POST | `/lives` · `/lives/:id/reservations` · `/lives/:id/extension-requests` | 直播、预约、创作者延长（仅创作者本人） |
| POST | `/emergency-grants` | 紧急公益内容单独审批 |
| POST | `/memberships/:id/inferences` · `/memberships/:id/profile/withdrawals` | 画像推断与撤销（仅成年本人） |
| POST | `/receipts` · `/receipts/:id/verification` | 付费凭证开具与链上核对 |
| GET | `/guardians/:id/notifications` | 监护人通知列表 |

### 示例

```bash
# 监护人给青少年子账号设定约定
curl -X POST localhost:8787/memberships/$MID/agreements -H 'content-type: application/json' -d '{
  "actor": {"actor_id": "guardian-1", "role": "guardian"},
  "blocked_windows": [{"start": "22:30", "end": "07:00"}],
  "daily_budget_minutes": 120,
  "continuous_limit_minutes": 45, "break_minutes": 10,
  "reminder_intensity": "standard",
  "exceptions": [{"type": "window_relax", "relaxed_start": "23:30",
                  "applies_to": {"weekdays": [5]}, "label": "周五可晚睡"}]
}'

# 阻断响应（账户页直接展示 explanation）
# { "kind": "BLOCK", "reason": "blocked_window",
#   "explanation": { "headline": "现在处于停用时段，短剧暂时不能继续",
#     "clauses": [{"clause_id": "blocked_windows", "label": "每日 22:30–07:00 停用",
#                  "set_by": "监护人", "agreement_id": "agr_…", ...}],
#     "facts": {"blocked_until_local": "10月3日 07:00"}, "remedy": "…" } }
```

## 目录其他内容

- `data/sample.json`：虚构样例事件，仅用于格式核对。
- `tests/`：47 个测试覆盖归并守恒、幂等、阻断解释、青少年管控、延长/审批/撤销/凭证与 HTTP 端到端。
