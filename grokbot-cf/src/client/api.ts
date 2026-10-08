/**
 * Where the GrokBot Worker lives. Empty when the UI is served by the Worker
 * itself (Cloudflare assets); the Worker's origin when the UI is hosted
 * elsewhere, such as Vercel (set `VITE_GROKBOT_API_URL` at build time).
 */
const API_BASE = ((import.meta.env.VITE_GROKBOT_API_URL as string | undefined) ?? "").replace(/\/+$/, "");

/** An absolute URL for a Worker path such as `/api/config`. */
export function apiUrl(path: string): string {
  return new URL(path, API_BASE ? `${API_BASE}/` : window.location.href).toString();
}

/** The WebSocket URL for a Worker path. */
export function socketUrl(path: string): string {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
