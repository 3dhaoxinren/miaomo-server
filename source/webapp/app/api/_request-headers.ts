import type { NextRequest } from "next/server";

/** Preserve browser provenance for the backend's local-origin checks. */
export function browserProvenance(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of ["origin", "referer"]) {
    const value = req.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  // Host is validated by proxy.ts. Never trust client-supplied forwarding headers.
  headers["x-forwarded-host"] = req.headers.get("host")?.split(",")[0]?.trim() || req.nextUrl.host;
  headers["x-forwarded-proto"] = req.nextUrl.protocol.replace(/:$/, "");
  return headers;
}
