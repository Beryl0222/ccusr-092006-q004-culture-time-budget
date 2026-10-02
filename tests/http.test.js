import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/http.js";
import { CultureTimeService } from "../src/service.js";

const T = 60_000;

async function withServer(fn) {
  const service = new CultureTimeService({ clock: () => currentMs });
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`, service);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let currentMs = Date.parse("2026-09-20T20:00:00+08:00");

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

test("HTTP 端到端：开户、约定、判定阻断、账户页白话解释", async () => {
  await withServer(async (base) => {
    currentMs = Date.parse("2026-09-20T20:00:00+08:00");
    assert.equal((await call(base, "GET", "/health")).body.ok, true);

    await call(base, "POST", "/members", { member_id: "u1", time_zone: "Asia/Shanghai" });
    await call(base, "POST", "/members/u1/devices", { device_id: "dev1", approved: true });
    const pub = await call(base, "POST", "/members/u1/agreements", {
      time_zone: "Asia/Shanghai",
      blocked_windows: [{ from: "22:00", to: "06:00", label: "睡前停用" }],
      daily_cap_minutes: 120,
      continuous_max_minutes: 90,
      reminder_level: "STANDARD",
      extension_allow_prompt: true,
      extension_max_extra_minutes: 30,
    });
    assert.equal(pub.body.version, 1);

    // 22:30 播放短剧 → 阻断
    currentMs = Date.parse("2026-09-20T22:30:00+08:00");
    const decision = await call(base, "POST", "/decisions/evaluate", {
      member_id: "u1",
      device_id: "dev1",
      product: "SHORT_DRAMA",
      feature: "PLAYBACK",
    });
    assert.equal(decision.body.action, "BLOCK");
    assert.equal(decision.body.rule_code, "R_WINDOW");

    // 时间线
    const timeline = await call(base, "GET", "/members/u1/timeline");
    const entry = timeline.body.timeline.find((i) => i.rule_code === "R_WINDOW");
    assert.ok(entry);
    assert.match(entry.text, /睡前停用/);
    assert.equal(entry.agreement_version, 1);

    // 单条判定解释
    const one = await call(base, "GET", `/decisions/${decision.body.event_id}`);
    assert.equal(one.status, 200);
    assert.match(one.body.text, /22:00/);

    // HTML 账户页
    const page = await fetch(base + "/members/u1/page");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /睡前停用/);
    assert.match(html, /我的节律约定/);
  });
});

test("HTTP 离线消费：重传不多扣，预算三产品共享", async () => {
  await withServer(async (base, svc) => {
    currentMs = Date.parse("2026-09-20T12:00:00+08:00");
    await call(base, "POST", "/members", { member_id: "u2", time_zone: "Asia/Shanghai" });
    await call(base, "POST", "/members/u2/devices", { device_id: "dev1" });
    await call(base, "POST", "/members/u2/agreements", {
      time_zone: "Asia/Shanghai",
      blocked_windows: [{ from: "23:00", to: "06:00" }],
      daily_cap_minutes: 120,
      continuous_max_minutes: 90,
      reminder_level: "STANDARD",
      extension_allow_prompt: false,
      extension_max_extra_minutes: 0,
    });

    const start = currentMs;
    const payload = {
      member_id: "u2",
      device_id: "dev1",
      anchor: { device_ms: start + 20 * T + 1000, device_seq: 10_001 },
      records: [
        {
          client_record_id: "http-1",
          product: "SHORT_DRAMA",
          device_clock_start: start,
          device_clock_end: start + 20 * T,
          device_seq: 1,
        },
      ],
    };
    const first = await call(base, "POST", "/consume/offline", payload);
    assert.equal(first.body.total_added_ms, 20 * T);
    const second = await call(base, "POST", "/consume/offline", payload);
    assert.equal(second.body.total_added_ms, 0);
    assert.equal(second.body.accepted[0].duplicated, true);

    const budget = await call(base, "GET", "/members/u2/budget");
    assert.equal(budget.body.used_ms, 20 * T);
    void svc;
  });
});

test("HTTP 紧急公益审批流：普通内容阻断，公益内容放行", async () => {
  await withServer(async (base) => {
    currentMs = Date.parse("2026-09-20T19:00:00+08:00");
    await call(base, "POST", "/members", { member_id: "u3", time_zone: "Asia/Shanghai" });
    await call(base, "POST", "/members/u3/devices", { device_id: "dev1" });
    await call(base, "POST", "/members/u3/agreements", {
      time_zone: "Asia/Shanghai",
      blocked_windows: [{ from: "23:00", to: "06:00" }],
      daily_cap_minutes: 30,
      continuous_max_minutes: 90,
      reminder_level: "STANDARD",
      extension_allow_prompt: false,
      extension_max_extra_minutes: 0,
    });
    const start = currentMs;
    await call(base, "POST", "/consume/offline", {
      member_id: "u3",
      device_id: "dev1",
      anchor: { device_ms: start + 30 * T + 1000, device_seq: 10_001 },
      records: [
        {
          client_record_id: "c1",
          product: "SHORT_DRAMA",
          device_clock_start: start,
          device_clock_end: start + 30 * T,
          device_seq: 1,
        },
      ],
    });
    currentMs = start + 31 * T;

    const normal = await call(base, "POST", "/decisions/evaluate", {
      member_id: "u3",
      device_id: "dev1",
      product: "LIVE",
      feature: "PLAYBACK",
      content_id: "normal",
    });
    assert.equal(normal.body.action, "BLOCK");

    await call(base, "POST", "/emergency/tickets", {
      ticket_id: "t1",
      content_id: "em-content",
      title: "应急科普",
      submitted_by: "ops",
    });
    await call(base, "POST", "/emergency/approve", {
      ticket_id: "t1",
      content_id: "em-content",
      reviewer_id: "rev1",
      valid_from_ms: currentMs,
      valid_to_ms: currentMs + 60 * T,
    });
    const em = await call(base, "POST", "/decisions/evaluate", {
      member_id: "u3",
      device_id: "dev1",
      product: "LIVE",
      feature: "PLAYBACK",
      content_id: "em-content",
    });
    assert.equal(em.body.action, "ALLOW");
    assert.equal(em.body.rule_code, "R_EMERGENCY");
  });
});
