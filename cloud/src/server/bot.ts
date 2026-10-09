import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  type AgentEvent,
  type AgentEventStream,
  type Extension
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { EMPTY_SAND_SHARING_STATE } from "../../../source/shared/agents/sharing";
import { ROSTER_REPLICA_KEY, transcriptReplicaKey } from "../../../source/shared/ordering";
import { Automations, presentAutomation, type RoutineSpec } from "./automations";
import { BOT_SECRET_KEYS, createRouter, type Router } from "./models";
import { CoordinatorError, CoordinatorSockets, unknownMethod, type CoordinatorHost } from "./sockets";
import { Store, titleFrom, type AgentRow } from "./store";
import { fileTools } from "./tools/files";
import { memorySection, memoryTools } from "./tools/memory";
import { scheduleTools } from "./tools/schedule";
import { webTools } from "./tools/web";
import { lastText, projectView, type GrokEntry } from "./transcript";
import { isAgentId, isRouterProviderId, modelKey, type AgentId, type ModelRef, type RouterProviderId } from "./types";
import { EMPTY_VIEW, reduceAll, type ThreadView } from "./view";

const BG = BACKGROUND_CONTEXT;
const NEW_CHAT = "New chat";
const NONCE_PREFIX = "nonce:";

export const PERSONA = [
  "You are Grok Bot, a sharp, witty and genuinely helpful assistant.",
  "Each chat with you is its own conversation; your memory, files and routines are shared across all of the user's chats and persist durably.",
  "Be direct and concise and use Markdown when it helps. Use your tools whenever they answer better than recall:",
  "memory_* for long-term facts about the user (save new personal facts proactively), files_* for durable notes and documents,",
  "web_fetch to read pages, schedule_prompt for reminders and recurring checks (they appear in the chat's Routines), current_time for dates and times.",
  "A message that starts with [routine] is a scheduled routine firing: carry out its instruction for the user."
].join(" ");

/** Options a test host can change; production uses the defaults. */
export type BotOptions = {
  readonly fetcher?: typeof fetch;
  readonly demoTokensPerSecond?: number;
};

type Watch = {
  readonly stream: AgentEventStream;
  view: ThreadView;
  entries: GrokEntry[];
  sent: Map<string, string>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function agentIdArg(args: unknown, key = "id"): AgentId {
  const id = record(args)[key];
  if (!isAgentId(id)) throw new CoordinatorError("invalid-args", `Expected an agent ${key}`);
  return id;
}

/**
 * One user's Grok Bot, in one Durable Object.
 *
 * The renderer from frontend/ talks to it with the desktop coordinator
 * protocol over a WebSocket (`CoordinatorSockets`). Every agent in its
 * sidebar is a pi-durable conversation: pi owns the transcript, the inbox
 * of follow-ups and steers, model turns, tool calls, retries and crash
 * recovery, and `PiHarness` wakes the object after eviction. This class
 * maps the coordinator methods onto pi and streams pi's events back as the
 * renderer's `transcript` and `agent-upserted` events.
 */
export class GrokBot extends DurableObject<Env> implements CoordinatorHost {
  readonly store = new Store(this.ctx.storage.sql);
  readonly registry = createRegistry();
  #router: Router | undefined;
  readonly #watches = new Map<AgentId, Promise<Watch>>();
  /** The chat each connected renderer has open (its last `openAgentTail`). */
  readonly #viewing = new Map<WebSocket, AgentId>();
  /**
   * Ordering for the renderer's replicas, as the desktop host does it
   * (host/extensions/transcript/replica-writer.ts): one epoch per isolate,
   * one sequence per replica key. A renderer that sees a new epoch or a gap
   * resyncs from a fresh page.
   */
  readonly #epoch = crypto.randomUUID();
  readonly #sequences = new Map<string, number>();
  #snapshotSeq = 0;

  #stamp(replicaKey: string) {
    const sequence = (this.#sequences.get(replicaKey) ?? 0) + 1;
    this.#sequences.set(replicaKey, sequence);
    return { replicaKey, epoch: this.#epoch, sequence };
  }

  #snapshotStamp() {
    return { snapshotEpoch: this.#epoch, snapshotSeq: ++this.#snapshotSeq };
  }

  #transcriptEvent(agentId: AgentId, event: Record<string, unknown>): void {
    const ordered = this.#stamp(transcriptReplicaKey(agentId));
    this.coordinator.broadcast(
      "transcript",
      event.type === "snapshot"
        ? { ...event, ordered, coverage: { kind: "transcript-live-range", fromSequence: 1, throughSequence: ordered.sequence } }
        : { ...event, agentId, ordered }
    );
  }

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(this.extension());
      return Harness.open(
        storage,
        {
          models: this.router.models,
          registry: this.registry,
          settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1_000 } },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: {
      model: { provider: this.router.defaultModel.provider, id: this.router.defaultModel.modelId },
      thinkingLevel: "low"
    }
  });

  readonly routines = new Automations(
    this.store,
    (agentId, prompt, operationId) => this.deliver(agentId, prompt, operationId),
    (agentId) => this.#automationsChanged(agentId),
    () => this.store.setting("timeZone") ?? undefined
  );
  readonly coordinator = new CoordinatorSockets(this);
  readonly lifecycle = Lifecycle.install(this).use(this.coordinator).use(this.harness).use(this.routines);

  /** Overridden by test hosts. A method, so it is available during construction. */
  protected botOptions(): BotOptions {
    return {};
  }

  get router(): Router {
    this.#router ??= createRouter(this.env, {
      demoTokensPerSecond: this.botOptions().demoTokensPerSecond,
      secret: (name) => this.store.secret(name)
    });
    return this.#router;
  }

  protected extension(): Extension {
    const noop = () => {};
    return {
      name: "grokbot",
      sections: [{ key: "persona", render: () => PERSONA, tag: false }, memorySection(this.store)],
      tools: [
        ...memoryTools(this.store, noop),
        ...fileTools(this.store, noop),
        ...webTools(this.botOptions().fetcher ?? fetch),
        ...scheduleTools(this.routines, this.store)
      ]
    };
  }

  onRequest(): Response {
    return new Response("GrokBot: connect with the coordinator WebSocket", { status: 426 });
  }

  // ── Settings ────────────────────────────────────────────────────────────

  routerProvider(): RouterProviderId {
    const value = this.store.setting("routerProvider");
    return isRouterProviderId(value) ? value : "cursor";
  }

  /** The model new turns use: Settings → Router, mapped onto this deployment's providers. */
  currentModel(): ModelRef {
    return this.router.forProvider(this.routerProvider());
  }

  async updateSettings(settings: { routerProvider?: unknown; timeZone?: unknown }) {
    await this.lifecycle.start();
    if (isRouterProviderId(settings.routerProvider)) this.store.setSetting("routerProvider", settings.routerProvider);
    if (typeof settings.timeZone === "string" && settings.timeZone.length < 64) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: settings.timeZone });
        this.store.setSetting("timeZone", settings.timeZone);
      } catch {
        // Unknown zone: keep the previous one.
      }
    }
    return { routerProvider: this.routerProvider(), model: modelKey(this.currentModel()) };
  }

  /**
   * Sidebar pins and sections. The desktop host keeps these host-side
   * (`getHostPinnedAgents`), so here they follow the bot space across browsers.
   */
  async sidebar(change: { pinnedAgentIds?: unknown; sections?: unknown } = {}) {
    await this.lifecycle.start();
    if (change.pinnedAgentIds !== undefined) this.store.setSetting("pinnedAgents", JSON.stringify(change.pinnedAgentIds));
    if (change.sections !== undefined) this.store.setSetting("sidebarSections", JSON.stringify(change.sections));
    const parse = (raw: string | null) => (raw === null ? null : (JSON.parse(raw) as unknown[]));
    return {
      pinnedAgentIds: parse(this.store.setting("pinnedAgents")) as string[] | null,
      sections: parse(this.store.setting("sidebarSections"))
    };
  }

  /** Settings → Router, as `desktop.agent.getInferenceRouter()` reports it. */
  async inferenceRouter() {
    await this.lifecycle.start();
    return {
      provider: this.routerProvider(),
      usage: { providers: this.store.usage() },
      // The Router panel's "local CLI" providers: ready when this deployment
      // can reach that vendor (a key, or AI Gateway).
      local: {
        "claude-code": { installed: true, authenticated: this.router.isReady("claude-code") },
        codex: { installed: true, authenticated: this.router.isReady("codex") }
      },
      model: modelKey(this.currentModel())
    };
  }

  async setInferenceRouter(provider: unknown) {
    if (!isRouterProviderId(provider)) throw new Error("Unknown router provider");
    await this.updateSettings({ routerProvider: provider });
    return this.inferenceRouter();
  }

  async secrets(change: { upsert?: Record<string, unknown>; remove?: unknown[] } = {}) {
    await this.lifecycle.start();
    for (const [name, value] of Object.entries(change.upsert ?? {})) {
      if (!(BOT_SECRET_KEYS as readonly string[]).includes(name)) throw new Error(`${name} cannot be stored here`);
      if (typeof value === "string" && value.trim()) this.store.setSecret(name, value.trim());
    }
    for (const name of change.remove ?? []) if (typeof name === "string") this.store.removeSecret(name);
    return { keys: this.store.secretNames(), isPersistent: true, synced: true };
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  async createAgent(name = NEW_CHAT, description = ""): Promise<Record<string, unknown>> {
    await this.lifecycle.start();
    const session = await this.harness.sessions.create();
    const model = this.currentModel();
    await session.setModel({ provider: model.provider, id: model.modelId });
    const row = this.store.addAgent(session.id, name.trim() || NEW_CHAT, description);
    return this.#publish(row);
  }

  async listAgents(): Promise<Record<string, unknown>[]> {
    await this.lifecycle.start();
    await this.#ensureFirstAgent();
    const busy = new Map((await this.harness.sessions.list()).map((session) => [session.id, session.busy]));
    const stamp = this.#snapshotStamp();
    return this.store.agents().map((row) => ({ ...this.#agentRecord(row, busy.get(row.id) ?? false), ...stamp }));
  }

  #firstAgent: Promise<void> | undefined;

  /** Like desktop onboarding: a new user starts with one agent to talk to. */
  #ensureFirstAgent(): Promise<void> {
    if (this.store.setting("onboarded") === "1") return Promise.resolve();
    this.#firstAgent ??= (async () => {
      if (this.store.agents().length === 0) {
        const session = await this.harness.sessions.create();
        const model = this.currentModel();
        await session.setModel({ provider: model.provider, id: model.modelId });
        this.store.addAgent(session.id, "Grok Bot", "Your assistant");
      }
      this.store.setSetting("onboarded", "1");
    })().finally(() => {
      this.#firstAgent = undefined;
    });
    return this.#firstAgent;
  }

  #agentRecord(row: AgentRow, isRunning: boolean): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isRunning,
      hasUnread: row.hasUnread,
      isHiddenFromSidebar: row.isHidden,
      notifyOnUpdates: row.notifyOnUpdates,
      isGroup: false,
      memberIds: [],
      conversationPartnerIds: [],
      awaitingUserResponse: null,
      lastEntry: row.lastPreview ? { kind: "text", text: row.lastPreview } : null,
      lastMessagePreview: row.lastPreview
    };
  }

  async #isRunning(id: AgentId): Promise<boolean> {
    const watch = await this.#watches.get(id)?.catch(() => undefined);
    if (watch) return watch.view.running;
    return this.harness.session(id).busy().catch(() => false);
  }

  async #publish(row: AgentRow | undefined): Promise<Record<string, unknown>> {
    if (!row) throw new CoordinatorError("not-found", "Agent not found");
    const agent = { ...this.#agentRecord(row, await this.#isRunning(row.id)), ...this.#snapshotStamp() };
    this.coordinator.broadcast("agent-upserted", { activeAgentId: "", agent, ordered: this.#stamp(ROSTER_REPLICA_KEY) });
    return agent;
  }

  async #publishRoster(): Promise<void> {
    if (this.coordinator.count === 0) return;
    const agents = await this.listAgents();
    this.coordinator.broadcast("agents", {
      activeAgentId: "",
      agents,
      ordered: this.#stamp(ROSTER_REPLICA_KEY),
      coverage: { kind: "complete-roster" }
    });
  }

  #automationsChanged(agentId: AgentId): void {
    this.coordinator.broadcast("automations", { agentId, automations: this.#automations(agentId) });
  }

  #automations(agentId?: AgentId) {
    const zone = this.store.setting("timeZone") ?? undefined;
    return this.store.automations(agentId).map((row) => ({ ...presentAutomation(row, zone), agentId: row.agentId }));
  }

  // ── Transcripts ─────────────────────────────────────────────────────────

  #watch(id: AgentId): Promise<Watch> {
    let watching = this.#watches.get(id);
    if (!watching) {
      watching = this.#startWatch(id);
      this.#watches.set(id, watching);
      watching.catch(() => this.#watches.delete(id));
    }
    return watching;
  }

  async #startWatch(id: AgentId): Promise<Watch> {
    const stream = await this.harness.session(id).events();
    const nonces = this.store.nonces(id);
    const view = reduceAll(EMPTY_VIEW, [stream.snapshot]);
    const entries = projectView(view, { nonceOf: (entryId) => nonces.get(entryId) });
    const watch: Watch = { stream, view, entries, sent: new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)])) };
    stream.start(async (events) => this.#onEvents(id, watch, events));
    return watch;
  }

  async #onEvents(id: AgentId, watch: Watch, events: readonly AgentEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type !== "submission") continue;
      const { requestId, entry } = event.record as { requestId?: string; entry?: unknown };
      if (requestId?.startsWith(NONCE_PREFIX) && entry !== undefined) {
        this.store.setNonce(id, String(entry), requestId.slice(NONCE_PREFIX.length));
      }
    }
    for (const event of events) {
      if (event.type !== "message_end") continue;
      const message = event.entry.model?.[0];
      if (message?.role !== "assistant" || message.usage === undefined) continue;
      this.store.recordUsage(this.routerProvider(), message.usage);
    }
    const wasRunning = watch.view.running;
    watch.view = reduceAll(watch.view, events);
    const nonces = this.store.nonces(id);
    const entries = projectView(watch.view, { nonceOf: (entryId) => nonces.get(entryId) });
    watch.entries = entries;

    const next = new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]));
    const dropped = [...watch.sent.keys()].some((key) => !next.has(key));
    let grew = false;
    if (dropped) {
      // A reset or a rewrite: replace the renderer's copy wholesale.
      this.#transcriptEvent(id, { type: "snapshot", activeAgentId: id, entries });
      grew = true;
    } else {
      for (const entry of entries) {
        const json = next.get(entry.id)!;
        const before = watch.sent.get(entry.id);
        if (before === undefined) {
          this.#transcriptEvent(id, { type: "appended", entry });
          grew = true;
        } else if (before !== json) {
          this.#transcriptEvent(id, { type: "updated", entry });
        }
      }
    }
    watch.sent = next;

    if (grew || wasRunning !== watch.view.running) {
      const preview = lastText(entries);
      const row = this.store.updateAgent(id, { lastPreview: preview, touch: grew });
      if (row) {
        const agent = { ...this.#agentRecord(row, watch.view.running), ...this.#snapshotStamp() };
        this.coordinator.broadcast("agent-upserted", { activeAgentId: "", agent, ordered: this.#stamp(ROSTER_REPLICA_KEY) });
      }
    }
  }

  async #page(id: AgentId, limit: unknown, beforeSeq: unknown) {
    if (!this.store.agent(id)) throw new CoordinatorError("not-found", "Agent not found");
    const { entries } = await this.#watch(id);
    const end = typeof beforeSeq === "number" && Number.isInteger(beforeSeq) ? Math.max(0, Math.min(beforeSeq, entries.length)) : entries.length;
    const size = typeof limit === "number" && limit > 0 ? Math.min(Math.floor(limit), 500) : 200;
    const start = Math.max(0, end - size);
    return { entries: entries.slice(start, end), ...(start > 0 ? { nextBeforeSeq: start } : {}) };
  }

  // ── Prompts ─────────────────────────────────────────────────────────────

  /** Submit a prompt to an agent's pi conversation; resolves once it is durable. */
  async sendPrompt(id: AgentId, prompt: string, options: { clientNonce?: string; whenBusy?: "followUp" | "steer" } = {}) {
    await this.lifecycle.start();
    const row = this.store.agent(id);
    if (!row) throw new CoordinatorError("not-found", "Agent not found");
    const text = prompt.trim();
    if (!text) throw new CoordinatorError("invalid-args", "The message is empty");
    const watch = await this.#watch(id);
    const model = this.currentModel();
    const current = watch.view.model;
    if (!current || current.provider !== model.provider || current.modelId !== model.modelId) {
      await this.harness.session(id).setModel({ provider: model.provider, id: model.modelId });
    }
    if (row.name === NEW_CHAT) this.store.updateAgent(id, { name: titleFrom(text) });
    const receipt = await this.harness.session(id).submit(text, {
      operationId: options.clientNonce ? `${NONCE_PREFIX}${options.clientNonce}` : crypto.randomUUID(),
      whenBusy: options.whenBusy ?? "followUp"
    });
    if (options.clientNonce) this.store.acceptNonce(id, options.clientNonce);
    await this.#publish(this.store.updateAgent(id, { touch: true }));
    return receipt;
  }

  /** Submit and wait for the answer (scripts and tests). */
  async prompt(id: AgentId, prompt: string) {
    const receipt = await this.sendPrompt(id, prompt);
    return this.harness.session(id).wait(receipt.operationId);
  }

  async deliver(agentId: AgentId, prompt: string, operationId: string) {
    await this.#watch(agentId);
    const receipt = await this.harness.session(agentId).submit(prompt, { operationId });
    // Unread unless someone has this chat open, as the host's arrival marking does.
    const watched = [...this.#viewing.values()].includes(agentId);
    await this.#publish(this.store.updateAgent(agentId, { touch: true, ...(watched ? {} : { hasUnread: true }) }));
    const settled = this.harness
      .session(agentId)
      .wait(receipt.operationId)
      .then((result) => ({ ok: result.status === "done", ...(result.reason ? { detail: result.reason } : {}) }));
    return { settled };
  }

  /** The current transcript as Grok Bot entries (tests and the REST API). */
  async transcript(id: AgentId): Promise<GrokEntry[]> {
    await this.lifecycle.start();
    return (await this.#watch(id)).entries;
  }

  // ── CoordinatorHost ─────────────────────────────────────────────────────

  connected(): void {}

  disconnected(socket: WebSocket): void {
    this.#viewing.delete(socket);
    if (this.coordinator.count > 0) return;
    // Nobody is watching: drop the in-memory watches. pi keeps running.
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    for (const watching of watches) void watching.then((watch) => watch.stream.stop(), () => undefined);
  }

  async call(method: string, args: unknown, socket?: WebSocket): Promise<unknown> {
    await this.lifecycle.start();
    const a = record(args);
    switch (method) {
      // Roster
      case "listAgents":
        return this.listAgents();
      case "countAgents":
        await this.#ensureFirstAgent();
        return this.store.agents().length;
      case "searchAgents": {
        const query = String(a.query ?? "").toLowerCase();
        return (await this.listAgents()).filter((agent) => String(agent.name).toLowerCase().includes(query));
      }
      case "createAgent":
        // The desktop host answers { agent }.
        return {
          agent: await this.createAgent(typeof a.name === "string" ? a.name : NEW_CHAT, typeof a.description === "string" ? a.description : "")
        };
      case "updateAgent": {
        const id = agentIdArg(a);
        const profile = record(a.profile);
        const row = this.store.updateAgent(id, {
          ...(typeof profile.name === "string" ? { name: profile.name } : typeof a.name === "string" ? { name: a.name } : {}),
          ...(typeof profile.description === "string" ? { description: profile.description } : {})
        });
        return row ? this.#publish(row) : null;
      }
      case "deleteAgents": {
        const ids = Array.isArray(a.ids) ? a.ids.filter(isAgentId) : [];
        for (const id of ids) {
          if (await this.#isRunning(id)) await this.harness.session(id).abort().catch(() => false);
          for (const routine of this.store.automations(id)) await this.routines.remove(routine.id);
          this.store.deleteAgent(id);
        }
        await this.#publishRoster();
        return { deletedIds: ids };
      }
      case "duplicateAgent": {
        const id = agentIdArg(a);
        const source = this.store.agent(id);
        if (!source) throw new CoordinatorError("not-found", "Agent not found");
        const fork = await this.harness.sessions.fork(id).catch(() => this.harness.sessions.create());
        const row = this.store.addAgent(fork.id, `${source.name} (copy)`, source.description);
        this.store.updateAgent(fork.id, { lastPreview: source.lastPreview });
        return { agent: await this.#publish(this.store.agent(row.id)) };
      }
      case "setAgentUnread":
        await this.#publish(this.store.updateAgent(agentIdArg(a), { hasUnread: a.isUnread === true }));
        return null;
      case "setAgentHiddenFromSidebar":
        await this.#publish(this.store.updateAgent(agentIdArg(a), { isHidden: a.isHidden !== false && a.hidden !== false }));
        return null;
      case "setAgentNotifyOnUpdates":
      case "setAgentNotificationsEnabled":
        await this.#publish(this.store.updateAgent(agentIdArg(a), { notifyOnUpdates: a.isEnabled === true || a.enabled === true || a.notifyOnUpdates === true }));
        return null;

      // Transcript
      case "openAgentTail": {
        // Opening a chat marks it viewed, as the desktop host's activation does.
        const id = agentIdArg(a);
        if (socket) this.#viewing.set(socket, id);
        const page = await this.#page(id, a.limit, a.beforeSeq);
        if (this.store.agent(id)?.hasUnread) await this.#publish(this.store.updateAgent(id, { hasUnread: false }));
        return page;
      }
      case "getAgentTranscriptTail":
        return this.#page(agentIdArg(a), a.limit, a.beforeSeq);
      case "getAgentTranscriptWindow":
        return { ...(await this.#page(agentIdArg(a), a.limit, a.beforeSeq)), threadCounts: {} };
      case "getAgentThread":
        return { entries: [] };
      case "getConversationOutline":
        return [];
      case "sendPrompt": {
        const id = agentIdArg(a, "agentId");
        const receipt = await this.sendPrompt(id, String(a.prompt ?? ""), {
          ...(typeof a.clientNonce === "string" ? { clientNonce: a.clientNonce } : {})
        });
        return { status: "accepted", accepted: true, operationId: receipt.operationId };
      }
      case "promptAcceptanceStatus": {
        // The host's acceptance ledger lookup. After a reconnect the renderer
        // resends anything "not-found"; pi's operation ids make that idempotent.
        const nonce = typeof a.clientNonce === "string" ? a.clientNonce : "";
        const found = this.store.acceptance(nonce);
        if (!found) return { outcome: "not-found" };
        return {
          outcome: "found",
          record: {
            accountSlot: typeof a.accountSlot === "string" ? a.accountSlot : "host",
            clientNonce: nonce,
            inputDigest: "",
            status: "accepted",
            acceptedAtMs: found.acceptedAt,
            agentId: found.agentId,
            echoEntryId: found.entryId,
            rejectionCode: null
          }
        };
      }
      case "reactToMessage":
        return null;

      // Routines
      case "getAgentAutomations":
        return this.#automations(agentIdArg(a));
      case "listAllAutomations":
        return this.#automations();
      case "createAgentAutomation": {
        const id = agentIdArg(a);
        await this.routines.create(id, this.#spec(a.spec));
        return this.#automations(id);
      }
      case "updateAgentAutomation": {
        const id = agentIdArg(a);
        await this.routines.update(String(a.automationId), this.#spec(a.spec));
        return this.#automations(id);
      }
      case "setAgentAutomationEnabled": {
        const id = agentIdArg(a);
        await this.routines.setEnabled(String(a.automationId), a.isEnabled === true);
        return this.#automations(id);
      }
      case "deleteAgentAutomation": {
        const id = agentIdArg(a);
        await this.routines.remove(String(a.automationId));
        return this.#automations(id);
      }
      case "runAgentAutomationNow":
        await this.routines.runNow(String(a.automationId));
        return null;

      // Capabilities GrokBot Cloud does not have (desktop computer, rooms,
      // channels, skills marketplace): the same "nothing here" answers a
      // desktop host gives when the feature is off.
      case "getAgentChannels":
      case "refreshChannel":
        return { manifests: [], connections: [] };
      case "getSharingState":
        return EMPTY_SAND_SHARING_STATE;
      case "getTeachRecordingStatus":
        return { state: "idle", agentId: null, startedAtMs: null, maxDurationMs: 0 };
      case "getListenerIntegrations":
        return { integrations: [] };
      case "isAgentNetworkEnabled":
      case "isGlobalSearchEnabled":
      case "isEgressTunnelAvailable":
        return false;
      case "getTrays":
      case "getAsyncTasks":
      case "getSubagents":
      case "getAgentWorkflows":
      case "searchMedia":
      case "skillsCatalog":
      case "syncPluginSkills":
      case "listRoutedMcpTools":
        return [];
      case "getForeverBoxStatus":
      case "ensureForeverBox":
      case "getCloudAgentInfo":
      case "respondToWidget":
      case "kickstartAgent":
        return null;
      case "dismissTray":
      case "clearTrays":
      case "handBackForeverBox":
      case "resolveAutoReviewApproval":
      case "resolveLocalToolPermission":
      case "submitSecret":
        return null;
      default:
        throw unknownMethod(method);
    }
  }

  #spec(value: unknown): RoutineSpec {
    const spec = record(value);
    const trigger = record(spec.trigger);
    if (trigger.type !== "cron" || typeof trigger.schedule !== "string") {
      throw new CoordinatorError("unsupported-trigger", "GrokBot Cloud routines run on a schedule");
    }
    return {
      name: typeof spec.name === "string" ? spec.name : "Routine",
      prompt: typeof spec.prompt === "string" ? spec.prompt : "",
      schedule: trigger.schedule,
      isEnabled: spec.isEnabled !== false
    };
  }
}

