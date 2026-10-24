import { NextRequest } from "next/server";
import { proxyGet } from "../_proxy";

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search;
  return proxyGet(`/api/preview${qs}`, req);
}
