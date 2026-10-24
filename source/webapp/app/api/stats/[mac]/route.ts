import { NextRequest } from "next/server";
import { proxyGet } from "../../_proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac } = await params;
  return proxyGet(`/api/stats/${encodeURIComponent(mac)}`, req);
}
