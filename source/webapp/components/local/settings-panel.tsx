"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Download, Loader2, Save, Server, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withLocalePath, type Locale } from "@/lib/i18n";

type LlmConfig = { llm_access_mode?: string; provider?: string; model?: string; api_key?: string; base_url?: string; image_provider?: string; image_model?: string; image_api_key?: string; image_base_url?: string };
type Settings = { edition: string; llm_config: LlmConfig | null; preferences?: { locale?: string; timezone?: string; widget_mode?: string } };

export function SettingsPanel({ locale, mac }: { locale: Locale; mac: string }) {
  const en = locale === "en";
  const [data, setData] = useState<Settings | null>(null);
  const [form, setForm] = useState<LlmConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/local/settings", { cache: "no-store" });
      if (!response.ok) throw new Error(en ? "Cannot load service settings." : "无法读取服务设置，请重试。");
      const next = await response.json() as Settings;
      setData(next);
      setForm({ ...(next.llm_config || { llm_access_mode: "custom_openai", provider: "openai_compat" }), api_key: "", image_api_key: "" });
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setLoading(false); }
  }, [en]);
  useEffect(() => { void load(); }, [load]);
  const set = (key: keyof LlmConfig, value: string) => { setForm((prev) => ({ ...prev, [key]: value })); setMessage(""); };
  async function save() {
    setSaving(true); setMessage(""); setError("");
    try {
      const body = { ...form };
      // Empty secrets are omitted so a model/URL edit never replaces the saved key.
      if (!body.api_key?.trim()) delete body.api_key;
      if (!body.image_api_key?.trim()) delete body.image_api_key;
      const response = await fetch("/api/local/settings/llm", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.detail || (en ? "Save failed" : "保存失败"));
      await load(); setMessage(en ? "Service settings saved." : "服务设置已保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setSaving(false); }
  }
  async function downloadBackup() {
    setBackup(true); setError("");
    try {
      const response = await fetch("/api/local/backup", { cache: "no-store" });
      if (!response.ok) throw new Error(en ? "Backup failed. Please try again." : "备份失败，请重试。");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `inksight-backup-${new Date().toISOString().slice(0, 10)}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(en ? "Backup downloaded." : "备份已下载，包含设备配置和照片。");
    } catch (e) { setError(e instanceof Error ? e.message : "Backup failed"); }
    finally { setBackup(false); }
  }
  const field = (key: keyof LlmConfig, label: string, placeholder = "", secret = false) => <label>{label}<input type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} value={form[key] || ""} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />{secret && <small>{en ? "Leave empty to keep the saved key." : "留空保留已保存的密钥。"}{data?.llm_config?.[key] ? ` ${en ? "Saved" : "已保存"}：${data.llm_config[key]}` : ""}</small>}</label>;
  return <div>
    {error && <div className="local-notice is-error" role="alert">{error}<button className="ml-auto underline" onClick={() => void load()}>{en ? "Retry" : "重试"}</button></div>}
    {message && <div className="local-notice" role="status"><Check size={18} />{message}</div>}
    <div className="local-settings">
      <section className="local-panel">
        <div className="local-panel-header"><div><h2>{en ? "AI service" : "AI 服务"}</h2><p>{en ? "Use your own model for generated content." : "为日常内容接入你自己的模型。"}</p></div><Server size={22} /></div>
        {loading ? <p className="flex gap-2 items-center"><Loader2 size={17} className="animate-spin" />{en ? "Loading settings…" : "正在读取设置…"}</p> : data ? <form className="local-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label>{en ? "Connection type" : "接入方式"}<select value={form.llm_access_mode || "preset"} onChange={(e) => setForm((prev) => ({ ...prev, llm_access_mode: e.target.value, provider: e.target.value === "custom_openai" ? "openai_compat" : "deepseek" }))}><option value="custom_openai">{en ? "OpenAI-compatible API" : "OpenAI 兼容接口"}</option><option value="preset">{en ? "Built-in provider" : "内置服务商"}</option></select></label>
          <div className="local-form-pair">{field("provider", en ? "Provider" : "服务商", "openai_compat")}{field("model", en ? "Model" : "模型名称", "model-name")}</div>
          {field("base_url", en ? "API address" : "接口地址", "https://api.example.com/v1")}
          {field("api_key", "API Key", en ? "Keep saved key" : "留空保留原密钥", true)}
          <details className="border-t border-ink/10 pt-4"><summary className="cursor-pointer min-h-11 text-sm font-medium">{en ? "Image generation service" : "图像生成服务"}</summary><div className="local-form pt-4"><div className="local-form-pair">{field("image_provider", en ? "Provider" : "服务商")}{field("image_model", en ? "Image model" : "图像模型")}</div>{field("image_base_url", en ? "API address" : "接口地址")}{field("image_api_key", "Image API Key", en ? "Keep saved key" : "留空保留原密钥", true)}</div></details>
          <Button type="submit" disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? (en ? "Saving…" : "保存中…") : (en ? "Save service settings" : "保存服务设置")}</Button>
        </form> : <Button onClick={() => void load()} variant="outline"><RefreshCw size={16} />{en ? "Retry" : "重新连接"}</Button>}
      </section>
      <div className="space-y-6">
        <section className="local-panel"><h2>{en ? "Your data, here" : "数据在这里"}</h2><p>{en ? "Devices, photos and configuration stay on this router." : "设备、照片和配置保存在这台软路由。"}</p><Button className="w-full mt-5" variant="outline" onClick={() => void downloadBackup()} disabled={backup}>{backup ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}{backup ? (en ? "Preparing backup…" : "正在准备备份…") : (en ? "Download full backup" : "下载完整备份")}</Button><details className="mt-4"><summary className="text-sm cursor-pointer min-h-11 flex items-center">{en ? "Restore a backup" : "如何恢复备份"}</summary><p>{en ? "Use the restore command included with this local edition while the service is stopped. It validates the archive before restoring the database and photos." : "使用本地版发行包中的恢复命令，在停止服务后恢复。工具会先校验备份，再还原数据库和照片。"}</p></details></section>
        <section className="local-panel"><h2>{en ? "Advanced tools" : "高级工具"}</h2><div className="local-link-list">
          <Link href={withLocalePath(locale, "/flash")}>{en ? "Firmware & OTA" : "刷机与固件升级"}<ArrowUpRight size={17} /></Link>
          <Link href={`${withLocalePath(locale, "/widget")}${mac ? `?mac=${encodeURIComponent(mac)}` : ""}`}>{en ? "Desktop widget" : "桌面挂件"}<ArrowUpRight size={17} /></Link>
          <Link href={withLocalePath(locale, "/docs")}>{en ? "Setup, voice & help" : "配网、语音与使用指南"}<ArrowUpRight size={17} /></Link>
        </div></section>
        <section className="local-panel"><h2>{en ? "About this home" : "关于本地版"}</h2><p>InkSight Local · {en ? "No account needed" : "无需账号"}</p><p className="mt-3">{en ? "Based on InkSight, distributed under the MIT license. Original project and third-party notices are included in the distribution." : "基于 InkSight，遵循 MIT 许可。发行包保留原项目与第三方来源署名。"}</p><a href="https://github.com/datascale-ai/inksight" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm underline mt-2">{en ? "Original project & license" : "原项目与许可"}<ArrowUpRight size={15} className="ml-1" /></a></section>
      </div>
    </div>
  </div>;
}
