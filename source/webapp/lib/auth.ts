/** Legacy helper name retained for existing device components; local edition has no sessions. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> { return { ...extra }; }
