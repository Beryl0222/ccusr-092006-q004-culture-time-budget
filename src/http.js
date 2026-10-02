// HTTP 适配层：无第三方依赖，基于 node:http。
// 所有接口只做参数解析与 JSON 编解码，领域规则全部在 service / engine 内。

import { createServer } from "node:http";

import { CultureTimeService } from "./service.js";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

export function createApp(service) {
  // 路由：[method, pattern(以 : 标记参数), handler]
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const s = service;

  route("GET", "/health", () => ({ ok: true }));

  // ---- 会员与设备 ----
  route("POST", "/members", (b) => {
    s.members.register(b.member_id, {
      is_teen: b.is_teen,
      guardian_id: b.guardian_id,
      time_zone: b.time_zone,
      at: b.at,
    });
    return { member_id: b.member_id };
  });
  route("POST", "/families/link", (b) => {
    const event = s.members.linkTeen(b.teen_id, b.guardian_id, { at: b.at });
    return { event_id: event.event_id };
  });
  route("POST", "/members/:id/devices", (b, { id }) => {
    const event = s.members.registerDevice(id, b.device_id, {
      name: b.name,
      approved: b.approved ?? true,
      approvedBy: b.approved_by,
      at: b.at,
    });
    return { event_id: event.event_id };
  });

  // ---- 约定与例外 ----
  route("POST", "/members/:id/agreements", (b, { id }) => {
    const event = s.agreements.publish(id, b, { by: b.published_by, at: b.at });
    return { event_id: event.event_id, version: event.payload.version };
  });
  route("POST", "/members/:id/exceptions", (b, { id }) => {
    const event = s.agreements.grantException(
      id,
      {
        exception_id: b.exception_id,
        valid_from: new Date(b.valid_from).toISOString(),
        valid_to: new Date(b.valid_to).toISOString(),
        scope: b.scope ?? {},
        rule_codes: b.rule_codes ?? ["*"],
        note: b.note ?? "",
        status: "ACTIVE",
      },
      { at: b.at },
    );
    return { event_id: event.event_id };
  });

  // ---- 心跳与记账 ----
  route("POST", "/devices/heartbeat", (b) => s.heartbeat(b));
  route("POST", "/consume", (b) => s.consume(b));
  route("POST", "/consume/offline", (b) =>
    s.ingestOffline({
      member_id: b.member_id,
      device_id: b.device_id,
      anchor: b.anchor,
      records: b.records,
      at: b.at,
    }),
  );

  // ---- 判定（不记账，用于开播/解锁前预检与提醒）----
  route("POST", "/decisions/evaluate", (b) => s.engine.evaluate(b));
  route("POST", "/reminders/release", (b) => ({ released: s.engine.releaseDueReminders(b.at ?? s.clock()) }));
  route("POST", "/reminders/:id/release-early", (b, { id }) =>
    s.engine.releaseReminderEarly(id, b.at ?? s.clock()),
  );

  // ---- 直播延长续看 ----
  route("POST", "/live/continue-prompt", (b) => s.engine.evaluateContinuePrompt(b));
  route("POST", "/live/continue-prompt/choice", (b) => ({
    event_id: s.engine.choosePrompt(b.member_id, b.prompt_id, b.choice, { at: b.at }).event_id,
  }));

  // ---- 紧急公益审批 ----
  route("POST", "/emergency/tickets", (b) => ({
    event_id: s.approvals
      .submit(
        {
          ticket_id: b.ticket_id,
          content_id: b.content_id,
          title: b.title,
          submitted_by: b.submitted_by,
          reason: b.reason,
        },
        { at: b.at },
      )
      .event_id,
  }));
  route("POST", "/emergency/approve", (b) => ({
    event_id: s.approvals
      .approve(b.ticket_id, b.content_id, {
        reviewerId: b.reviewer_id,
        validFromMs: b.valid_from_ms,
        validToMs: b.valid_to_ms,
        scope: b.scope ?? {},
        note: b.note ?? "",
        at: b.at,
      })
      .event_id,
  }));
  route("POST", "/emergency/reject", (b) => ({
    event_id: s.approvals
      .reject(b.ticket_id, b.content_id, { reviewerId: b.reviewer_id, reason: b.reason, at: b.at })
      .event_id,
  }));

  // ---- 画像与付费凭证 ----
  route("POST", "/members/:id/profile/inferences", (b, { id }) => ({
    event_id: s.profile.recordInference(id, { key: b.key, value: b.value, tag: b.tag, at: b.at }).event_id,
  }));
  route("POST", "/members/:id/profile/withdraw", (b, { id }) => ({
    event_id: s.profile.withdraw(id, { scope: b.scope ?? "ALL", keys: b.keys, reason: b.reason, at: b.at }).event_id,
  }));
  route("POST", "/members/:id/payments", (b, { id }) => ({
    event_id: s.profile
      .recordPayment(
        id,
        {
          receipt_id: b.receipt_id,
          order_id: b.order_id,
          amount: b.amount,
          currency: b.currency ?? "CNY",
          content_id: b.content_id,
          paid_at_ms: b.paid_at_ms,
        },
        { at: b.at ?? b.paid_at_ms },
      )
      .event_id,
  }));
  // 凭证核对：必须给出法定依据，调用本身被审计。
  route("POST", "/members/:id/receipts/inspect", (b, { id }) => ({
    receipts: s.profile.inspectReceipts(id, {
      inspectorId: b.inspector_id,
      legalBasis: b.legal_basis,
      receiptId: b.receipt_id,
      at: b.at,
    }),
  }));

  // ---- 账户页 ----
  route("GET", "/members/:id/timeline", (_b, { id }) => ({ member_id: id, timeline: s.accountTimeline(id) }));
  route("GET", "/members/:id/budget", (b, { id }) => s.budgetToday(id, b.at ? Date.parse(b.at) : s.clock()));
  route("GET", "/members/:id/page", (_b, { id }) => ({
    __raw: { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: renderAccountPage(id, s) },
  }));
  route("GET", "/decisions/:eventId", (_b, { eventId }) => {
    const event = s.store.byId.get(eventId);
    if (!event || event.kind !== "DECISION_MADE") throw Object.assign(new Error("判定不存在"), { status: 404 });
    return s.explainDecision(event);
  });

  const match = (path, pattern) => {
    const a = path.split("/").filter(Boolean);
    const p = pattern.split("/").filter(Boolean);
    if (a.length !== p.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
      else if (p[i] !== a[i]) return null;
    }
    return params;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return json(res, 200, {
          service: "culture-time-budget",
          routes: routes.map((r) => `${r.method} ${r.pattern}`),
        });
      }
      const body = req.method === "POST" ? await readBody(req) : {};
      // 安全：实时判定与状态变更一律以服务端时钟为准，客户端不能用历史/未来时刻
      // 让“约定尚未生效”或把提醒塞进停用时段。离线消费另走可信时间锚点换算。
      delete body.at;
      delete body.at_ms;
      Object.assign(body, Object.fromEntries(url.searchParams));
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const params = match(url.pathname, r.pattern);
        if (!params) continue;
        const result = await r.handler(body, params, req);
        if (result && result.__raw) {
          res.writeHead(result.__raw.status, result.__raw.headers);
          return res.end(result.__raw.body);
        }
        return json(res, 200, { ok: true, ...(result && typeof result === "object" ? result : { result }) });
      }
      return json(res, 404, { ok: false, error: "未找到接口" });
    } catch (err) {
      return json(res, err.status ?? 400, { ok: false, error: err.message });
    }
  });
}

function renderAccountPage(memberId, service) {
  const member = service.members.get(memberId);
  if (!member) return "<!doctype html><meta charset=utf-8><body>会员不存在</body>";
  const now = service.clock();
  const budget = service.budgetToday(memberId, now);
  const timeline = service.accountTimeline(memberId);
  const agreement = service.agreements.versionAt(memberId, now);

  const TYPE = {
    DECISION: "判定",
    REMINDER_RELEASED: "提醒已补发",
    CONTINUE_PROMPT: "续看确认",
    GUARDIAN_NOTICE: "监护通知",
    PROFILE_WITHDRAWN: "画像撤销",
  };
  const items = timeline
    .slice()
    .reverse()
    .map((it) => {
      const at = new Date(it.at).toLocaleString("zh-CN", { hour12: false });
      const src = it.agreement_version ? `依据：约定第 ${esc(String(it.agreement_version))} 版` : "依据：账户设置";
      return `<li class="item">
        <div class="meta"><span class="tag">${esc(TYPE[it.type] ?? it.type)}</span><span>${esc(at)}</span></div>
        <div class="text">${esc(it.text ?? "")}</div>
        <div class="src">${esc(src)}${it.rule_code ? ` · 规则码 ${esc(String(it.rule_code))}` : ""}${it.decision_event_id ? ` · <a href="/decisions/${esc(it.decision_event_id)}">原始判定</a>` : ""}</div>
      </li>`;
    })
    .join("\n");

  const budgetCard = budget
    ? `<section class="card">
      <h2>今天的时间预算（${esc(budget.date)}，时区 ${esc(budget.time_zone)}）</h2>
      <div class="bar"><div class="bar-fill" style="width:${Math.min(100, (budget.used_ms / budget.cap_ms) * 100)}%"></div></div>
      <p>已用 ${Math.round(budget.used_ms / 60000)} 分钟 / 共 ${Math.round(budget.cap_ms / 60000)} 分钟，
      直播、短剧、网文共用一份；剩余 ${Math.round(budget.remaining_ms / 60000)} 分钟。</p>
    </section>`
    : "";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>我的节律约定 · ${esc(memberId)}</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1f2328;line-height:1.6}
  h1{font-size:22px}.card{border:1px solid #d8dee4;border-radius:10px;padding:14px 18px;margin:14px 0}
  .bar{height:10px;background:#eef1f4;border-radius:6px;overflow:hidden}.bar-fill{height:100%;background:#2f81f7}
  .item{border-left:3px solid #2f81f7;padding:8px 12px;margin:12px 0;background:#f6f8fa;border-radius:0 8px 8px 0}
  .meta{display:flex;gap:10px;align-items:center;color:#656d76;font-size:13px}
  .tag{background:#ddf4ff;color:#0969da;border-radius:10px;padding:1px 10px;font-size:12px}
  .text{margin:4px 0}.src{font-size:12px;color:#656d76}
  a{color:#0969da}
</style></head>
<body>
  <h1>我的节律约定</h1>
  <p>这里用大白话解释每一次<strong>暂停、延后提醒或监护通知</strong>来自哪条你（或监护人）设定的约定。</p>
  ${budgetCard}
  <section class="card"><h2>发生了什么</h2><ul style="list-style:none;padding:0">${items || "<li>暂无记录</li>"}</ul></section>
  <p class="src">当前生效约定版本：第 ${agreement ? esc(String(agreement.version)) : "—"} 版（${member.is_teen ? "青少年子账号，由监护人设定" : "成年账户"}）。</p>
</body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function startServer({ filePath = process.env.EVENT_LOG ?? null, port = Number(process.env.PORT ?? 8080) } = {}) {
  const service = new CultureTimeService({ filePath });
  const server = createApp(service);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, service, port: server.address().port }));
  });
}

// 直接运行时启动服务。
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ port }) => {
    console.log(`碎片文化消费节律保护后端已启动：http://localhost:${port}`);
  });
}
