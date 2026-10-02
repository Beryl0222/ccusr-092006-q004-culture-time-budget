import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/server/app.js";
import { makeService, standardAgreement } from "./helper.js";

async function boot() {
  const { service, clock } = makeService("2026-10-02T23:00:00+08:00");
  const server = createServer(createApp(service));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, clock };
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("端到端：建档→设约定→上报→阻断→账户页解释", async () => {
  const { server, base } = await boot();
  try {
    const created = await call(base, "POST", "/memberships", { type: "adult", time_zone: "Asia/Shanghai" });
    assert.equal(created.status, 201);
    const mid = created.json.membership_id;

    const agr = await call(base, "POST", `/memberships/${mid}/agreements`, {
      actor: { actor_id: mid, role: "self" },
      ...standardAgreement(),
    });
    assert.equal(agr.status, 201);
    assert.equal(agr.json.version, 1);

    const ing = await call(base, "POST", `/memberships/${mid}/consumption/batch`, {
      records: [
        {
          record_id: "r1",
          device_id: "phone",
          surface: "short_drama",
          started_at: "2026-10-02T20:00:00+08:00",
          ended_at: "2026-10-02T20:30:00+08:00",
        },
      ],
    });
    assert.equal(ing.status, 200);
    assert.equal(ing.json.results[0].status, "accepted");

    // 23:00 处于 22:30–07:00 停用时段
    const decision = await call(base, "POST", `/memberships/${mid}/decisions/session`, { surface: "short_drama" });
    assert.equal(decision.json.kind, "BLOCK");
    assert.equal(decision.json.explanation.clauses[0].clause_id, "blocked_windows");

    const page = await call(base, "GET", `/memberships/${mid}/account-page`);
    assert.equal(page.status, 200);
    assert.equal(page.json.interventions.length, 1);
    assert.match(page.json.interventions[0].explanation.headline, /停用时段/);
    assert.equal(page.json.today.consumed_seconds, 30 * 60);

    const budget = await call(base, "GET", `/memberships/${mid}/budget`);
    assert.equal(budget.json.remaining_seconds, 90 * 60);
  } finally {
    server.close();
  }
});

test("错误处理：未知路由 404，坏 JSON 400，未知会员 404", async () => {
  const { server, base } = await boot();
  try {
    const notFound = await call(base, "GET", "/nope");
    assert.equal(notFound.status, 404);

    const badJson = await fetch(`${base}/memberships`, { method: "POST", body: "not-json" });
    assert.equal(badJson.status, 400);

    const missing = await call(base, "GET", "/memberships/mbr_none/account-page");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "not_found");
  } finally {
    server.close();
  }
});

test("健康检查", async () => {
  const { server, base } = await boot();
  try {
    const res = await call(base, "GET", "/health");
    assert.equal(res.json.ok, true);
  } finally {
    server.close();
  }
});
