import { NextRequest } from "next/server";
import { proxyPost } from "../../../_proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac } = await params;
  const query = req.nextUrl.search || "";
  return proxyPost(`/api/device/${encodeURIComponent(mac)}/apply-preview${query}`, req);
}
