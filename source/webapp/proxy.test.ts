import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

test("proxy does not trust a spoofed forwarded host", () => {
  const response = proxy(new NextRequest("http://untrusted.example/api/local/backup", { headers: { host: "untrusted.example", "x-forwarded-host": "localhost:3000" } }));
  assert.equal(response.status, 404);
});

test("proxy rejects unknown hosts", () => {
  const req = new NextRequest("https://zhigu.chat/api/preview", {
    headers: {
      host: "zhigu.chat",
      "x-forwarded-host": "zhigu.chat",
      "x-forwarded-proto": "https",
    },
  });

  const res = proxy(req);

  assert.equal(res.status, 404);
});

test("proxy rejects backend-only host on the web app", () => {
  const req = new NextRequest("https://web.inksight.site/config", {
    headers: {
      host: "web.inksight.site",
      "x-forwarded-host": "web.inksight.site",
      "x-forwarded-proto": "https",
    },
  });

  const res = proxy(req);

  assert.equal(res.status, 404);
});

test("proxy allows an explicitly configured local hostname", () => {
  const previous = process.env.INKSIGHT_ALLOWED_WEB_HOSTS;
  process.env.INKSIGHT_ALLOWED_WEB_HOSTS = "frame.home";
  try {
    const response = proxy(new NextRequest("http://frame.home/config", { headers: { host: "frame.home" } }));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://frame.home/zh/config");
  } finally { if (previous === undefined) delete process.env.INKSIGHT_ALLOWED_WEB_HOSTS; else process.env.INKSIGHT_ALLOWED_WEB_HOSTS = previous; }
});

test("proxy allows localhost development hosts", () => {
  const req = new NextRequest("http://localhost:3000/api/preview", {
    headers: {
      host: "localhost:3000",
    },
  });

  const res = proxy(req);

  assert.equal(res.status, 200);
});

test("LAN login URLs redirect directly to configuration without a session", () => {
  const previous = process.env.INKSIGHT_AUTH_MODE;
  process.env.INKSIGHT_AUTH_MODE = "lan";
  try {
    for (const [path, target] of [["/login", "/zh/config"], ["/zh/login", "/zh/config"], ["/en/login", "/en/config"]]) {
      const res = proxy(new NextRequest(`http://localhost:3000${path}`));
      assert.equal(res.status, 307);
      assert.equal(res.headers.get("location"), `http://localhost:3000${target}`);
    }
    const next = "/zh/config?mac=AA%3ABB%3ACC%3ADD%3AEE%3AFF";
    const res = proxy(new NextRequest(`http://localhost:3000/zh/login?next=${encodeURIComponent(next)}`));
    assert.equal(res.headers.get("location"), `http://localhost:3000${next}`);
    for (const next of ["https://example.com", "//example.com", "/zh/login", "/login?next=/login"]) {
      const res = proxy(new NextRequest(`http://localhost:3000/login?next=${encodeURIComponent(next)}`));
      assert.equal(res.headers.get("location"), "http://localhost:3000/zh/config");
    }
  } finally {
    if (previous === undefined) delete process.env.INKSIGHT_AUTH_MODE;
    else process.env.INKSIGHT_AUTH_MODE = previous;
  }
});
