const UPLOAD_PATH = /^\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve InkSight's UUID upload resources on this instance; keep stored URLs intact. */
export function localPhotoSource(source: string): string {
  try {
    const url = new URL(source, "http://inksight.local");
    if ((url.protocol === "http:" || url.protocol === "https:") && UPLOAD_PATH.test(url.pathname)) {
      return `${url.pathname}${url.search}`;
    }
  } catch { /* Ordinary external, blob and malformed image URLs are not rewritten. */ }
  return source;
}
