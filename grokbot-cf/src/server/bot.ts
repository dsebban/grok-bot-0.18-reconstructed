import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type AgentEventStream,
  type ConversationId,
  type Extension
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import {
  modelKey,
  ROOT_THREAD,
  type BotState,
  type ClientMessage,
  type ModelRef,
  type ServerMessage,
  type ThreadId,
  type ThreadInfo,
  type UsageInfo
} from "../shared/protocol";
import { EMPTY_VIEW, messageText, reduceAll } from "../shared/view";
import { Automations } from "./automations";
import { createRouter, type Router } from "./models";
import { BotSockets, type SocketHost } from "./sockets";
import { Store, titleFrom } from "./store";
import { fileTools } from "./tools/files";
import { memorySection, memoryTools } from "./tools/memory";
import { scheduleTools } from "./tools/schedule";
import type { OnChange } from "./tools/util";
import { webTools } from "./tools/web";

const BG = BACKGROUND_CONTEXT;

export const PERSONA = [
  "You are GrokBot, a sharp, witty and genuinely helpful personal assistant that lives in the cloud.",
  "You run on Cloudflare Durable Objects: your conversations, memory, files and schedules persist across restarts.",
  "Be direct and concise; use Markdown when it helps. Use your tools whenever they can answer better than recall:",
  "memory_* for long-term facts about the user (save new personal facts proactively), files_* for the user's durable notes and documents,",
  "web_fetch to read pages, schedule_prompt for reminders and recurring checks, current_time for dates and times."
].join(" ");

/** Options a test host can change; production uses the defaults. */
export type BotOptions = {
  readonly fetcher?: typeof fetch;
  readonly demoTokensPerSecond?: number;
};

/**
 * One GrokBot: a Durable Object holding any number of threads (pi
 * conversations), plus the memory, files and automations they share.
 *
 * pi-durable owns every run: transcripts, the inbox of follow-ups and
 * steers, generation and tool tasks, retries and crash recovery, all in
 * its `pi_*` tables. `PiHarness` gives it this object's SQLite and wakes
 * the object (through Lifecycle's alarm) when pi has work after an
 * eviction. GrokBot adds its tools, its own `gb_*` state, scheduled
 * prompts, and a WebSocket protocol for the UI.
 */
export class GrokBot extends DurableObject<Env> implements SocketHost {
  readonly store = new Store(this.ctx.storage.sql);
  #router: Router | undefined;
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(this.extension());
      return Harness.open(
        storage,
        {
          models: this.router.models,
          registry: this.registry,
          settings: {
            // 1, 2, 4, 8, 16 s: about half a minute for a rate-limited model.
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1_000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: {
      model: {
        provider: this.router.defaultModel.provider,
        id: this.router.defaultModel.modelId
      },
      thinkingLevel: "low"
    }
  });

  readonly automations = new Automations(
    this.store,
    (thread, prompt, operationId) => this.deliver(thread, prompt, operationId),
    () => void this.sockets.broadcast(["automations"])
  );
  readonly sockets = new BotSockets(this);
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness)
    .use(this.automations);

  get router(): Router {
    this.#router ??= createRouter(this.env, {
      demoTokensPerSecond: this.botOptions().demoTokensPerSecond
    });
    return this.#router;
  }

  /** Overridden by test hosts. A method, so it is available during construction. */
  protected botOptions(): BotOptions {
    return {};
  }

  get botName(): string {
    return this.lifecycle.name;
  }

  /** GrokBot's pi extension: persona, memory section, and every tool. */
  protected extension(): Extension {
    const onChange: OnChange = (what) => void this.sockets.broadcast([what]);
    return {
      name: "grokbot",
      sections: [
        { key: "persona", render: () => PERSONA, tag: false },
        memorySection(this.store)
      ],
      tools: [
        ...memoryTools(this.store, onChange),
        ...fileTools(this.store, onChange),
        ...webTools(this.botOptions().fetcher ?? fetch),
        ...scheduleTools(this.automations, this.store)
      ]
    };
  }

  /** Host startup, after the harness opened pi. */
  async onStart(): Promise<void> {
    this.store.ensureThread(ROOT_THREAD);
    await this.sockets.reattach();
  }

  onRequest(): Response {
    return new Response("GrokBot: connect with a WebSocket", { status: 426 });
  }

  // ── Operations (also reachable over RPC) ───────────────────────────────

  /** Submit a message to a thread; resolves once pi has it durably. */
  async submit(
    thread: ThreadId,
    text: string,
    options: { whenBusy?: "followUp" | "steer"; operationId?: string } = {}
  ) {
    await this.lifecycle.start();
    if (!text.trim()) throw new Error("Message is empty");
    this.store.touchThread(thread, text);
    const receipt = await this.harness.session(thread).submit(text, {
      ...(options.whenBusy ? { whenBusy: options.whenBusy } : {}),
      ...(options.operationId ? { operationId: options.operationId } : {})
    });
    this.#afterSettled(thread, receipt.operationId);
    return receipt;
  }

  /** Refresh every client's thread list (busy flags) now and once the operation settles. */
  #afterSettled(thread: ThreadId, operationId: string): void {
    void this.sockets.broadcast(["threads"]);
    void this.harness
      .session(thread)
      .wait(operationId)
      .then(
        () => this.sockets.broadcast(["threads"]),
        () => undefined
      );
  }

  /** Submit and wait for the answer. */
  async prompt(thread: ThreadId, text: string) {
    const receipt = await this.submit(thread, text);
    return this.harness.session(thread).wait(receipt.operationId);
  }

  /** Wait for an earlier submission to settle. */
  async wait(thread: ThreadId, operationId: string) {
    await this.lifecycle.start();
    return this.harness.session(thread).wait(operationId);
  }

  async deliver(thread: ThreadId, prompt: string, operationId: string): Promise<void> {
    this.store.touchThread(thread);
    await this.harness.session(thread).submit(prompt, { operationId });
    this.#afterSettled(thread, operationId);
  }

  async createThread(parent?: ThreadId): Promise<ThreadId> {
    await this.lifecycle.start();
    const session =
      parent === undefined
        ? await this.harness.sessions.create()
        : await this.harness.sessions.fork(parent);
    this.store.ensureThread(session.id, parent);
    if (parent !== undefined) {
      const title = this.store.thread(parent)?.title || `Thread ${parent}`;
      this.store.renameThread(session.id, titleFrom(`Fork of ${title}`));
    }
    void this.sockets.broadcast(["threads"]);
    return session.id;
  }

  async setModel(thread: ThreadId, model: ModelRef): Promise<void> {
    await this.lifecycle.start();
    if (!this.router.models.getModel(model.provider, model.modelId)) {
      throw new Error(`Unknown model ${modelKey(model)}`);
    }
    await this.harness.session(thread).setModel({ provider: model.provider, id: model.modelId });
  }

  async usage(thread: ThreadId): Promise<UsageInfo> {
    const pi = await this.harness.pi();
    const state = await pi.snapshot(UsageDoc, Number(thread) as ConversationId, BG);
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const usage of Object.values(state?.models ?? {})) {
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cost += usage.cost?.total ?? 0;
    }
    return { input, output, cost };
  }

  /** The thread's visible transcript, as plain text per message. */
  async messages(thread: ThreadId) {
    await this.lifecycle.start();
    const stream = await this.harness.session(thread).events(BG);
    await stream.stop();
    const view = reduceAll(EMPTY_VIEW, [stream.snapshot]);
    return {
      running: view.running,
      messages: view.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: messageText(message),
        ...(message.interrupted ? { interrupted: true } : {}),
        tools: message.parts.flatMap((part) =>
          part.type === "tool-call"
            ? [{ name: part.name, result: view.results[part.callId]?.text ?? null }]
            : []
        )
      }))
    };
  }

  async threads(): Promise<ThreadInfo[]> {
    const sessions = await this.harness.sessions.list();
    const busy = new Map(sessions.map((session) => [session.id, session.busy]));
    // Only top-level threads: conversations owned by tools stay internal.
    for (const session of sessions) {
      if (session.id === ROOT_THREAD) this.store.ensureThread(session.id);
    }
    return this.store
      .threads()
      .filter((row) => busy.has(row.id))
      .map((row) => ({
        ...row,
        title: row.title || (row.id === ROOT_THREAD ? "First thread" : `Thread ${row.id}`),
        busy: busy.get(row.id) ?? false
      }));
  }

  // ── SocketHost ─────────────────────────────────────────────────────────

  getWebSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  hello(thread: ThreadId): Omit<Extract<ServerMessage, { type: "hello" }>, "type"> {
    return {
      bot: this.botName,
      thread,
      models: this.router.catalog,
      tools: this.registry
        .snapshot()
        .tools()
        .map(({ tool }) => ({ name: tool.name, description: tool.description }))
    };
  }

  async state(parts?: readonly (keyof BotState)[]): Promise<Partial<BotState>> {
    const want = (part: keyof BotState) => parts === undefined || parts.includes(part);
    return {
      ...(want("threads") ? { threads: await this.threads() } : {}),
      ...(want("memory") ? { memory: this.store.memories() } : {}),
      ...(want("files") ? { files: this.store.files() } : {}),
      ...(want("automations") ? { automations: this.store.automations() } : {})
    };
  }

  async knownThreads(): Promise<ThreadId[]> {
    return (await this.harness.sessions.list()).map((session) => session.id);
  }

  events(thread: ThreadId): Promise<AgentEventStream> {
    return this.harness.session(thread).events();
  }

  async command(thread: ThreadId, message: ClientMessage): Promise<unknown> {
    const session = this.harness.session(thread);
    switch (message.type) {
      case "send":
        return this.submit(thread, message.text, {
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
      case "abort":
        return session.abort();
      case "reset":
        await session.reset(message.handoff);
        return null;
      case "thread.create":
        return { thread: await this.createThread() };
      case "thread.fork":
        return { thread: await this.createThread(thread) };
      case "thread.rename":
        this.store.renameThread(thread, message.title);
        await this.sockets.broadcast(["threads"]);
        return null;
      case "thread.archive":
        this.store.archiveThread(thread, message.archived);
        await this.sockets.broadcast(["threads"]);
        return null;
      case "model.set":
        await this.setModel(thread, message.model);
        return null;
      case "usage":
        return this.usage(thread);
      case "memory.add": {
        const item = this.store.remember(message.content);
        await this.sockets.broadcast(["memory"]);
        return item;
      }
      case "memory.delete": {
        const removed = this.store.forget(message.memoryId);
        await this.sockets.broadcast(["memory"]);
        return removed;
      }
      case "file.read":
        return { path: message.path, content: this.store.readFile(message.path) ?? null };
      case "file.delete": {
        const removed = this.store.deleteFile(message.path);
        await this.sockets.broadcast(["files"]);
        return removed;
      }
      case "automation.delete":
        return this.automations.cancel(message.automationId);
      default:
        throw new Error(`Unknown command ${JSON.stringify((message as { type: string }).type)}`);
    }
  }
}
