import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The UI alone, for hosting outside Cloudflare (Vercel). It talks to the
 * GrokBot Worker at `VITE_GROKBOT_API_URL`.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-web", emptyOutDir: true }
});
