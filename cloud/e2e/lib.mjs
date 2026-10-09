// The e2e harness: one `wrangler dev` server (local workerd: Durable Objects,
// SQLite, alarms) on the offline demo model, headless Chromium tabs driving
// the Grok Bot UI, the bot's REST API, and a step runner.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { root, sleep, startServer, waitFor, writeLocalConfig } from "./server.mjs";

export { sleep, waitFor };

const CHROMIUM = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

/** Browser noise the app cannot avoid: a killed server, and the shipped renderer's Electron-only Sentry transport. */
const EXPECTED_ERRORS = /WebSocket|ERR_CONNECTION|Failed to load resource|net::ERR|coordinator port closed|sentry/i;
/** A lazily loaded chunk requested while the server was down (the renderer retries it). */
const DOWNTIME_ERRORS = /Failed to fetch dynamically imported module/;
/** How long after a restart a failed chunk fetch still counts as the outage's. */
const DOWNTIME_TAIL_MS = 5_000;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Harness {
  constructor({ ui, port, artifacts, headed }) {
    this.ui = ui;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.artifacts = artifacts;
    this.headed = headed;
    this.persist = path.join(artifacts, "state");
    this.logFile = path.join(artifacts, "wrangler.log");
    this.configPath = writeLocalConfig();
    this.server = null;
    this.browser = null;
    this.tabs = new Set();
    /** [from, to] of each restart's outage, for errors only a server outage explains. */
    this.downtime = [];
  }

  #duringDowntime(at) {
    return this.downtime.some(([from, to]) => at >= from && at <= (to ?? Infinity) + DOWNTIME_TAIL_MS);
  }

  async start() {
    this.server = startServer({ port: this.port, persistTo: this.persist, logFile: this.logFile, configPath: this.configPath });
    await waitFor(async () => (await fetch(`${this.base}/api/health`)).ok, "wrangler dev", 120_000);
    this.browser ??= await chromium.launch({ executablePath: CHROMIUM, headless: !this.headed });
  }

  /** Stop the server with `signal` and start it again on the same state. */
  async restart(signal = "SIGTERM") {
    fs.appendFileSync(this.logFile, `\n--- restart (${signal}) ---\n`);
    const outage = [Date.now(), null];
    this.downtime.push(outage);
    await Promise.race([this.server.stop(signal), sleep(15_000)]);
    this.server.stop("SIGKILL");
    await waitFor(async () => {
      try {
        await fetch(`${this.base}/api/health`);
        return false;
      } catch {
        return true;
      }
    }, "old server to stop", 15_000);
    await this.start();
    outage[1] = Date.now();
  }

  async stop() {
    await this.browser?.close().catch(() => {});
    await this.server?.stop();
  }

  /** A fresh bot space for one scenario. */
  bot(label) {
    return `e2e${label.replace(/[^a-z0-9]/gi, "").slice(0, 12)}${Date.now().toString(36)}`;
  }

  api(bot) {
    const url = (p) => `${this.base}/api/bots/${bot}${p}`;
    const json = async (p, body) => {
      const response = await fetch(url(p), body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return response.json();
    };
    return {
      url,
      json,
      agents: async () => (await json("/agents")).agents,
      agent: async (name) => (await json("/agents")).agents.find((agent) => agent.name === name),
      entries: async (id) => (await json(`/agents/${id}/messages`)).entries,
      /** Prompt through REST; resolves when the answer is done. */
      prompt: (id, text) => json(`/agents/${id}/messages`, { text }),
      sidebar: () => json("/sidebar"),
      router: () => json("/router"),
      secrets: () => json("/secrets")
    };
  }

  /** Open the UI for `bot` in a new browser context (its own storage), like a new browser. */
  async open(bot, { scheme = "dark", width = 1440, height = 900, ready = "sidebar" } = {}) {
    const context = await this.browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const page = await context.newPage();
    const errors = [];
    const frames = [];
    const viewing = [];
    page.on("console", (message) => message.type() === "error" && errors.push({ text: message.text(), at: Date.now() }));
    page.on("pageerror", (error) => errors.push({ text: String(error), at: Date.now() }));
    const sent = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => frames.push(frame.payload));
      socket.on("framesent", (frame) => sent.push(frame.payload));
    });
    page.on("requestfinished", async (request) => {
      if (!request.url().endsWith("/viewing")) return;
      const status = (await request.response())?.status();
      viewing.push({ ...JSON.parse(request.postData()), status });
    });
    await page.goto(`${this.base}/?bot=${bot}`);
    // At phone width the sidebar shows avatars only; the composer is always there.
    const loaded = ready === "sidebar" ? page.getByText("Grok Bot", { exact: true }).first() : page.locator("[contenteditable=true]").first();
    await loaded.waitFor({ timeout: 60_000 });
    const ui = this.ui;
    const harness = this;
    const tab = {
      page,
      context,
      viewing,
      row: (name) =>
        ui === "shipped"
          ? page.getByText(name, { exact: true }).first()
          : page.locator(".sand-agent-item__name", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }).first(),
      async openBot(name) {
        await tab.row(name).click();
        await sleep(300);
      },
      async send(text) {
        await page.locator("[contenteditable=true]:visible").last().click();
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");
      },
      /** Shipped UI: the To: picker. */
      async newBot(name, api) {
        await page.getByRole("button", { name: "New" }).click();
        await page.getByLabel("Search or create Bots").fill(name);
        await page.keyboard.press("Enter");
        await waitFor(async () => (await api.agents()).some((agent) => agent.name === name), `bot ${name}`);
        await sleep(400);
      },
      async menu(name, item) {
        await tab.row(name).click({ button: "right" });
        await page.getByRole("menuitem", { name: item, exact: true }).click();
        await sleep(400);
      },
      async menuItems(name) {
        await tab.row(name).click({ button: "right" });
        const items = await page.getByRole("menuitem").allInnerTexts();
        await page.keyboard.press("Escape");
        return items;
      },
      see: (text, timeout = 20_000) => page.getByText(text, { exact: false }).first().waitFor({ timeout }),
      count: (text) => page.getByText(text, { exact: false }).count(),
      /** How many times this tab's coordinator socket has become ready. */
      readyCount: () => frames.filter((frame) => frame.includes('"phase":"ready"')).length,
      /** Coordinator events this tab received in `family`. */
      events: (family) =>
        frames
          .map((frame) => {
            try {
              return JSON.parse(frame);
            } catch {
              return null;
            }
          })
          .filter((frame) => frame?.kind === "event" && frame.family === family)
          .map((frame) => frame.payload),
      /** Coordinator requests this tab sent, as `{ method, args }`. */
      requests: () =>
        sent
          .map((frame) => {
            try {
              return JSON.parse(frame);
            } catch {
              return null;
            }
          })
          .filter((frame) => frame?.kind === "request"),
      failures: () =>
        frames
          .map((frame) => {
            try {
              return JSON.parse(frame);
            } catch {
              return null;
            }
          })
          .filter((frame) => frame?.kind === "reply" && frame.outcome.status !== "ok")
          .map((frame) => frame.outcome.failure),
      unexpectedErrors: () =>
        errors
          .filter(({ text, at }) => !EXPECTED_ERRORS.test(text) && !(DOWNTIME_ERRORS.test(text) && harness.#duringDowntime(at)))
          .map(({ text }) => text),
      close: async () => {
        tabs.delete(tab);
        await context.close().catch(() => {});
      }
    };
    const tabs = this.tabs;
    tabs.add(tab);
    return tab;
  }

  /** The step every scenario ends with: no renderer errors, no failed coordinator calls. */
  clean(tab) {
    const failures = tab.failures();
    const errors = tab.unexpectedErrors();
    if (failures.length || errors.length) throw new Error(JSON.stringify({ failures, errors }).slice(0, 1500));
  }
}

export class Runner {
  constructor(harness) {
    this.harness = harness;
    this.results = [];
    this.scenario = "";
  }

  async step(name, fn) {
    const started = Date.now();
    try {
      const note = await fn();
      this.results.push({ scenario: this.scenario, name, ok: true, ms: Date.now() - started, ...(note ? { note: String(note) } : {}) });
      console.log(`  ✓ ${name} (${Date.now() - started} ms)${note ? ` — ${String(note).slice(0, 160)}` : ""}`);
    } catch (error) {
      this.results.push({ scenario: this.scenario, name, ok: false, error: String(error?.stack ?? error) });
      console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split("\n")[0]}`);
      let index = 0;
      for (const tab of this.harness.tabs) {
        const file = path.join(this.harness.artifacts, `${this.scenario}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}-${index++}.png`);
        await tab.page.screenshot({ path: file }).catch(() => {});
      }
      throw error;
    }
  }

  get failed() {
    return this.results.filter((result) => !result.ok);
  }
}
