"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, ImageOff, LoaderCircle, Redo2, RotateCcw, RotateCw, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  beginPhotoGesture, drawPhoto, drawPhotoFilter, endPhotoGesture, exportPhoto, movePhotoGesture,
  exportedPhotoEdit, newPhotoEdit, newPhotoGesture, panPhotoBy, readPhotoEdit, samePhotoEdit, samePhotoGeometry, zoomPhotoAt,
  type PhotoColorProfile, type PhotoEdit, type PhotoPoint, type PhotoViewport,
} from "@/lib/photo-editor";
import { localPhotoSource } from "@/lib/local-photo-source";
import { PhotoColorError } from "@/lib/photo-color-profile";
import styles from "./photo-editor.module.css";

export function PhotoEditor({ initial, width, height, colors, tr, onCancel, onSave, onFilterPreview }: {
  initial: PhotoEdit;
  width: number;
  height: number;
  colors: number;
  tr: (zh: string, en: string) => string;
  onCancel: () => void;
  onSave: (file: File | null, edit: PhotoEdit, variantUrl?: string) => Promise<void>;
  onFilterPreview: (edit: PhotoEdit, original: HTMLImageElement | null, signal: AbortSignal) => Promise<HTMLImageElement>;
}) {
  const [initialEdit] = useState(() => readPhotoEdit(initial, initial.source_url));
  const [edit, setEdit] = useState<PhotoEdit>(initialEdit);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [tab, setTab] = useState<"crop" | "filters">("crop");
  const [filterLoading, setFilterLoading] = useState(false);
  const [filterError, setFilterError] = useState("");
  const [filterView, setFilterView] = useState<{ key: string; image: HTMLImageElement } | null>(null);
  const filterRequest = useRef(0);
  const filterAbort = useRef<AbortController | null>(null);
  const filterCache = useRef(new Map<string, HTMLImageElement>());
  const canvas = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const discardDialog = useRef<HTMLDivElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const closeTrigger = useRef<HTMLElement | null>(null);
  const editRef = useRef(initialEdit);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const past = useRef<PhotoEdit[]>([]);
  const future = useRef<PhotoEdit[]>([]);
  const gesture = useRef(newPhotoGesture());
  const sequence = useRef(0);
  const gestureGroup = useRef<number | undefined>(undefined);
  const sliderGroup = useRef<number | undefined>(undefined);
  const lastGroup = useRef<number | undefined>(undefined);
  const wheelGroup = useRef({ time: 0, id: 0 });
  const titleId = useId();
  const hintId = useId();
  const zoomId = useId();
  const discardTitleId = useId();
  const portrait = edit.orientation === "portrait";
  const logicalWidth = portrait ? height : width;
  const logicalHeight = portrait ? width : height;
  const disabled = saving || !image;
  const resetEdit = { ...newPhotoEdit(initialEdit.source_url), color_profile: edit.color_profile, ...(edit.color_variants ? { color_variants: edit.color_variants } : {}) };
  const filterKey = JSON.stringify([width, height, colors, readPhotoEdit(edit, edit.source_url)]);
  const filterReady = Boolean(filterView?.key === filterKey);
  const reusableVariant = samePhotoGeometry(initialEdit, edit) ? edit.color_variants?.[edit.color_profile] : undefined;
  const canApply = !saving && !filterLoading && Boolean(image || reusableVariant);

  const cancelFilter = useCallback(() => {
    filterRequest.current += 1; filterAbort.current?.abort(); filterAbort.current = null;
    setFilterLoading(false);
  }, []);

  const viewportFor = useCallback((value: PhotoEdit): PhotoViewport | null => image ? {
    sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight,
    width: value.orientation === "portrait" ? height : width,
    height: value.orientation === "portrait" ? width : height,
  } : null, [image, width, height]);

  const applyEdit = useCallback((next: PhotoEdit, group?: number) => {
    if (samePhotoEdit(editRef.current, next)) return;
    cancelFilter(); setFilterView(null); setFilterError("");
    if (group === undefined || lastGroup.current !== group) {
      past.current = [...past.current.slice(-29), editRef.current];
    }
    future.current = [];
    lastGroup.current = group;
    editRef.current = next;
    setEdit(next);
    setHistory({ undo: past.current.length, redo: 0 });
    setError("");
  }, [cancelFilter]);

  const stopGesture = useCallback(() => {
    const ids = gesture.current.pointers.map((pointer) => pointer.id);
    gesture.current = newPhotoGesture();
    gestureGroup.current = undefined;
    sliderGroup.current = undefined;
    for (const id of ids) {
      if (canvas.current?.hasPointerCapture(id)) canvas.current.releasePointerCapture(id);
    }
  }, []);

  const undo = useCallback((redo = false) => {
    if (savingRef.current) return;
    stopGesture();
    const from = redo ? future : past;
    const to = redo ? past : future;
    const previous = from.current.at(-1);
    if (!previous) return;
    cancelFilter(); setFilterView(null); setFilterError("");
    from.current = from.current.slice(0, -1);
    to.current = [...to.current.slice(-29), editRef.current];
    lastGroup.current = undefined;
    editRef.current = previous;
    setEdit(previous);
    setHistory({ undo: past.current.length, redo: future.current.length });
    setError("");
  }, [stopGesture, cancelFilter]);

  const requestFilter = useCallback(async (candidate: PhotoEdit, commit = false) => {
    const request = ++filterRequest.current;
    filterAbort.current?.abort();
    const controller = new AbortController(); filterAbort.current = controller;
    const key = JSON.stringify([width, height, colors, readPhotoEdit(candidate, candidate.source_url)]);
    setFilterLoading(true); setFilterError("");
    try {
      const result = filterCache.current.get(key) || await onFilterPreview(candidate, image, controller.signal);
      if (!mounted.current || controller.signal.aborted || filterRequest.current !== request) return;
      filterCache.current.set(key, result);
      if (filterCache.current.size > 4) filterCache.current.delete(filterCache.current.keys().next().value!);
      if (commit) applyEdit(candidate);
      setFilterView({ key, image: result }); setFilterLoading(false);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || filterRequest.current !== request) return;
      if (error instanceof PhotoColorError && error.code === "stale") { setFilterLoading(false); return; }
      setFilterError(error instanceof Error ? error.message : tr("滤镜预览失败，请重试。", "Could not preview this filter. Please try again."));
      setFilterLoading(false);
    }
  }, [width, height, colors, onFilterPreview, image, applyEdit, tr]);

  const chooseFilter = (profile: PhotoColorProfile) => {
    stopGesture();
    void requestFilter({ ...editRef.current, color_profile: profile }, true);
  };

  const requestClose = () => {
    if (savingRef.current) return;
    if (samePhotoEdit(editRef.current, initialEdit)) { onCancel(); return; }
    stopGesture();
    closeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : closeButton.current;
    setShowDiscard(true);
  };

  const continueEditing = () => {
    setShowDiscard(false);
    requestAnimationFrame(() => closeTrigger.current?.focus({ preventScroll: true }));
  };

  useEffect(() => { if (showDiscard) continueButton.current?.focus(); }, [showDiscard]);

  useEffect(() => {
    if (colors < 4) setTab("crop");
  }, [colors]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => closeButton.current?.focus());
    return () => {
      mounted.current = false;
      filterRequest.current += 1; filterAbort.current?.abort();
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const img = new window.Image();
    let cancelled = false;
    setImage(null);
    setLoadError(false);
    setError("");
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth && img.naturalHeight) setImage(img);
      else setLoadError(true);
    };
    img.onerror = () => { if (!cancelled) setLoadError(true); };
    img.src = localPhotoSource(initial.source_url);
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [initial.source_url, loadAttempt]);

  useEffect(() => {
    if (tab !== "filters") { cancelFilter(); return; }
    if (colors >= 4 && !filterReady && (image || edit.color_variants?.[edit.color_profile])) void requestFilter(edit);
  }, [tab, colors, filterReady, image, edit, requestFilter, cancelFilter]);

  useEffect(() => {
    if (!canvas.current) return;
    try {
      if (tab === "filters") {
        if (!filterReady || !filterView) return;
        drawPhotoFilter(canvas.current, filterView.image, width, height, portrait);
      } else if (image) drawPhoto(canvas.current, image, logicalWidth, logicalHeight, edit);
    }
    catch { setError(tr("预览暂时无法绘制，请重新打开照片。", "The preview could not be drawn. Please reopen this photo.")); }
  }, [image, edit, logicalWidth, logicalHeight, tr, tab, filterReady, filterView, portrait, width, height]);

  const pointFor = useCallback((clientX: number, clientY: number): PhotoPoint | null => {
    const rect = canvas.current?.getBoundingClientRect();
    const view = viewportFor(editRef.current);
    if (!rect?.width || !rect.height || !view) return null;
    return { x: (clientX - rect.left) * view.width / rect.width, y: (clientY - rect.top) * view.height / rect.height };
  }, [viewportFor]);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const wheel = (event: WheelEvent) => {
      if (!image || tab === "filters" || savingRef.current || gesture.current.pointers.length) return;
      event.preventDefault();
      const point = pointFor(event.clientX, event.clientY);
      const current = editRef.current;
      const view = viewportFor(current);
      if (!point || !view) return;
      const now = performance.now();
      if (now - wheelGroup.current.time > 280 || !wheelGroup.current.id) wheelGroup.current.id = ++sequence.current;
      wheelGroup.current.time = now;
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.height : 1);
      applyEdit(zoomPhotoAt(current, view, current.zoom * Math.exp(-pixels * 0.0015), point), wheelGroup.current.id);
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [image, pointFor, viewportFor, applyEdit, tab]);

  const changeLayout = (patch: Partial<PhotoEdit>) => {
    stopGesture();
    applyEdit({ ...editRef.current, ...patch, offset_x: 0, offset_y: 0 });
  };

  const changeZoom = (zoom: number, group?: number) => {
    const current = editRef.current;
    const view = viewportFor(current);
    if (view) applyEdit(zoomPhotoAt(current, view, zoom, { x: view.width / 2, y: view.height / 2 }), group);
  };

  const startPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || tab === "filters" || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = pointFor(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!gesture.current.pointers.length) gestureGroup.current = ++sequence.current;
    gesture.current = beginPhotoGesture(gesture.current, event.pointerId, point, editRef.current);
  };

  const movePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || tab === "filters") return;
    const point = pointFor(event.clientX, event.clientY);
    const view = viewportFor(editRef.current);
    if (!point || !view) return;
    const next = movePhotoGesture(gesture.current, event.pointerId, point, view);
    gesture.current = next.gesture;
    if (next.edit) applyEdit(next.edit, gestureGroup.current);
  };

  const endPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    gesture.current = endPhotoGesture(gesture.current, event.pointerId, editRef.current);
    if (!gesture.current.pointers.length) gestureGroup.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const canvasKeyboard = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (disabled || tab === "filters" || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = editRef.current;
    const view = viewportFor(current);
    if (!view) return;
    const step = event.shiftKey ? 50 : 10;
    const directions: Record<string, PhotoPoint> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
    };
    if (directions[event.key]) {
      event.preventDefault(); stopGesture(); applyEdit(panPhotoBy(current, view, directions[event.key]));
    } else if (["+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault(); stopGesture(); changeZoom(current.zoom + (["-", "_"].includes(event.key) ? -0.1 : 0.1));
    }
  };

  const dialogKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); if (showDiscard) continueEditing(); else requestClose(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); if (!showDiscard) undo(event.shiftKey);
    }
    if (event.key !== "Tab") return;
    const activeDialog = discardDialog.current || dialog.current;
    const targets = Array.from(activeDialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex='0']") || [])
      .filter((element) => element.getClientRects().length && element.getAttribute("aria-disabled") !== "true");
    const first = targets[0];
    const last = targets.at(-1);
    if (!first) { event.preventDefault(); activeDialog?.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === activeDialog)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const save = async () => {
    if (!canApply || savingRef.current) return;
    stopGesture();
    const snapshot = { ...editRef.current };
    if (colors >= 4 && !filterReady) { setTab("filters"); if (tab === "filters") await requestFilter(snapshot); return; }
    savingRef.current = true;
    setSaving(true); setError("");
    try {
      const variant = samePhotoGeometry(initialEdit, snapshot) ? snapshot.color_variants?.[snapshot.color_profile] : undefined;
      if (variant) { await onSave(null, snapshot, variant); return; }
      if (!image) throw new Error(tr("原图不可用，请重新加载。", "Reload the original photo."));
      const output = exportPhoto(image, width, height, snapshot);
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error(tr("图片导出失败，请重试。", "Image export failed. Please try again."))), "image/png"));
      await onSave(new File([blob], "edited-photo.png", { type: "image/png" }), exportedPhotoEdit(snapshot));
    } catch (err) {
      if (mounted.current) setError(tr("应用失败，构图已保留。", "Could not apply the crop. Your edits are retained.") + " " + (err instanceof Error ? err.message : tr("请重试。", "Please try again.")));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div ref={dialog} className={styles.dialog} data-photo-editor role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={dialogKeyboard}>
        <header className={styles.header} inert={showDiscard}>
          <div><h2 id={titleId}>{tr("编辑照片", "Edit photo")}</h2><p>{tr("调整构图和滤镜，原图始终保留", "Adjust crop and filters. Your original is kept.")}</p></div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.iconButton} disabled={saving || !history.undo} onClick={() => undo()} title={tr("撤销（Ctrl / ⌘ Z）", "Undo (Ctrl / ⌘ Z)")} aria-label={tr("撤销", "Undo")}><Undo2 aria-hidden="true" /></button>
            <button type="button" className={styles.iconButton} disabled={saving || !history.redo} onClick={() => undo(true)} title={tr("重做（Ctrl / ⌘ Shift Z）", "Redo (Ctrl / ⌘ Shift Z)")} aria-label={tr("重做", "Redo")}><Redo2 aria-hidden="true" /></button>
            <button ref={closeButton} type="button" className={styles.iconButton} disabled={saving} onClick={requestClose} aria-label={tr("关闭图片编辑", "Close photo editor")}><X aria-hidden="true" /></button>
          </div>
        </header>

        <div className={styles.body} inert={showDiscard}>
          <section className={styles.preview} aria-label={tr("构图预览", "Crop preview")}>
            <div className={styles.stage}>
              <canvas ref={canvas} className={styles.canvas} hidden={tab === "filters" ? !filterReady : !image} tabIndex={disabled || tab === "filters" ? -1 : 0}
                role="img" aria-label={tab === "filters" ? tr("四色滤镜效果预览", "Four-color filter preview") : tr("照片裁切预览，可拖动或双指缩放", "Photo crop preview. Drag or pinch to adjust.")} aria-describedby={hintId}
                style={{ aspectRatio: `${logicalWidth} / ${logicalHeight}`, ...(tab === "filters" ? { cursor: "default" } : {}) }}
                onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer} onKeyDown={canvasKeyboard} />
              {tab === "filters" && !filterReady && <div className={styles.placeholder} role="status" aria-live="polite">
                {filterLoading ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <ImageOff aria-hidden="true" />}
                <strong>{filterLoading ? tr("正在生成滤镜效果…", "Generating filter preview…") : tr("滤镜预览尚未就绪", "Filter preview is not ready")}</strong>
                <p>{tr("预览由软路由生成，与保存到屏幕的配色一致。", "Your router renders the same palette used by the display.")}</p>
                {!filterLoading && <button type="button" className={styles.button} onClick={() => void requestFilter(editRef.current)}>{tr("重新预览", "Retry preview")}</button>}
              </div>}
              {tab === "crop" && !image && <div className={styles.placeholder} role={loadError ? "alert" : "status"}>
                {loadError ? <ImageOff aria-hidden="true" /> : <LoaderCircle className={styles.spinner} aria-hidden="true" />}
                <strong>{loadError ? tr("原图加载失败", "Could not load the original") : tr("正在加载原图…", "Loading original…")}</strong>
                <p>{loadError ? tr("请检查本地服务连接，然后重试。", "Check the local service connection and try again.") : tr("马上就可以调整构图", "Your photo will be ready to edit shortly.")}</p>
                {loadError && <button type="button" className={styles.button} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{tr("重新加载", "Try again")}</button>}
              </div>}
            </div>
            <p id={hintId} className={styles.previewHint}>
              <span>{tab === "filters" ? (edit.color_profile === "classic" ? tr("经典四色", "Classic four-color") : tr("自然暖调", "Natural warm")) : tr("拖动调整位置 · 双指缩放", "Drag to move · Pinch to zoom")}</span>
              {tab === "crop" && <span className={styles.keyboardHint}>{tr("方向键移动，＋ / − 缩放", "Arrow keys to move, + / − to zoom")}</span>}
              <span className={styles.dimensions}>{logicalWidth} × {logicalHeight}</span>
            </p>
          </section>

          <div className={styles.controls} aria-label={tr("编辑工具", "Editing tools")}>
            {colors >= 4 && <div className={`${styles.twoColumns} ${styles.editTabs}`} role="group" aria-label={tr("编辑方式", "Editing mode")}>
              <button type="button" className={styles.option} aria-pressed={tab === "crop"} disabled={saving} onClick={() => setTab("crop")}>{tr("构图", "Crop")}</button>
              <button type="button" className={styles.option} aria-pressed={tab === "filters"} disabled={saving} onClick={() => { stopGesture(); setTab("filters"); }}>{tr("滤镜", "Filters")}</button>
            </div>}
            {colors >= 4 && tab === "filters" && <fieldset className={styles.group} disabled={saving} aria-busy={filterLoading}>
              <legend>{tr("滤镜", "Filters")}</legend>
              <div className={styles.twoColumns}>
                {(["classic", "einkwarm"] as const).map((profile) => <button key={profile} type="button" className={styles.option} aria-pressed={edit.color_profile === profile} disabled={!image && !edit.color_variants?.[profile]} onClick={() => chooseFilter(profile)}>{profile === "classic" ? tr("经典四色", "Classic four-color") : tr("自然暖调", "Natural warm")}</button>)}
              </div>
              <p className={styles.helper}>{filterLoading ? tr("正在生成所选滤镜，可随时切换。", "Rendering your filter. You can switch at any time.") : tr("选好滤镜后使用此照片，原始全彩图片始终保留。", "Apply your chosen filter. The full-color original is kept.")}</p>
              {filterError && <p className={styles.error} role="alert">{filterError}</p>}
            </fieldset>}
            <div hidden={tab === "filters"}>
            <fieldset className={styles.group} disabled={disabled}>
              <legend>{tr("屏幕方向", "Screen orientation")}</legend>
              <div className={styles.twoColumns}>
                {(["landscape", "portrait"] as const).map((orientation) => <button key={orientation} type="button" className={styles.option} aria-pressed={edit.orientation === orientation} onClick={() => changeLayout({ orientation })}>
                  <span className={orientation === "landscape" ? styles.landscapeIcon : styles.portraitIcon} aria-hidden="true" />
                  {orientation === "landscape" ? tr("横屏", "Landscape") : tr("竖屏", "Portrait")}
                </button>)}
              </div>
              <p className={styles.helper}>{portrait ? tr("适合竖放的相框", "For a frame standing upright") : tr("适合横放的相框", "For a frame placed horizontally")}</p>
            </fieldset>

            <fieldset className={styles.group} disabled={disabled}>
              <legend>{tr("旋转照片", "Rotate photo")}</legend>
              <div className={styles.twoColumns}>
                <button type="button" className={styles.button} onClick={() => changeLayout({ rotation: (editRef.current.rotation + 270) % 360 })}><RotateCcw aria-hidden="true" />{tr("左转 90°", "Left 90°")}</button>
                <button type="button" className={styles.button} onClick={() => changeLayout({ rotation: (editRef.current.rotation + 90) % 360 })}><RotateCw aria-hidden="true" />{tr("右转 90°", "Right 90°")}</button>
              </div>
            </fieldset>

            <fieldset className={styles.group} disabled={disabled}>
              <legend>{tr("画面填充", "Image fit")}</legend>
              <div className={styles.twoColumns}>
                <button type="button" className={styles.option} aria-pressed={edit.fit === "cover"} onClick={() => changeLayout({ fit: "cover", zoom: 1 })}>{tr("铺满裁切", "Fill & crop")}</button>
                <button type="button" className={styles.option} aria-pressed={edit.fit === "contain"} onClick={() => changeLayout({ fit: "contain", zoom: 1 })}>{tr("完整显示", "Fit entire photo")}</button>
              </div>
              <p className={styles.helper}>{edit.fit === "contain" ? tr("保留整张照片，必要时留白", "Keep the entire photo, with white borders if needed") : tr("铺满相框，超出部分会被裁切", "Fill the frame; edges outside the frame are cropped")}</p>
            </fieldset>

            <div className={styles.zoomGroup}>
              <div className={styles.zoomLabel}><label htmlFor={zoomId}>{tr("缩放", "Zoom")}</label><output htmlFor={zoomId}>{Math.round(edit.zoom * 100)}%</output></div>
              <div className={styles.zoomControls}>
                <button type="button" className={styles.iconButton} disabled={disabled || edit.zoom <= 1} aria-label={tr("缩小照片", "Zoom out")} onClick={() => changeZoom(editRef.current.zoom - 0.1)}><ZoomOut aria-hidden="true" /></button>
                <input id={zoomId} className={styles.slider} type="range" min="1" max="4" step="0.01" value={edit.zoom} disabled={disabled} aria-valuetext={`${Math.round(edit.zoom * 100)}%`}
                  onPointerDown={() => { stopGesture(); sliderGroup.current = ++sequence.current; }}
                  onKeyDown={() => { if (sliderGroup.current === undefined) sliderGroup.current = ++sequence.current; }}
                  onPointerUp={() => { sliderGroup.current = undefined; }} onPointerCancel={() => { sliderGroup.current = undefined; }} onKeyUp={() => { sliderGroup.current = undefined; }} onBlur={() => { sliderGroup.current = undefined; }}
                  onChange={(event) => changeZoom(Number(event.target.value), sliderGroup.current)} />
                <button type="button" className={styles.iconButton} disabled={disabled || edit.zoom >= 4} aria-label={tr("放大照片", "Zoom in")} onClick={() => changeZoom(editRef.current.zoom + 0.1)}><ZoomIn aria-hidden="true" /></button>
              </div>
            </div>
            <button type="button" className={styles.resetButton} disabled={disabled || samePhotoEdit(edit, resetEdit)} onClick={() => { stopGesture(); applyEdit(resetEdit); }}><RotateCcw aria-hidden="true" />{tr("恢复原图构图", "Reset crop")}</button>
            </div>
          </div>
        </div>

        <footer className={styles.footer} inert={showDiscard}>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.footerRow}>
            <p className={styles.footerNote} aria-live="polite">{saving ? tr("正在处理并上传照片…", "Processing and uploading photo…") : tr("应用后，保存相框即可同步到屏幕。", "Save the frame after applying to sync your screen.")}</p>
            <div className={styles.footerActions}>
              <button type="button" className={styles.button} disabled={saving} onClick={requestClose}>{tr("取消", "Cancel")}</button>
              <button type="button" className={styles.applyButton} disabled={!canApply} onClick={save}>
                {saving ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <Check aria-hidden="true" />}
                {saving ? tr("正在应用…", "Applying…") : colors >= 4 && !filterReady ? tr("查看滤镜效果", "Preview filter") : tr("使用此照片", "Use this photo")}
              </button>
            </div>
          </div>
        </footer>
        {showDiscard && <div className={styles.discardBackdrop}>
          <div ref={discardDialog} className={styles.discardDialog} role="alertdialog" aria-modal="true" aria-labelledby={discardTitleId} tabIndex={-1}>
            <h3 id={discardTitleId}>{tr("要放弃这次修改吗？", "Discard these changes?")}</h3>
            <p>{tr("当前修改还没有应用。继续编辑可以保留这些调整。", "These changes have not been applied. Continue editing to keep your adjustments.")}</p>
            <div className={styles.discardActions}>
              <button type="button" className={styles.button} disabled={saving} onClick={() => { if (!savingRef.current) onCancel(); }}>{tr("放弃修改", "Discard changes")}</button>
              <button ref={continueButton} type="button" className={styles.applyButton} onClick={continueEditing}>{tr("继续编辑", "Keep editing")}</button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
