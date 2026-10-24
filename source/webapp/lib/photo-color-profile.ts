import { exportPhoto, exportedPhotoEdit, photoGeometryIdentity, readPhotoEdit, samePhotoGeometry, type PhotoEdit } from "./photo-editor";
import { localPhotoSource } from "./local-photo-source";

export class PhotoColorError extends Error {
  constructor(public readonly code: "source_required" | "image_unavailable" | "stale") {
    super(code);
    this.name = "PhotoColorError";
  }
}

export type PhotoColorIO = {
  load: (url: string, signal: AbortSignal) => Promise<HTMLImageElement>;
  isPalette: (image: HTMLImageElement) => boolean;
  compose: (image: HTMLImageElement, edit: PhotoEdit) => Promise<File>;
  upload: (file: File) => Promise<string>;
};

export function loadPhotoImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); image.src = ""; reject(new PhotoColorError("stale")); };
    const fail = () => { cleanup(); reject(new PhotoColorError("image_unavailable")); };
    if (signal.aborted) { reject(new PhotoColorError("stale")); return; }
    image.crossOrigin = "anonymous";
    image.onload = () => { cleanup(); if (image.naturalWidth && image.naturalHeight) resolve(image); else reject(new PhotoColorError("image_unavailable")); };
    image.onerror = fail;
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(fail, 15000);
    image.src = localPhotoSource(url);
  });
}

/** Exact whole-raster classification after white alpha compositing, never sampling. */
const PALETTE = new Set([0, 0xffffff, 0xe8b000, 0xc80000, 0xffff00, 0xff0000]);
export function isPaletteRgba(data: ArrayLike<number>): boolean {
  if (!data.length || data.length % 4) return false;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const red = Math.floor((data[i] * alpha + 255 * (255 - alpha) + 127) / 255);
    const green = Math.floor((data[i + 1] * alpha + 255 * (255 - alpha) + 127) / 255);
    const blue = Math.floor((data[i + 2] * alpha + 255 * (255 - alpha) + 127) / 255);
    const rgb = red * 65536 + green * 256 + blue;
    if (!PALETTE.has(rgb)) return false;
  }
  return true;
}

export function browserPhotoColorIO(upload: PhotoColorIO["upload"], width: number, height: number): PhotoColorIO {
  return {
    load: loadPhotoImage,
    isPalette(image) {
      if (image.naturalWidth * image.naturalHeight > 16000000) throw new PhotoColorError("image_unavailable");
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new PhotoColorError("image_unavailable");
      try { context.drawImage(image, 0, 0); return isPaletteRgba(context.getImageData(0, 0, canvas.width, canvas.height).data); }
      finally { canvas.width = 0; canvas.height = 0; }
    },
    async compose(image, edit) {
      const canvas = exportPhoto(image, width, height, edit);
      try {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new PhotoColorError("image_unavailable")), "image/png"));
        return new File([blob], "photo-color-source.png", { type: "image/png" });
      } finally { canvas.width = 0; canvas.height = 0; }
    },
    upload,
  };
}

export type PhotoFilterIO = PhotoColorIO & {
  preview: (url: string, edit: PhotoEdit, signal: AbortSignal) => Promise<HTMLImageElement>;
};

/** Preview a filter without changing the album or using the processed pixels as an original. */
export async function previewPhotoFilter(
  url: string, initial: PhotoEdit, candidate: PhotoEdit, original: HTMLImageElement | null,
  io: PhotoFilterIO, rgbCache: Map<string, string>, signal: AbortSignal, isCurrent: () => boolean,
): Promise<HTMLImageElement> {
  const check = () => { if (signal.aborted || !isCurrent()) throw new PhotoColorError("stale"); };
  check();
  const edit = readPhotoEdit(candidate, url);
  try {
    const unchanged = samePhotoGeometry(initial, edit);
    const variant = unchanged ? edit.color_variants?.[edit.color_profile] : undefined;
    if (variant) { const image = await io.load(variant, signal); check(); return image; }
    if (!original) throw new PhotoColorError("image_unavailable");
    if (io.isPalette(original)) {
      if (unchanged && initial.color_profile === edit.color_profile) { const image = await io.load(url, signal); check(); return image; }
      if (initial.color_profile !== edit.color_profile) throw new PhotoColorError("source_required");
    }
    const geometry = photoGeometryIdentity(edit);
    let rgb = rgbCache.get(geometry);
    if (!rgb) {
      const file = await io.compose(original, edit);
      check(); rgb = await io.upload(file); check();
      rgbCache.set(geometry, rgb);
      if (rgbCache.size > 4) rgbCache.delete(rgbCache.keys().next().value!);
    }
    const image = await io.preview(rgb, exportedPhotoEdit(edit), signal);
    check();
    return image;
  } catch (error) {
    check();
    if (error instanceof PhotoColorError) throw error;
    throw new PhotoColorError("image_unavailable");
  }
}
