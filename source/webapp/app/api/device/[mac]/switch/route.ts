import { NextRequest } from "next/server";
import { proxyPost } from "../../../_proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac } = await params;
  return proxyPost(`/api/device/${encodeURIComponent(mac)}/switch`, req);
}
