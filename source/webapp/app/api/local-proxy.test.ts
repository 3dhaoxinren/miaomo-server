import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, PUT } from "./[...path]/route";
import { proxyPost } from "./_proxy";

test("local proxy preserves cross-site origin for backend rejection and ignores spoofed forwarding headers", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("origin"), "https://untrusted.example");
    assert.equal(headers.get("referer"), "https://untrusted.example/attack");
    assert.equal(headers.get("x-forwarded-host"), "localhost:13000");
    assert.equal(headers.get("x-forwarded-proto"), "http");
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  };
  const request = () => new NextRequest("http://localhost:13000/api/local/settings/llm", { method: "PUT", body: "{}", headers: { host: "localhost:13000", origin: "https://untrusted.example", referer: "https://untrusted.example/attack", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "https", "content-type": "application/json" } });
  try {
    assert.equal((await PUT(request())).status, 403);
    assert.equal((await proxyPost("/api/config", request())).status, 403);
  } finally { globalThis.fetch = original; }
});

test("local proxy keeps backup bytes and disposition, resolving backend at request time", async () => {
  const original = globalThis.fetch; const previous = process.env.INKSIGHT_BACKEND_API_BASE;
  const archive = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 128, 42]);
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(new Headers(init?.headers).get("origin"), null);
    return new Response(archive, { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="backup.zip"' } });
  };
  try {
    for (const port of [18080, 8080]) {
      process.env.INKSIGHT_BACKEND_API_BASE = `http://127.0.0.1:${port}`;
      const response = await GET(new NextRequest("http://localhost:13000/api/local/backup"));
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), archive);
      assert.equal(response.headers.get("content-disposition"), 'attachment; filename="backup.zip"');
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(urls, ["http://127.0.0.1:18080/api/local/backup", "http://127.0.0.1:8080/api/local/backup"]);
  } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.INKSIGHT_BACKEND_API_BASE; else process.env.INKSIGHT_BACKEND_API_BASE = previous; }
});
