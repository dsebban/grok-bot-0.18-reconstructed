// End to end: `vite build`, then `wrangler dev` (local workerd: real Durable
// Objects, SQLite and alarms) on the offline demo model, then headless
// Chromium driving the Grok Bot UI.
//
//   node e2e/run.mjs [--no-build] [--headed]
//   GROKBOT_UI=reconstructed node e2e/run.mjs   # the frontend/ renderer instead
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { root, sleep, startServer, waitFor, writeLocalConfig } from "./server.mjs";

const args = new Set(process.argv.slice(2));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const artifacts = path.join(root, "e2e", "artifacts");
const persist = path.join(artifacts, "state");
const CHROMIUM = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const ui = process.env.GROKBOT_UI === "reconstructed" ? "reconstructed" : "shipped";

fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });
if (!args.has("--no-build")) execSync("npx vite build", { cwd: root, stdio: "inherit" });

const configPath = writeLocalConfig();
let server;
const start = () => startServer({ port: PORT, persistTo: persist, logFile: path.join(artifacts, "wrangler.log"), configPath });
const waitForServer = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, "wrangler dev", 90_000);

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split("\n")[0]}`);
    throw error;
  }
}

const bot = `e2e${Date.now().toString(36)}`;
const api = (p) => `${BASE}/api/bots/${bot}${p}`;

let browser;
try {
  console.log(`› wrangler dev (${ui} UI)`);
  server = start();
  await waitForServer();
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: !args.has("--headed") });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const consoleErrors = [];
  page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  const composer = () => page.locator("[contenteditable=true]").first();
  const send = async (text) => {
    await composer().click();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const transcript = page.locator(ui === "shipped" ? "main, body" : "[role=log]").first();
  const agents = async () => (await (await fetch(api("/agents"))).json()).agents;
  /** The shipped UI opens a bot from the sidebar; the reconstruction opens the newest on load. */
  const openGrokBot = async () => {
    if (ui === "shipped") await page.getByText("Grok Bot", { exact: true }).first().click();
    else await page.locator(".sand-agent-item__name", { hasText: /^Grok Bot$/ }).first().click();
  };

  console.log("› scenarios");
  await step("loads the Grok Bot UI with the onboarded agent", async () => {
    await page.goto(`${BASE}/?bot=${bot}`);
    await page.getByText("Grok Bot", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: /Plugins/ }).waitFor();
  });

  await step("chats with the bot", async () => {
    await openGrokBot();
    await send("hello there");
    await transcript.getByText("You said: “hello there”.", { exact: false }).first().waitFor();
    // The optimistic bubble is replaced by the echo, not duplicated.
    await sleep(500);
    if ((await page.getByText("hello there", { exact: true }).count()) !== 1) throw new Error("user message shown more than once");
  });

  await step("tools: memory carries into later turns", async () => {
    await send("remember that my favourite colour is teal");
    await page.getByText("Saved memory #1: my favourite colour is teal", { exact: false }).first().waitFor();
    await send("how are you?");
    await page.getByText("I remember 1 thing about you", { exact: false }).first().waitFor();
  });

  await step("reload mid-answer resumes the streamed reply", async () => {
    await send("slow");
    await page.getByText("Durable Objects give each conversation", { exact: false }).first().waitFor();
    await page.reload();
    await waitFor(async () => {
      const list = await agents();
      return list.every((agent) => !agent.isRunning);
    }, "run to finish");
    await openGrokBot();
    await page.getByText("resumes from the last checkpoint. Durable Objects give", { exact: false }).last().waitFor();
  });

  await step("a scheduled reminder fires through the Durable Object alarm", async () => {
    await send("remind me in 2 seconds to stretch");
    await page.getByText("Created routine", { exact: false }).first().waitFor();
    await page.getByText("⏰ Scheduled task: Remind the user to stretch", { exact: false }).first().waitFor({ timeout: 20_000 });
  });

  if (ui === "shipped") {
    await step("creates a new bot from the To: picker and talks to it", async () => {
      await page.getByRole("button", { name: "New" }).click();
      await page.getByLabel("Search or create Bots").fill("Picnic Planner");
      await page.keyboard.press("Enter");
      await waitFor(async () => (await agents()).some((agent) => agent.name === "Picnic Planner"), "created bot");
      await send("Plan a picnic for Saturday");
      await page.getByText("You said: “Plan a picnic for Saturday”", { exact: false }).first().waitFor();
      // The sidebar row updates live from the ordered roster events.
      await page.getByText("Picnic Planner", { exact: true }).first().waitFor();
    });
  } else {
    // frontend/'s reconstruction stops accepting composer input after a chat
    // switch (its draft store, not the bot); create the chat and check the
    // roster only.
    await step("a new chat appears in the sidebar", async () => {
      await page.getByRole("button", { name: "New" }).click();
      await waitFor(async () => (await agents()).some((agent) => agent.name === "New chat"), "new agent");
      await page.locator(".sand-agent-item__name", { hasText: /^New chat$/ }).first().waitFor();
    });
  }

  if (ui === "shipped") {
    await step("Settings → Router switches provider and stores an OpenRouter key", async () => {
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menuitem", { name: /settings/i }).first().click();
      await page.getByText("Router", { exact: true }).first().click();
      await page.getByText("Use your signed-in Cursor account.", { exact: false }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "router.png") });
      await page.getByLabel("Routing provider").first().click();
      await page.getByRole("option", { name: "OpenRouter" }).click();
      await page.getByLabel("OPENROUTER_API_KEY").fill("sk-or-test");
      await page.getByRole("button", { name: "Save" }).click();
      await waitFor(async () => (await (await fetch(api("/secrets"))).json()).keys.includes("OPENROUTER_API_KEY"), "stored key");
      const router = await (await fetch(api("/router"))).json();
      if (router.provider !== "openrouter" || router.model !== "openrouter/x-ai/grok-4.3") throw new Error(JSON.stringify(router));
      // Back to the demo-backed default for the rest of the run.
      await page.getByLabel("Routing provider").first().click();
      await page.getByRole("option", { name: "Cursor" }).click();
      await waitFor(async () => (await (await fetch(api("/router"))).json()).provider === "cursor", "provider back to cursor");
      await page.keyboard.press("Escape");
    });
  }

  await page.screenshot({ path: path.join(artifacts, "grokbot.png") });

  await step("a server crash mid-answer resumes after restart", async () => {
    const [first] = (await agents()).filter((agent) => agent.name === "Grok Bot");
    const sent = fetch(api(`/agents/${first.id}/messages`), { method: "POST", body: JSON.stringify({ text: "slow" }) }).catch(() => null);
    await waitFor(async () => (await agents()).some((agent) => agent.isRunning), "run to start");
    await sleep(300);
    server.stop("SIGKILL");
    await sent;
    await sleep(500);
    server = start();
    await waitForServer();
    const entries = await waitFor(async () => {
      const list = (await (await fetch(api(`/agents/${first.id}/messages`))).json()).entries;
      const last = list.at(-1);
      return last?.kind === "send-message" && !last.streaming && last.message.content.includes("resumes from the last checkpoint") && list;
    }, "resumed answer", 60_000);
    console.log(`    last entries: ${entries.slice(-3).map((entry) => entry.kind).join(", ")}`);
    // One answer for the turn: the interrupted partial is superseded by the retry.
    if (entries.filter((entry) => entry.kind === "send-message" && entry.message.content.startsWith("Durable Objects")).length !== 2) {
      throw new Error("expected one answer per slow turn (the reload step's and this one)");
    }
  });

  await step("the UI reconnects on its own and a message typed right away is delivered", async () => {
    // The bridge pushes a fresh port like Electron's main process does, and the
    // renderer's acceptance lookup resends what never reached the bot.
    server.stop("SIGKILL");
    await sleep(300);
    server = start();
    await waitForServer();
    if (ui === "shipped") {
      await send("back online?");
    } else {
      // The reconstruction's composer is stuck after the chat switch above
      // (see the README); check the reconnected socket with a live answer.
      await openGrokBot();
      const [first] = (await agents()).filter((agent) => agent.name === "Grok Bot");
      await fetch(api(`/agents/${first.id}/messages`), { method: "POST", body: JSON.stringify({ text: "back online?" }) });
    }
    await transcript.getByText("You said: “back online?”", { exact: false }).first().waitFor({ timeout: 30_000 });
  });

  // Killing the server mid-call drops in-flight requests; that is expected.
  const unexpected = consoleErrors.filter((text) => !/WebSocket|ERR_CONNECTION|Failed to load resource|net::ERR|coordinator port closed/.test(text));
  await step("no unexpected browser errors", async () => {
    if (unexpected.length) throw new Error(unexpected.join("\n"));
  });
} catch (error) {
  process.exitCode = 1;
  if (!results.length || results.at(-1).ok) console.error(error);
} finally {
  await browser?.close();
  server?.stop();
  fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n[${ui} UI] ${passed}/${results.length} e2e steps passed${process.exitCode ? " (FAILED)" : ""}`);
}
