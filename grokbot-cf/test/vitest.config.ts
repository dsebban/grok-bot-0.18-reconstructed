import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: path.join(dir, "wrangler.jsonc") } })],
  resolve: {
    // One copy of pi's module state for the bot, the harness and the tests.
    dedupe: ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"]
  },
  test: {
    name: "grokbot",
    include: [path.join(dir, "**/*.test.ts")],
    // The crash test aborts every object in the runtime.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
