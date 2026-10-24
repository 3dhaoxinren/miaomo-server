"use client";
import { useEffect, useState } from "react";
import { Image as ImageIcon, Plus, Pencil, ArrowLeft, ArrowRight, Trash2, Loader2, Expand, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localPhotoSource } from "@/lib/local-photo-source";
import type { PhotoEdit } from "@/lib/photo-editor";
import { photoPreviewIdentity } from "@/lib/photo-workspace";

type Props = {
  images: string[]; edits: PhotoEdit[]; width: number; height: number; uploading: boolean; saving: boolean;
  preview: string | null; previewLoading: boolean; status: string; deviceName: string; interval: number;
  mac: string; colors: number; previewIdentity: string | null; onPreviewInvalidated: () => void;
  onAdd: () => void; onEdit: (index: number) => void; onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void; onSave: () => void; onPreview: (index: number, identity: string) => void;
  tr: (zh: string, en: string) => string;
};

export function FramePanel({ images, edits, width, height, uploading, saving, preview, previewLoading, status, deviceName, interval, mac, colors, previewIdentity, onPreviewInvalidated, onAdd, onEdit, onMove, onRemove, onSave, onPreview, tr }: Props) {
  const [index, setIndex] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const current = Math.min(index, Math.max(0, images.length - 1));
  const identity = photoPreviewIdentity(mac, width, height, colors, images[current] || "", edits[current]);
  const visiblePreview = Boolean(showPreview && preview && previewIdentity === identity);
  const source = visiblePreview ? preview : images[current];
  useEffect(() => { setShowPreview(false); onPreviewInvalidated(); }, [identity, onPreviewInvalidated]);
  const portrait = edits[current]?.orientation === "portrait";
  const displayWidth = portrait ? height : width;
  const displayHeight = portrait ? width : height;
  // Portrait uploads are stored clockwise in the firmware's physical pixel buffer.
  const imageStyle = portrait ? { width: `${width / height * 100}%`, height: `${height / width * 100}%`, transform: "translate(-50%, -50%) rotate(-90deg)" } : undefined;
  return <div className="frame-layout">
    <section aria-label={tr("相框画面", "Frame image")}>
      <div className="frame-stage">
        {source ? <div className={`photo-frame${portrait ? " is-portrait" : ""}`}>
          <div className="frame-image" style={{ aspectRatio: `${displayWidth}/${displayHeight}` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={localPhotoSource(source)} style={imageStyle} alt={visiblePreview ? tr("墨水屏效果预览", "E-ink preview") : tr(`相框照片 ${current + 1}`, `Frame photo ${current + 1}`)} />
          </div>
        </div> : <div className="frame-empty"><ImageIcon size={48} strokeWidth={1.2} /><strong>{tr("从一张照片开始", "Start with a photo")}</strong><p>{tr("把喜欢的照片放进相框，让每一次抬头都有好心情。", "Bring a favorite moment to your everyday space.")}</p><Button onClick={onAdd}><Plus size={17} />{tr("从相册添加", "Add from album")}</Button></div>}
      </div>
      <div className="frame-caption"><span><Expand size={14} />{displayWidth} × {displayHeight}</span><span>{visiblePreview ? tr("墨水屏预览", "E-ink preview") : tr("照片预览", "Photo preview")}{images.length > 0 && ` · ${current + 1} / ${images.length}`}</span></div>
      <div className="frame-actions">
        <Button variant="outline" onClick={() => { setShowPreview(false); onEdit(current); }} disabled={!images.length || saving}><Pencil size={16} />{tr("编辑照片", "Edit photo")}</Button>
        <Button variant="outline" onClick={() => { setShowPreview(true); onPreview(current, identity); }} disabled={!images.length || saving || previewLoading}>{previewLoading ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}{previewLoading ? tr("正在生成", "Generating") : tr("墨水屏效果", "E-ink preview")}</Button>
      </div>
    </section>
    <div>
      <section className="local-panel frame-album-panel">
        <div className="local-panel-header"><h2>{tr("相册", "Your album")}</h2><small>{images.length} / 6</small></div>
        <div className="album-strip">
          {images.map((url, i) => <div key={`${url}-${i}`} className={`album-photo ${current === i ? "is-selected" : ""}`}>
            <button type="button" aria-label={tr(`查看照片 ${i + 1}`, `View photo ${i + 1}`)} aria-pressed={current === i} onClick={() => { setIndex(i); setShowPreview(false); }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={localPhotoSource(url)} style={edits[i]?.orientation === "portrait" ? { transform: "rotate(-90deg)" } : undefined} alt="" loading="lazy" /><span>{String(i + 1).padStart(2, "0")}</span>
            </button>
            <div className="album-tools"><button type="button" aria-label={tr(`照片 ${i + 1} 前移`, `Move photo ${i + 1} earlier`)} disabled={i === 0 || saving} onClick={() => { onMove(i, i - 1); setIndex(i - 1); }}><ArrowLeft size={14} /></button><button type="button" aria-label={tr(`编辑照片 ${i + 1}`, `Edit photo ${i + 1}`)} disabled={saving} onClick={() => { setShowPreview(false); onEdit(i); }}><Pencil size={14} /></button><button type="button" aria-label={tr(`照片 ${i + 1} 后移`, `Move photo ${i + 1} later`)} disabled={i === images.length - 1 || saving} onClick={() => { onMove(i, i + 1); setIndex(i + 1); }}><ArrowRight size={14} /></button></div>
          </div>)}
          {images.length < 6 && <button type="button" className="album-add" onClick={onAdd} disabled={uploading || saving}>{uploading ? <Loader2 size={22} className="animate-spin" /> : <Plus size={24} strokeWidth={1.4} />}<span>{uploading ? tr("上传中", "Uploading") : tr("添加照片", "Add photo")}</span></button>}
        </div>
        <div className="album-actions"><Button variant="ghost" size="sm" onClick={() => { if (confirm(tr("从相框中移除这张照片？原始文件仍保留在本地。", "Remove this photo from the frame? The local file is kept."))) onRemove(current); }} disabled={!images.length || saving}><Trash2 size={14} />{tr("移除所选", "Remove selected")}</Button></div>
        <p className="mt-3">{tr("照片按顺序播放。点开编辑，可调整横竖屏、裁剪、旋转和缩放。", "Photos play in order. Edit to crop, rotate, zoom and change orientation.")}</p>
      </section>
      <section className="local-panel frame-detail">
        <h2>{tr("送到你的墨水屏", "Send to your display")}</h2>
        <dl><div><dt>{tr("当前设备", "Device")}</dt><dd>{deviceName}</dd></div><div><dt>{tr("设备状态", "Status")}</dt><dd>{status}</dd></div><div><dt>{tr("轮播间隔", "Interval")}</dt><dd>{interval} {tr("分钟", "min")}</dd></div><div><dt>{tr("照片数量", "Photos")}</dt><dd>{images.length} {tr("张", "photos")}</dd></div></dl>
        <Button className="w-full mt-6" onClick={onSave} disabled={saving || uploading}>{saving ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}{saving ? tr("正在保存", "Saving") : tr("保存相框并刷新", "Save frame & refresh")}</Button>
        <p className="mt-3">{tr("设置保存在软路由。休眠中的设备会在下次唤醒时更新。", "Saved on your router. Sleeping devices update on their next wake.")}</p>
      </section>
    </div>
  </div>;
}
