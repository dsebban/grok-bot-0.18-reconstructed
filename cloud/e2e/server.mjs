// Starts the built Worker under `wrangler dev` (local workerd: real Durable
// Objects, SQLite and alarms) with the offline demo model and no remote AI
// binding, so it needs no Cloudflare account.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export function writeLocalConfig(vars = {}) {
  const built = JSON.parse(fs.readFileSync(path.join(root, "dist/grokbot/wrangler.json"), "utf8"));
  delete built.ai;
  built.vars = { ...built.vars, DEFAULT_MODEL: "demo/grokbot-demo", ...vars };
  const configPath = path.join(root, "dist/grokbot/wrangler.local.json");
  fs.writeFileSync(configPath, JSON.stringify(built, null, 2));
  return configPath;
}

export function startServer({ port, persistTo, logFile, configPath }) {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--config", configPath, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persistTo, "--show-interactive-dev-session=false"],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  const log = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return {
    stop(signal = "SIGTERM") {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, what, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(100);
  }
}
