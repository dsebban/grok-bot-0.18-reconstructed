import fs from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error -- plain ESM build script without type declarations
import { hydrateRenderer, rendererManifest } from "./scripts/hydrate-renderer.mjs";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");

/**
 * Which UI to serve, as the desktop build decides it:
 *
 * - `shipped` (the default when it can be hydrated): the checksum-pinned
 *   0.18.0 renderer with main's Router patch, exactly what the macOS package
 *   shows (scripts/package-macos.mjs);
 * - `reconstructed`: main's readable renderer reconstruction in frontend/.
 *
 * GROKBOT_UI=shipped|reconstructed forces one; `auto` falls back to the
 * reconstruction when no verified DMG is available.
 */
const requested = process.env.GROKBOT_UI ?? "auto";
type Shipped = { dir: string; entry: string; styles: string[] };
let shipped: Shipped | null = null;
if (requested !== "reconstructed") {
  try {
    const dir: string = await hydrateRenderer();
    shipped = { dir, ...(await rendererManifest(dir)) };
  } catch (error) {
    if (requested === "shipped") throw error;
    console.warn(`[grokbot] Using frontend/ (shipped renderer unavailable: ${(error as Error).message})`);
  }
}

/** Serves (dev) and emits (build) the shipped renderer next to the web bridge. */
function shippedRenderer(renderer: Shipped | null): Plugin {
  const contentType: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".json": "application/json"
  };
  return {
    name: "grokbot-shipped-renderer",
    transformIndexHtml() {
      if (!renderer) return [];
      return renderer.styles.map((href) => ({
        tag: "link",
        attrs: { rel: "stylesheet", crossorigin: "", href: `/${href}` },
        injectTo: "head" as const
      }));
    },
    configureServer(server) {
      if (!renderer) return;
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
        if (!pathname.startsWith("/assets/")) return next();
        const file = path.join(renderer.dir, pathname);
        if (!file.startsWith(renderer.dir) || !fs.existsSync(file)) return next();
        response.setHeader("content-type", contentType[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      if (!renderer || this.environment.name !== "client") return;
      const assets = path.join(renderer.dir, "assets");
      for (const name of fs.readdirSync(assets)) {
        this.emitFile({ type: "asset", fileName: `assets/${name}`, source: fs.readFileSync(path.join(assets, name)) });
      }
    }
  };
}

/**
 * The reconstruction (../frontend/src) and its shared contracts (../source)
 * build here unchanged. Their bare imports resolve from this package, so the
 * Worker build does not need the desktop app's dependency tree.
 */
const SHARED_DEPS = [
  "react",
  "react-dom",
  "@bufbuild/protobuf",
  "@tiptap/core",
  "@tiptap/suggestion",
  "@tiptap/starter-kit",
  "@tiptap/react",
  "@tiptap/pm",
  "@tiptap/extension-placeholder",
  "@tiptap/extension-mention",
  "@tiptap/extension-link"
];

export default defineConfig({
  plugins: [react(), cloudflare(), shippedRenderer(shipped)],
  define: {
    __GROKBOT_RENDERER_ENTRY__: JSON.stringify(shipped ? `/${shipped.entry}` : "")
  },
  resolve: { dedupe: SHARED_DEPS },
  server: { fs: { allow: [repo] } }
});
