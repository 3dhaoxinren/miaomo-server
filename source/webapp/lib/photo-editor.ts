export type PhotoColorProfile = "classic" | "einkwarm";
export type PhotoEdit = {
  source_url: string;
  orientation: "landscape" | "portrait";
  rotation: number;
  zoom: number;
  offset_x: number;
  offset_y: number;
  fit: "cover" | "contain";
  color_profile: PhotoColorProfile;
  color_variants?: Partial<Record<PhotoColorProfile, string>>;
};

export const newPhotoEdit = (url: string): PhotoEdit => ({
  source_url: url, orientation: "landscape", rotation: 0,
  zoom: 1, offset_x: 0, offset_y: 0, fit: "cover", color_profile: "einkwarm",
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function readPhotoEdit(value: unknown, fallbackUrl: string): PhotoEdit {
  if (!value || typeof value !== "object") return newPhotoEdit(fallbackUrl);
  const v = value as Partial<PhotoEdit>;
  const finite = (x: unknown, fallback: number) => typeof x === "number" && Number.isFinite(x) ? x : fallback;
  const variants: Partial<Record<PhotoColorProfile, string>> = {};
  if (v.color_variants && typeof v.color_variants === "object") {
    for (const key of ["classic", "einkwarm"] as const) {
      const url = v.color_variants[key];
      if (typeof url === "string" && url.trim()) variants[key] = url;
    }
  }
  return {
    source_url: typeof v.source_url === "string" && v.source_url ? v.source_url : fallbackUrl,
    orientation: v.orientation === "portrait" ? "portrait" : "landscape",
    rotation: ((Math.round(finite(v.rotation, 0) / 90) * 90) % 360 + 360) % 360,
    zoom: clamp(finite(v.zoom, 1), 1, 4),
    offset_x: clamp(finite(v.offset_x, 0), -1, 1),
    offset_y: clamp(finite(v.offset_y, 0), -1, 1),
    fit: v.fit === "contain" ? "contain" : "cover",
    color_profile: v.color_profile === "classic" ? "classic" : "einkwarm",
    ...(Object.keys(variants).length ? { color_variants: variants } : {}),
  };
}

export function samePhotoEdit(a: PhotoEdit, b: PhotoEdit): boolean {
  const left = readPhotoEdit(a, a.source_url);
  const right = readPhotoEdit(b, b.source_url);
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Exported geometry invalidates pre-rendered color variants, but retains the choice. */
export function exportedPhotoEdit(edit: PhotoEdit): PhotoEdit {
  const normalized = readPhotoEdit(edit, edit.source_url);
  const result = { ...normalized };
  delete result.color_variants;
  return result;
}

export function photoGeometryIdentity(edit: PhotoEdit): string {
  const normalized = exportedPhotoEdit(edit);
  return JSON.stringify([normalized.source_url, normalized.orientation, normalized.rotation, normalized.zoom, normalized.offset_x, normalized.offset_y, normalized.fit]);
}

export const samePhotoGeometry = (a: PhotoEdit, b: PhotoEdit) => photoGeometryIdentity(a) === photoGeometryIdentity(b);

export function photoGeometry(sourceWidth: number, sourceHeight: number, width: number, height: number, edit: PhotoEdit) {
  const sideways = edit.rotation % 180 !== 0;
  const rotatedWidth = sideways ? sourceHeight : sourceWidth;
  const rotatedHeight = sideways ? sourceWidth : sourceHeight;
  const fitScale = edit.fit === "contain"
    ? Math.min(width / rotatedWidth, height / rotatedHeight)
    : Math.max(width / rotatedWidth, height / rotatedHeight);
  const scale = fitScale * edit.zoom;
  const panX = Math.max(0, (rotatedWidth * scale - width) / 2);
  const panY = Math.max(0, (rotatedHeight * scale - height) / 2);
  return { scale, panX, panY, centerX: width / 2 + edit.offset_x * panX, centerY: height / 2 + edit.offset_y * panY };
}

export type PhotoPoint = { x: number; y: number };
export type PhotoViewport = { sourceWidth: number; sourceHeight: number; width: number; height: number };
type PhotoPointer = { id: number; point: PhotoPoint };
type GestureAnchor = { edit: PhotoEdit; center: PhotoPoint; distance: number };
export type PhotoGesture = { pointers: PhotoPointer[]; anchor: GestureAnchor | null };

export const newPhotoGesture = (): PhotoGesture => ({ pointers: [], anchor: null });
const validPoint = (point: PhotoPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const geometryFor = (edit: PhotoEdit, view: PhotoViewport) => photoGeometry(view.sourceWidth, view.sourceHeight, view.width, view.height, edit);

function editAtCenter(edit: PhotoEdit, view: PhotoViewport, center: PhotoPoint): PhotoEdit {
  const geometry = geometryFor(edit, view);
  return {
    ...edit,
    offset_x: geometry.panX ? clamp((center.x - view.width / 2) / geometry.panX, -1, 1) : 0,
    offset_y: geometry.panY ? clamp((center.y - view.height / 2) / geometry.panY, -1, 1) : 0,
  };
}

export function panPhotoBy(edit: PhotoEdit, view: PhotoViewport, delta: PhotoPoint): PhotoEdit {
  if (!validPoint(delta)) return edit;
  const geometry = geometryFor(edit, view);
  return editAtCenter(edit, view, { x: geometry.centerX + delta.x, y: geometry.centerY + delta.y });
}

/** Keep the image point under the zoom anchor stationary, including at zoom limits. */
export function zoomPhotoAt(edit: PhotoEdit, view: PhotoViewport, requestedZoom: number, point: PhotoPoint): PhotoEdit {
  if (!Number.isFinite(requestedZoom) || !validPoint(point)) return edit;
  const zoom = clamp(requestedZoom, 1, 4);
  const ratio = zoom / edit.zoom;
  const geometry = geometryFor(edit, view);
  return editAtCenter({ ...edit, zoom }, view, {
    x: point.x - (point.x - geometry.centerX) * ratio,
    y: point.y - (point.y - geometry.centerY) * ratio,
  });
}

function pointerFrame(pointers: PhotoPointer[]) {
  const [first, second] = pointers;
  if (!second) return { center: first.point, distance: 0 };
  return {
    center: { x: (first.point.x + second.point.x) / 2, y: (first.point.y + second.point.y) / 2 },
    distance: Math.hypot(first.point.x - second.point.x, first.point.y - second.point.y),
  };
}

function rebaseGesture(pointers: PhotoPointer[], edit: PhotoEdit): PhotoGesture {
  return { pointers, anchor: pointers.length ? { edit: { ...edit }, ...pointerFrame(pointers) } : null };
}

/** A pointer join/leave rebases from the visible crop so switching fingers never jumps. */
export function beginPhotoGesture(gesture: PhotoGesture, id: number, point: PhotoPoint, edit: PhotoEdit): PhotoGesture {
  if (!validPoint(point)) return gesture;
  const pointers = gesture.pointers.filter((pointer) => pointer.id !== id);
  return rebaseGesture([...pointers, { id, point }], edit);
}

export function movePhotoGesture(gesture: PhotoGesture, id: number, point: PhotoPoint, view: PhotoViewport): { gesture: PhotoGesture; edit: PhotoEdit | null } {
  if (!gesture.anchor || !validPoint(point) || !gesture.pointers.some((pointer) => pointer.id === id)) return { gesture, edit: null };
  const pointers = gesture.pointers.map((pointer) => pointer.id === id ? { id, point } : pointer);
  const current = pointerFrame(pointers);
  const anchor = gesture.anchor;
  // Coincident fingers may translate the crop, but must not divide by zero.
  const zoom = clamp(anchor.edit.zoom * (anchor.distance >= 1 ? current.distance / anchor.distance : 1), 1, 4);
  const ratio = zoom / anchor.edit.zoom;
  const geometry = geometryFor(anchor.edit, view);
  const edit = editAtCenter({ ...anchor.edit, zoom }, view, {
    x: current.center.x - (anchor.center.x - geometry.centerX) * ratio,
    y: current.center.y - (anchor.center.y - geometry.centerY) * ratio,
  });
  return { gesture: { ...gesture, pointers }, edit };
}

export function endPhotoGesture(gesture: PhotoGesture, id: number, edit: PhotoEdit): PhotoGesture {
  if (!gesture.pointers.some((pointer) => pointer.id === id)) return gesture;
  return rebaseGesture(gesture.pointers.filter((pointer) => pointer.id !== id), edit);
}

export function drawPhoto(canvas: HTMLCanvasElement, image: HTMLImageElement, width: number, height: number, edit: PhotoEdit) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const g = photoGeometry(image.naturalWidth, image.naturalHeight, width, height, edit);
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(g.centerX, g.centerY);
  ctx.rotate(edit.rotation * Math.PI / 180);
  ctx.scale(g.scale, g.scale);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  ctx.restore();
  return g;
}

// The firmware always requests physical landscape dimensions. Portrait art is
// edited upright, then turned into that physical pixel buffer before upload.
export function exportPhoto(image: HTMLImageElement, physicalWidth: number, physicalHeight: number, edit: PhotoEdit): HTMLCanvasElement {
  const portrait = edit.orientation === "portrait";
  const logical = document.createElement("canvas");
  drawPhoto(logical, image, portrait ? physicalHeight : physicalWidth, portrait ? physicalWidth : physicalHeight, edit);
  if (!portrait) return logical;
  const output = document.createElement("canvas");
  output.width = physicalWidth; output.height = physicalHeight;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.translate(physicalWidth, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(logical, 0, 0);
  return output;
}

/** Display an already-rendered physical raster in the editor's upright viewport. */
export function drawPhotoFilter(canvas: HTMLCanvasElement, image: HTMLImageElement, physicalWidth: number, physicalHeight: number, portrait: boolean): void {
  canvas.width = portrait ? physicalHeight : physicalWidth;
  canvas.height = portrait ? physicalWidth : physicalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.imageSmoothingEnabled = false;
  if (portrait) { context.translate(0, physicalWidth); context.rotate(-Math.PI / 2); }
  context.drawImage(image, 0, 0, physicalWidth, physicalHeight);
}
