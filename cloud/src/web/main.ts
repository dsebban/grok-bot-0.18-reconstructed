/// <reference path="../../../frontend/src/env.d.ts" />
import { createWebDesktopBridge } from "./desktop-bridge";
import { WebSession } from "./session";
import "./web.css";

/** Set at build time: the shipped renderer's module entry, or "" for frontend/. */
declare const __GROKBOT_RENDERER_ENTRY__: string;

/**
 * Boots the Grok Bot renderer in a browser: install the two objects the
 * Electron preload provides (`window.desktop`, `window.coordinatorPort`),
 * then hand over to the renderer's own entry point, unchanged: the shipped
 * 0.18.0 renderer with main's Router patch when the build hydrated it (as
 * the macOS package does), otherwise main's reconstruction in frontend/.
 */
async function boot(): Promise<void> {
  const session = await WebSession.start({ bareRosterEvents: !__GROKBOT_RENDERER_ENTRY__ });
  window.desktop = createWebDesktopBridge(session, { reconstruction: !__GROKBOT_RENDERER_ENTRY__ });
  window.coordinatorPort = session.coordinatorPort;
  if (__GROKBOT_RENDERER_ENTRY__) await import(/* @vite-ignore */ __GROKBOT_RENDERER_ENTRY__);
  else await import("../../../frontend/src/main.tsx");
}

boot().catch((error: unknown) => {
  console.error("GrokBot failed to start", error);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `GrokBot could not start: ${error instanceof Error ? error.message : String(error)}`;
    root.setAttribute("style", "padding:24px;font:14px system-ui;color:#c44");
  }
});
