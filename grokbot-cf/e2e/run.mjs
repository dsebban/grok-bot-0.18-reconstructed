// End-to-end check of the built app: `vite build`, then `wrangler dev` (local
// workerd, real Durable Objects, SQLite and alarms), then a headless Chromium
// driving the real UI. Uses the offline demo model, so it needs no account.
//
//   node e2e/run.mjs [--no-build] [--headed] [--web]
//
// --web serves the UI the way Vercel does (the `.vercel/output` built for
// `vercel deploy --prebuilt`) from a second origin, so every scenario runs
// cross-origin against the Worker with ALLOWED_ORIGINS enforced.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WEB = args.has("--web");
const WEB_PORT = 8800;
const APP = WEB ? `http://127.0.0.1:${WEB_PORT}` : BASE;
const artifacts = path.join(root, "e2e", "artifacts");
const persist = path.join(artifacts, "state");
const CHROMIUM = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });

if (!args.has("--no-build")) {
  console.log("› vite build");
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
}
if (WEB) {
  console.log("› web build (Vercel output)");
  execSync("npx vite build --config vite.web.config.ts", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_GROKBOT_API_URL: BASE }
  });
  execSync("node scripts/vercel-output.mjs", { cwd: root, stdio: "inherit" });
}

/** Serves .vercel/output like Vercel: static files first, then the SPA fallback. */
function startWebServer() {
  const staticDir = path.join(root, ".vercel/output/static");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, APP).pathname);
    let file = path.join(staticDir, pathname);
    if (!file.startsWith(staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(staticDir, "index.html");
    }
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(WEB_PORT, "127.0.0.1", () => resolve(server)));
}

// The built config, minus the remote AI binding (needs a Cloudflare login),
// with the offline demo model as the default.
const built = JSON.parse(fs.readFileSync(path.join(root, "dist/grokbot/wrangler.json"), "utf8"));
delete built.ai;
built.vars = {
  ...built.vars,
  DEFAULT_MODEL: "demo/grokbot-demo",
  ...(WEB ? { ALLOWED_ORIGINS: APP } : {})
};
const configPath = path.join(root, "dist/grokbot/wrangler.e2e.json");
fs.writeFileSync(configPath, JSON.stringify(built, null, 2));

let server;
function startServer() {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--config", configPath, "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  const log = fs.createWriteStream(path.join(artifacts, "wrangler.log"), { flags: "a" });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}
function stopServer(signal = "SIGTERM") {
  if (!server) return;
  try {
    process.kill(-server.pid, signal);
  } catch {}
  server = undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, what, timeoutMs = 30_000) {
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
async function waitForServer() {
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, "wrangler dev", 90_000);
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error)}`);
    throw error;
  }
}

const bot = `e2e-${Date.now().toString(36)}`;
let secondThread;
const api = (p) => `${BASE}/api/bots/${bot}${p}`;
async function transcript(thread = "1") {
  return (await (await fetch(api(`/threads/${thread}/messages`))).json());
}

let browser;
let webServer;
try {
  if (WEB) webServer = await startWebServer();
  console.log("› wrangler dev");
  server = startServer();
  await waitForServer();

  browser = await chromium.launch({ executablePath: CHROMIUM, headless: !args.has("--headed") });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  const composer = page.getByTestId("composer");
  const send = async (text) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  const assistantCount = () => page.getByTestId("message-assistant").count();
  const lastAssistant = () => page.getByTestId("message-assistant").last();

  console.log("› scenarios");
  await step("loads the app and connects", async () => {
    await page.goto(`${APP}/#/${bot}/1`);
    if (WEB && new URL(page.url()).origin === BASE) throw new Error("web mode must load the UI from its own origin");
    await page.getByTestId("status").filter({ hasText: "Connected" }).waitFor();
    await page.getByText("What can I do for you?").waitFor();
    const models = await page.getByTestId("model-picker").locator("option").allTextContents();
    if (!models.includes("GrokBot Demo (offline)")) throw new Error(`models: ${models}`);
  });

  await step("chats with streamed markdown", async () => {
    await send("help");
    await lastAssistant().getByText("offline demo model").waitFor();
    await page.getByTestId("thread-item").filter({ hasText: "help" }).waitFor();
    const strong = await lastAssistant().locator("strong").first().textContent();
    if (strong !== "offline demo model") throw new Error(`markdown not rendered: ${strong}`);
  });

  await step("memory tool updates the memory panel", async () => {
    await send("remember that my favourite colour is teal");
    await page.locator('[data-testid="tool-card"][data-tool="memory_save"].tool-done').waitFor();
    await page.getByTestId("memory-item").filter({ hasText: "my favourite colour is teal" }).waitFor();
    await send("how are you?");
    await lastAssistant().getByText("I remember 1 thing about you").waitFor();
  });

  await step("file tool writes a file the files panel can open", async () => {
    await send("write /notes/todo.md: buy milk");
    await page.locator('[data-testid="tool-card"][data-tool="files_write"].tool-done').waitFor();
    await page.getByTestId("tab-files").click();
    await page.getByTestId("file-item").filter({ hasText: "/notes/todo.md" }).getByRole("button", { name: "/notes/todo.md" }).click();
    await page.getByTestId("file-viewer").getByText("buy milk").waitFor();
  });

  await step("tool card shows arguments and result", async () => {
    const card = page.locator('[data-testid="tool-card"][data-tool="files_write"]').first();
    await card.locator("summary").click();
    await card.getByTestId("tool-result").getByText("Wrote /notes/todo.md").waitFor();
  });

  await step("reload mid-stream resumes from a snapshot", async () => {
    const before = await assistantCount();
    await send("slow");
    await page.getByTestId("message-live").waitFor();
    await page.reload();
    await page.getByTestId("status").filter({ hasText: "Connected" }).waitFor();
    await waitFor(async () => (await assistantCount()) === before + 1, "full answer after reload");
    await lastAssistant().getByText("resumes from the last checkpoint", { exact: false }).first().waitFor();
  });

  await step("a message sent while busy is queued and answered after", async () => {
    const before = await assistantCount();
    await send("slow");
    await page.getByTestId("message-live").waitFor();
    await send("what time is it?");
    await page.getByTestId("queued").waitFor();
    await waitFor(async () => (await assistantCount()) >= before + 3, "both answers");
    await page.locator('[data-testid="tool-card"][data-tool="current_time"].tool-done').waitFor();
  });

  await step("stop aborts the running answer", async () => {
    await send("slow");
    await page.getByTestId("message-live").waitFor();
    await page.getByTestId("stop").click();
    await waitFor(async () => !(await page.getByTestId("message-live").count()) && !(await page.getByTestId("stop").count()), "run to end");
    const t = await transcript("1");
    const last = t.messages.at(-1);
    if (last.role !== "assistant" || !last.interrupted) throw new Error(`last message: ${JSON.stringify(last).slice(0, 200)}`);
  });

  await step("scheduled reminder fires through the Durable Object alarm", async () => {
    await send("remind me in 2 seconds to stretch");
    await page.locator('[data-testid="tool-card"][data-tool="schedule_prompt"].tool-done').waitFor();
    await page.getByTestId("tab-automations").click();
    await page.getByTestId("automation-item").filter({ hasText: "Remind the user to stretch" }).waitFor();
    await page.getByText("⏰ Scheduled task: Remind the user to stretch").waitFor({ timeout: 20_000 });
    await page.getByTestId("automation-item").filter({ hasText: "finished" }).waitFor();
  });

  await page.screenshot({ path: path.join(artifacts, "thread-tools.png") });

  await step("new thread, then fork keeps history", async () => {
    await page.getByTestId("new-thread").click();
    await page.waitForURL((url) => /#\/[^/]+\/(\d+)$/.test(url.hash) && !url.hash.endsWith("/1"));
    secondThread = page.url().split("/").at(-1);
    await page.getByText("What can I do for you?").waitFor();
    await send("Plan a picnic");
    await lastAssistant().getByText("You said").waitFor();
    await page.getByTestId("thread-item").filter({ hasText: "Plan a picnic" }).waitFor();
    await page.getByTestId("fork").click();
    await page.waitForURL((url) => !url.hash.endsWith(`/${secondThread}`));
    await page.getByTestId("message-user").filter({ hasText: "Plan a picnic" }).waitFor();
    await page.getByTestId("thread-title").filter({ hasText: "Fork of Plan a picnic" }).waitFor();
    if ((await page.getByTestId("thread-item").count()) !== 3) throw new Error("expected 3 threads");
  });

  await step("REST API answers with wait", async () => {
    const response = await fetch(api(`/threads/${secondThread}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "remember that I live in Lisbon", wait: true })
    });
    const body = await response.json();
    if (body.status !== "done" || !body.text.includes("I live in Lisbon")) throw new Error(JSON.stringify(body));
    await page.getByTestId("tab-memory").click();
    await page.getByTestId("memory-item").filter({ hasText: "I live in Lisbon" }).waitFor();
  });

  await step("thread list busy flags clear after a REST-driven run", async () => {
    await waitFor(async () => (await page.locator(".thread .dot").count()) === 0, "no busy dots", 10_000);
  });
  await page.screenshot({ path: path.join(artifacts, "grokbot.png"), fullPage: false });

  await step("a server crash mid-answer resumes after restart", async () => {
    const receipt = await (
      await fetch(api("/threads/1/messages"), { method: "POST", body: JSON.stringify({ text: "slow" }) })
    ).json();
    if (!receipt.operationId) throw new Error(JSON.stringify(receipt));
    await waitFor(async () => (await transcript("1")).running, "run to start");
    await sleep(400);
    stopServer("SIGKILL");
    await sleep(500);
    server = startServer();
    await waitForServer();
    // The PiHarness wake alarm (or the next request) restarts the object; pi
    // continues the interrupted generation from its checkpoint.
    const done = await waitFor(async () => {
      const t = await transcript("1");
      return !t.running && t.messages.at(-1)?.role === "assistant" && t.messages.at(-1).text.includes("resumes from the last checkpoint") && t;
    }, "resumed answer", 60_000);
    const tail = done.messages.slice(-3).map((m) => `${m.role}${m.interrupted ? "(interrupted)" : ""}`);
    console.log(`    tail after restart: ${tail.join(", ")}`);
    await page.reload();
    await page.getByTestId("status").filter({ hasText: "Connected" }).waitFor();
    await page.getByTestId("memory-item").filter({ hasText: "teal" }).waitFor();
  });

  if (WEB) {
    await step("Worker refuses origins outside ALLOWED_ORIGINS", async () => {
      const ok = await fetch(`${BASE}/api/bots/${bot}/threads`, { headers: { origin: APP } });
      if (ok.status !== 200 || ok.headers.get("access-control-allow-origin") !== APP) throw new Error(`allowed origin: ${ok.status}`);
      const preflight = await fetch(`${BASE}/api/config`, { method: "OPTIONS", headers: { origin: APP } });
      if (preflight.status !== 204) throw new Error(`preflight: ${preflight.status}`);
      const evil = await fetch(`${BASE}/api/bots/${bot}/threads`, { headers: { origin: "https://evil.example" } });
      if (evil.status !== 403) throw new Error(`foreign origin: ${evil.status}`);
      const upgrade = (origin) =>
        new Promise((resolve, reject) => {
          const request = http.request(`${BASE}/agents/grok-bot/${bot}`, {
            headers: {
              origin,
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="
            }
          });
          request.on("upgrade", (response, socket) => {
            socket.destroy();
            resolve(response.statusCode);
          });
          request.on("response", (response) => {
            response.resume();
            resolve(response.statusCode);
          });
          request.on("error", reject);
          request.end();
        });
      const foreign = await upgrade("https://evil.example");
      if (foreign !== 403) throw new Error(`foreign socket: ${foreign}`);
      const own = await upgrade(APP);
      if (own !== 101) throw new Error(`allowed socket: ${own}`);
    });
  }

  const unexpected = consoleErrors.filter((text) => !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(text));
  await step("no unexpected browser console errors", async () => {
    if (unexpected.length) throw new Error(unexpected.join("\n"));
  });
} catch (error) {
  process.exitCode = 1;
  if (!results.length || results.at(-1).ok) console.error(error);
} finally {
  await browser?.close();
  webServer?.close();
  stopServer();
  fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${WEB ? "[web/Vercel mode] " : ""}${passed}/${results.length} e2e steps passed${process.exitCode ? " (FAILED)" : ""}`);
}
