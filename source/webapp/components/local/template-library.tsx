"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Upload, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
type Template = { id: number; mode_id: string; name: string; description: string; definition: Record<string, unknown> };

export function TemplateLibrary({ mac, onApplied, tr }: { mac: string; onApplied: () => void; tr: (zh: string, en: string) => string }) {
  const [items, setItems] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { const response = await fetch("/api/local/templates", { cache: "no-store" }); if (!response.ok) throw new Error(tr("本地模板暂时无法读取", "Cannot load local templates")); const data = await response.json(); setItems(data.templates || []); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
  }, [tr]);
  useEffect(() => { void load(); }, [load]);
  async function importFile(file: File) {
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > 1024 * 1024) throw new Error(tr("请选择小于 1MB 的模板 JSON", "Select a template JSON smaller than 1 MB"));
      const parsed = JSON.parse(await file.text());
      const response = await fetch("/api/local/templates/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: parsed.definition || parsed }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || data.detail || tr("模板导入失败", "Import failed"));
      await load(); setNotice(tr("模板已导入到本地内容库", "Template imported into your local library"));
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed"); }
    finally { setBusy(false); }
  }
  async function apply(item: Template) {
    if (!mac) { setError(tr("请先选择设备", "Select a device first")); return; }
    setBusy(true); setError("");
    try { const response = await fetch("/api/modes/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...item.definition, mac }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Failed"); onApplied(); setNotice(tr("模板已加入设备的自定义内容，可预览并加入轮播", "Template added to custom content. Preview it or add it to your rotation.")); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }
  return <section className="local-panel mb-6">
    <div className="local-panel-header"><div><h2>{tr("本地模板", "Local templates")}</h2><p>{tr("保存自己的布局，也可以从文件导入。", "Keep your layouts here, or import them from a file.")}</p></div><Button variant="outline" size="sm" onClick={() => picker.current?.click()} disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}{tr("导入模板", "Import")}</Button></div>
    <input ref={picker} type="file" accept="application/json,.json" hidden onChange={(e) => { const file = e.target.files?.[0]; e.currentTarget.value = ""; if (file) void importFile(file); }} />
    {error && <p role="alert" className="text-red-700 mb-3">{error}</p>}{notice && <p role="status" className="mb-3">{notice}</p>}
    {items.length ? <div className="space-y-3">{items.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-t border-ink/10 pt-3 flex-wrap"><div><h3 className="text-sm font-medium">{item.name || item.mode_id}</h3><p>{item.description}</p></div><div className="flex gap-2"><a href={`/api/local/templates/${item.id}/export`} download className="inline-flex items-center justify-center gap-2 min-h-11 px-3 text-sm rounded-xl border border-ink/15"><Download size={15} />{tr("导出", "Export")}</a><Button variant="outline" size="sm" onClick={() => void apply(item)} disabled={busy || !mac}><Plus size={15} />{tr("用于设备", "Use")}</Button></div></div>)}</div> : <p>{tr("还没有导入模板。下方的内置模式可直接使用。", "No templates yet. Built-in modes below are ready to use.")}</p>}
  </section>;
}
