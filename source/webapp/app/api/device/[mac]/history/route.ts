import { NextRequest } from "next/server";
import { proxyGet } from "../../../_proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac } = await params;
  const qs = req.nextUrl.search;
  return proxyGet(`/api/device/${encodeURIComponent(mac)}/history${qs}`, req);
}
