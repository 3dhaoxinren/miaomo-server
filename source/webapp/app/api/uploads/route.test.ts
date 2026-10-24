import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

test("POST forwards upload with real local host and unmodified browser provenance", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "tiny.png", { type: "image/png" }));

  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(input);
    calledInit = init;
    return new Response(
      JSON.stringify({
        ok: true,
        id: "abc",
        url: "http://localhost:3000/api/uploads/abc",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const req = new NextRequest("http://localhost:3000/api/uploads", {
    method: "POST",
    body: form,
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "www.inksight.site",
      "x-forwarded-proto": "https",
      origin: "https://untrusted.example",
      referer: "https://untrusted.example/form",
    },
  });

  try {
    const res = await POST(req);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(calledUrl, "http://127.0.0.1:8080/api/uploads");
    assert.equal(calledInit?.method, "POST");
    assert.equal((calledInit?.headers as Record<string, string>)["x-forwarded-host"], "localhost:3000");
    assert.equal((calledInit?.headers as Record<string, string>)["x-forwarded-proto"], "http");
    assert.equal((calledInit?.headers as Record<string, string>).origin, "https://untrusted.example");
    assert.equal((calledInit?.headers as Record<string, string>).referer, "https://untrusted.example/form");
    assert.equal((calledInit?.headers as Record<string, string>)["x-upload-content-type"], "image/png");
    assert.match(String(data.url), /^http:\/\/localhost:3000\/api\/uploads\/.+$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
