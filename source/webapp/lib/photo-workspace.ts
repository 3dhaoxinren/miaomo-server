import { newPhotoEdit, readPhotoEdit, type PhotoEdit } from "./photo-editor";

export function mergePhotoDraft(
  overrides: Record<string, Record<string, unknown>>,
  images: string[],
  edits: PhotoEdit[],
): Record<string, Record<string, unknown>> {
  if (!images.length && !overrides.MY_ADAPTIVE) return overrides;
  return {
    ...overrides,
    MY_ADAPTIVE: {
      ...overrides.MY_ADAPTIVE,
      // Explicit empty values also clear the last removed photo.
      image_urls: [...images],
      image_url: images[0] || "",
      photo_edits: images.map((url, index) => readPhotoEdit(edits[index] || newPhotoEdit(url), url)),
    },
  };
}

export function photoPreviewIdentity(mac: string, width: number, height: number, colors: number, url: string, edit?: PhotoEdit): string {
  return JSON.stringify(["photo-color-profiles-v1", mac, width, height, colors, url, readPhotoEdit(edit, url)]);
}

export function singlePhotoOverride(base: Record<string, unknown>, images: string[], edits: PhotoEdit[], index: number): Record<string, unknown> {
  const url = images[index];
  if (!url) throw new Error("Photo unavailable");
  return { ...base, image_urls: [url], image_url: url, photo_edits: [readPhotoEdit(edits[index], url)] };
}
