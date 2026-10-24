"use client";
import { ArrowUp, ArrowDown, Settings2, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RotationQueue({ modes, labels, onChange, onSettings, onBrowse, tr }: {
  modes: string[]; labels: Record<string, { name: string; tip: string }>; onChange: (modes: string[]) => void;
  onSettings: (mode: string) => void; onBrowse: () => void; tr: (zh: string, en: string) => string;
}) {
  const move = (from: number, to: number) => { const next = [...modes]; next.splice(to, 0, next.splice(from, 1)[0]); onChange(next); };
  return <section className="local-panel mb-6">
    <div className="local-panel-header"><div><h2>{tr("播放清单", "Playback queue")}</h2><p>{tr("用你喜欢的内容，安排一天的节奏。", "Make room for the things you want to see.")}</p></div><Button variant="outline" size="sm" onClick={onBrowse}><Plus size={16} />{tr("添加内容", "Add content")}</Button></div>
    {modes.length ? <div className="rotation-list">{modes.map((mode, i) => <div key={mode} className="rotation-row"><span>{String(i + 1).padStart(2, "0")}</span><strong>{labels[mode]?.name || mode}</strong><button aria-label={tr("向前移动", "Move up")} disabled={!i} onClick={() => move(i, i - 1)}><ArrowUp size={16} /></button><button aria-label={tr("向后移动", "Move down")} disabled={i === modes.length - 1} onClick={() => move(i, i + 1)}><ArrowDown size={16} /></button><button aria-label={tr("内容设置", "Content settings")} onClick={() => onSettings(mode)}><Settings2 size={16} /></button><button aria-label={tr("移出轮播", "Remove from queue")} onClick={() => onChange(modes.filter((item) => item !== mode))}><X size={16} /></button></div>)}</div> : <p>{tr("还没有播放内容，从内容库添加一个喜欢的模式。", "Your queue is empty. Add a mode from the library.")}</p>}
  </section>;
}
