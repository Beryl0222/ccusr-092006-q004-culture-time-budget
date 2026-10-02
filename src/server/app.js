// HTTP 层：仅依赖 node:http 的薄路由，把请求转给应用服务。
// 错误统一为 { error: { code, message, details? } }。

import { DomainError } from "../core/errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError("payload_too_large", "请求体过大", { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("bad_json", "请求体不是合法 JSON", { status: 400 });
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

// 路由表：[method, 路径模式（:param 占位）, handler]
function buildRoutes(service) {
  return [
    ["GET", "/health", () => ({ ok: true })],

    ["POST", "/memberships", ({ body }) => ({ status: 201, body: service.createMembership(body) })],
    ["GET", "/memberships/:id", ({ params }) => service.getMembership(params.id)],
    ["PATCH", "/memberships/:id", ({ params, body }) => service.updateMembership(params.id, body)],

    ["POST", "/memberships/:id/agreements", ({ params, body }) => ({
      status: 201,
      body: service.setAgreement(params.id, body.actor, body),
    })],
    ["GET", "/memberships/:id/agreements/current", ({ params }) => {
      const agreement = service.getCurrentAgreement(params.id);
      if (!agreement) throw new DomainError("not_found", "该账号尚未设定约定", { status: 404 });
      return agreement;
    }],

    ["POST", "/memberships/:id/consumption/batch", ({ params, body }) => service.ingestConsumption(params.id, body.records)],
    ["GET", "/memberships/:id/budget", ({ params, query }) => service.getBudget(params.id, query.get("date"))],

    ["POST", "/memberships/:id/decisions/session", ({ params, body }) => service.checkSession(params.id, body)],
    ["POST", "/memberships/:id/decisions/reminder", ({ params, body }) => service.planReminder(params.id, body)],

    ["GET", "/memberships/:id/account-page", ({ params }) => service.getAccountPage(params.id)],
    ["GET", "/memberships/:id/interventions", ({ params }) =>
      service.store.state.interventions.filter((i) => i.membership_id === params.id).slice().reverse()],

    ["POST", "/memberships/:id/continuation-allowances", ({ params, body }) => ({
      status: 201,
      body: service.addContinuationAllowance(params.id, body, body.actor),
    })],

    ["POST", "/memberships/:id/inferences", ({ params, body }) => ({
      status: 201,
      body: service.addInference(params.id, body),
    })],
    ["POST", "/memberships/:id/profile/withdrawals", ({ params, body }) => ({
      status: 201,
      body: service.withdrawProfile(params.id, body.actor),
    })],

    ["POST", "/lives", ({ body }) => ({ status: 201, body: service.createLive(body) })],
    ["POST", "/lives/:id/reservations", ({ params, body }) => ({
      status: 201,
      body: service.reserveLive(params.id, body.membership_id),
    })],
    ["POST", "/lives/:id/extension-requests", ({ params, body }) => ({
      status: 201,
      body: service.requestLiveExtension(params.id, body.actor, body),
    })],

    ["POST", "/emergency-grants", ({ body }) => ({ status: 201, body: service.createEmergencyGrant(body) })],
    ["GET", "/emergency-grants", () => service.listEmergencyGrants()],

    ["POST", "/receipts", ({ body }) => ({ status: 201, body: service.issueReceipt(body) })],
    ["GET", "/receipts/:id/verification", ({ params }) => service.verifyReceipt(params.id)],

    ["GET", "/guardians/:id/notifications", ({ params }) => service.listGuardianNotifications(params.id)],
  ];
}

function matchRoute(routes, method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pp = pattern.split("/").filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i += 1) {
      if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export function createApp(service) {
  const routes = buildRoutes(service);
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const matched = matchRoute(routes, req.method, url.pathname);
      if (!matched) {
        send(res, 404, { error: { code: "not_found", message: `路由不存在：${req.method} ${url.pathname}` } });
        return;
      }
      const body = await readJson(req);
      const result = (await matched.handler({ params: matched.params, query: url.searchParams, body })) ?? {};
      if (result && typeof result === "object" && "status" in result && "body" in result) {
        send(res, result.status, result.body);
      } else {
        send(res, 200, result);
      }
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      } else {
        console.error(err);
        send(res, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  };
}
