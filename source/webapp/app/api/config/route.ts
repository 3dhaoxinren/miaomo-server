import { NextRequest } from "next/server";
import { proxyPost } from "../_proxy";

export async function POST(req: NextRequest) {
  return proxyPost("/api/config", req, { "x-inksight-client": "webapp-config" });
}
