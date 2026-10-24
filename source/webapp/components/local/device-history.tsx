"use client";
import { useCallback, useEffect, useState } from "react";
import { Clock3, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type ConfigRecord = { id: number; created_at: string; is_active?: number | boolean; modes?: string[]; refresh_minutes?: number; city?: string };
type ContentRecord = { id: number; mode_id: string; time: string; content: Record<string, unknown> };
export function DeviceHistory({ mac, tr }: { mac: string; tr: (zh: string, en: string) => string }) {
  const [configs, setConfigs] = useState<ConfigRecord[]>([]);
  const [content, setContent] = useState<ContentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const base = encodeURIComponent(mac);
      const [configResponse, historyResponse] = await Promise.all([fetch(`/api/config/${base}/history`, { cache: "no-store" }), fetch(`/api/device/${base}/history?limit=20`, { cache: "no-store" })]);
      if (!configResponse.ok || !historyResponse.ok) throw new Error(tr("历史记录读取失败，请重试。", "Could not load history. Please retry."));
      setConfigs((await configResponse.json()).configs || []); setContent((await historyResponse.json()).history || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
    finally { setLoading(false); }
  }, [mac, tr]);
  useEffect(() => { if (show) void load(); }, [load, show]);
  async function restore(id: number) {
    if (!confirm(tr("使用这份历史配置替换当前配置？当前配置仍会保留在历史中。页面中的未保存修改将被放弃。", "Activate this saved configuration? The current one remains in history. Unsaved page edits will be discarded."))) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/config/${encodeURIComponent(mac)}/activate/${id}`, { method: "PUT" });
      if (!response.ok) throw new Error(tr("恢复配置失败，请重试。", "Could not activate configuration."));
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); setBusy(false); }
  }
  return <details className="local-panel mt-6" onToggle={(event) => setShow(event.currentTarget.open)}>
    <summary className="font-semibold min-h-11 flex items-center gap-2 cursor-pointer"><Clock3 size={18} />{tr("配置与内容历史", "Configuration & content history")}</summary>
    <div className="pt-4">
      {error && <p className="text-sm text-red-700 mb-3" role="alert">{error}</p>}
      {loading ? <p className="flex gap-2 text-sm text-ink-light"><Loader2 size={16} className="animate-spin" />{tr("读取历史中…", "Loading history…")}</p> : <>
        <div className="flex items-center justify-between mb-3"><h3 className="font-medium text-sm">{tr("配置快照", "Configuration snapshots")}</h3><Button variant="ghost" size="sm" onClick={() => void load()} aria-label={tr("刷新历史", "Refresh history")}><RefreshCw size={16} /></Button></div>
        {configs.length ? <div className="space-y-3">{configs.map((item) => <div key={item.id} className="flex items-center justify-between flex-wrap gap-3 border-b border-ink/10 pb-3"><div><p className="text-sm">{new Date(item.created_at).toLocaleString()}</p><p className="text-xs text-ink-light mt-1">{(item.modes || []).join(" · ")}</p></div>{item.is_active ? <span className="text-xs text-ink-light">{tr("使用中", "Active")}</span> : <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(item.id)}>{tr("恢复这份配置", "Activate")}</Button>}</div>)}</div> : <p>{tr("还没有配置历史。", "No configuration history yet.")}</p>}
        <h3 className="font-medium text-sm mt-7 mb-4">{tr("最近显示的内容", "Recently displayed")}</h3>
        {content.length ? <div className="space-y-3">{content.map((item) => <details key={item.id} className="rounded-xl bg-paper p-3"><summary className="text-sm cursor-pointer min-h-11 flex items-center justify-between gap-3"><span>{item.mode_id}</span><span className="text-xs text-ink-light">{new Date(item.time).toLocaleString()}</span></summary><div className="pt-3 space-y-2">{Object.entries(item.content).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => <p key={key} className="text-sm break-words">{String(value)}</p>)}</div></details>)}</div> : <p>{tr("设备刷新后，内容会记录在这里。", "Content appears here after your display refreshes.")}</p>}
      </>}
    </div>
  </details>;
}
