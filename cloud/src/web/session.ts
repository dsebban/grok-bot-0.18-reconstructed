import type {
  AgentModelSelection,
  CoordinatorPortBridge,
  TransferredCoordinatorPort
} from "../../../frontend/src/recovered/contracts/desktop-bridge";

/**
 * The browser session behind the web bridge: which bot (one Durable Object)
 * this tab talks to, the optional access token, and the coordinator port,
 * which is a WebSocket to the bot speaking the same frame protocol the
 * desktop coordinator used over its MessagePort.
 */

const TOKEN_KEY = "grokbot:token";
const BOT_KEY = "grokbot:bot";
const BOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type WebConfig = {
  readonly auth: boolean;
  readonly models: readonly { provider: string; modelId: string; name: string; group: string }[];
  readonly defaultModel: { provider: string; modelId: string };
};

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable.
  }
  return null;
}

function botFromLocation(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("bot");
  if (fromQuery && BOT_NAME.test(fromQuery)) {
    storage(BOT_KEY, fromQuery);
    return fromQuery;
  }
  const stored = storage(BOT_KEY);
  return stored && BOT_NAME.test(stored) ? stored : "default";
}

/** A WebSocket presented as the renderer's transferred MessagePort. */
class SocketPort implements TransferredCoordinatorPort {
  readonly #socket: WebSocket;
  readonly #queue: string[] = [];
  readonly #messageListeners = new Set<(event: { data: unknown }) => void>();
  readonly #closeListeners = new Set<(event: Record<string, never>) => void>();
  #closed = false;

  constructor(url: string, adaptFrame: (frame: unknown) => unknown = (frame) => frame) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("open", () => {
      for (const frame of this.#queue.splice(0)) this.#socket.send(frame);
    });
    this.#socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      data = adaptFrame(data);
      for (const listener of [...this.#messageListeners]) listener({ data });
    });
    this.#socket.addEventListener("close", () => this.#fireClose());
    this.#socket.addEventListener("error", () => this.#fireClose());
  }

  #fireClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of [...this.#closeListeners]) listener({});
  }

  postMessage(message: unknown): void {
    if (this.#closed) return;
    const frame = JSON.stringify(message);
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(frame);
    else this.#queue.push(frame);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }

  start(): void {}

  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: Record<string, never>) => void): void;
  addEventListener(type: "message" | "close", listener: (event: never) => void): void {
    if (type === "message") this.#messageListeners.add(listener as (event: { data: unknown }) => void);
    else this.#closeListeners.add(listener as (event: Record<string, never>) => void);
  }
}

function unwrapRosterEvents(frame: unknown): unknown {
  const value = frame as { kind?: string; family?: string; payload?: Record<string, unknown> } | null;
  if (value?.kind !== "event" || typeof value.payload !== "object" || value.payload === null) return frame;
  if (value.family === "agents" && Array.isArray(value.payload.agents)) return { ...value, payload: value.payload.agents };
  if (value.family === "agent-upserted" && value.payload.agent) return { ...value, payload: value.payload.agent };
  return frame;
}

export class WebSession {
  readonly bot = botFromLocation();
  /** This tab, so the bot knows which chat it has selected. */
  readonly viewer = crypto.randomUUID();
  #selected: string | null = null;
  /** Whether the renderer has written a selection yet (it outranks a restored one). */
  #selectionWritten = false;
  /** Orders this tab's reports, so a delayed one cannot overwrite a newer one. */
  #viewSeq = 0;
  readonly config: WebConfig;
  #token: string | null;
  #current: SocketPort | null = null;
  #consumer: { onPort(port: TransferredCoordinatorPort): void } | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The bot speaks the desktop host's event shapes (`agents` and
   * `agent-upserted` wrapped with ordering stamps), which the shipped renderer
   * reads. frontend/'s reconstruction reads the bare roster instead, so unwrap
   * for it.
   */
  readonly #adaptFrame: (frame: unknown) => unknown;

  constructor(config: WebConfig, token: string | null, options: { bareRosterEvents?: boolean } = {}) {
    this.config = config;
    this.#token = token;
    this.#adaptFrame = options.bareRosterEvents ? unwrapRosterEvents : (frame) => frame;
  }

  static async start(options: { bareRosterEvents?: boolean } = {}): Promise<WebSession> {
    const config = (await (await fetch("/api/config")).json()) as WebConfig;
    let token = config.auth ? storage(TOKEN_KEY) : null;
    while (config.auth && !(await WebSession.#check(token))) {
      token = window.prompt("This GrokBot is protected. Enter its access token:")?.trim() || null;
      if (token === null) throw new Error("An access token is required.");
      storage(TOKEN_KEY, token);
    }
    const session = new WebSession(config, token, options);
    session.watchVisibility();
    return session;
  }

  static async #check(token: string | null): Promise<boolean> {
    if (!token) return false;
    const response = await fetch("/api/auth", { headers: { authorization: `Bearer ${token}` } });
    return response.ok;
  }

  #socketUrl(): string {
    const url = new URL(`/agents/grok-bot/${encodeURIComponent(this.bot)}`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.#token) url.searchParams.set("token", this.#token);
    url.searchParams.set("viewer", this.viewer);
    return url.toString();
  }

  /** The renderer's `window.coordinatorPort`. */
  readonly coordinatorPort: CoordinatorPortBridge = {
    claim: (consumer) => {
      this.#consumer = consumer;
      return {
        request: () => this.#open(),
        release: () => {
          this.#consumer = null;
          clearTimeout(this.#timer);
          this.#current?.close();
          this.#current = null;
        }
      };
    }
  };

  #open(): void {
    clearTimeout(this.#timer);
    if (!this.#consumer) return;
    // The first claim connects at once; a reconnect after a drop backs off.
    const delay = this.#current === null && this.#attempt === 0 ? 0 : Math.min(8_000, 250 * 2 ** this.#attempt);
    this.#attempt++;
    this.#timer = setTimeout(() => {
      if (!this.#consumer) return;
      const port = new SocketPort(this.#socketUrl(), this.#adaptFrame);
      this.#current = port;
      port.addEventListener("message", (event) => {
        const frame = event.data as { kind?: string; phase?: string };
        if (frame?.kind === "lifecycle" && frame.phase === "ready") {
          this.#attempt = 0;
          // The bot forgets selections when it restarts, and only counts a
          // tab's selection while its socket is connected: say it again.
          this.#reportViewing();
        }
      });
      // The renderer never asks again after a port closes: in the desktop app
      // the main process pushes a fresh port whenever the coordinator comes
      // back. Do the same: reconnect (with backoff) and hand it over.
      port.addEventListener("close", () => {
        if (this.#current === port) this.#open();
      });
      this.#consumer.onPort(port);
    }, delay);
  }

  /** Call the bot's REST API (`/api/bots/<bot>/<path>`). */
  async api<T>(path: string, body?: unknown, init: { keepalive?: boolean } = {}): Promise<T> {
    const response = await fetch(`/api/bots/${encodeURIComponent(this.bot)}/${path}`, {
      ...init,
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
    return value;
  }

  /** Tell the bot about browser-side settings (Settings → Router, time zone). */
  async syncSettings(settings: { routerProvider?: string; timeZone?: string }): Promise<void> {
    await fetch(`/api/bots/${encodeURIComponent(this.bot)}/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {})
      },
      body: JSON.stringify(settings)
    }).catch(() => undefined);
  }

  /**
   * The renderer selected a chat (or none). A hidden tab is reported as
   * viewing nothing, like the host only marking the focused window's chat
   * viewed, so updates there still count as unread.
   */
  reportSelection(agentId: string | null): void {
    this.#selectionWritten = true;
    this.#selected = agentId;
    this.#reportViewing();
  }

  /**
   * The renderer read back its persisted selection on startup. It restores
   * that chat without writing it again, so this is the only report of it.
   */
  restoredSelection(agentId: string | null): void {
    if (this.#selectionWritten) return;
    this.#selected = agentId;
    this.#reportViewing();
  }

  #reportViewing(): void {
    const agentId = document.visibilityState === "hidden" ? null : this.#selected;
    const seq = ++this.#viewSeq;
    // A report sent while the bot restarts can be lost; retry it until it
    // lands or a newer one replaces it (the bot ignores older numbers).
    const send = (attempt: number): void => {
      // keepalive: the "hidden" report of a closing tab must outlive the page.
      void this.api("viewing", { viewer: this.viewer, agentId, seq }, { keepalive: true }).catch(() => {
        if (seq !== this.#viewSeq || attempt >= 6) return;
        setTimeout(() => send(attempt + 1), Math.min(8_000, 500 * 2 ** attempt));
      });
    };
    send(0);
  }

  watchVisibility(): void {
    document.addEventListener("visibilitychange", () => {
      if (this.#selected !== null) this.#reportViewing();
    });
  }

  /** Drop the socket; the renderer's client reclaims and reconnects. */
  reconnect(): void {
    this.#current?.close();
  }

  signOut(): void {
    storage(TOKEN_KEY, null);
    window.location.reload();
  }

  defaultModel(): AgentModelSelection {
    const model = this.config.defaultModel;
    return { modelId: `${model.provider}/${model.modelId}`, maxMode: false, parameters: [] };
  }

  async setDefaultModel(model: AgentModelSelection): Promise<AgentModelSelection> {
    return model;
  }

  availableModels(): unknown {
    return this.config.models.map((model) => ({
      id: `${model.provider}/${model.modelId}`,
      name: model.name,
      group: model.group
    }));
  }
}
