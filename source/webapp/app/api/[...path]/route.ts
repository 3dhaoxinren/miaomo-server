import { NextRequest, NextResponse } from "next/server";
import { browserProvenance } from "../_request-headers";

export const dynamic = "force-dynamic";

// Resolve at request time: the same image is used for staging and the live router.
async function forward(req: NextRequest) {
  const base = (process.env.INKSIGHT_BACKEND_API_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");
  const path = req.nextUrl.pathname;
  if (!path.startsWith("/api/")) return new NextResponse(null, { status: 404 });
  const headers = new Headers(browserProvenance(req));
  for (const key of ["content-type", "x-device-token", "accept"]) {
    const value = req.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const upstream = await fetch(`${base}${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
    });
    const output = new Headers({ "cache-control": "no-store" });
    for (const key of ["content-type", "content-disposition", "x-cache-hit"]) {
      const value = upstream.headers.get(key);
      if (value) output.set(key, value);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers: output });
  } catch {
    return NextResponse.json({ error: "本地服务暂时无法连接，请稍后重试" }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
