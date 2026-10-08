import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  isThreadId,
  ROOT_THREAD,
  type BotState,
  type ClientMessage,
  type ServerMessage,
  type ThreadId
} from "../shared/protocol";

const THREAD_TAG = "thread:";
/** `WebSocket.OPEN`; not defined as a global on every runtime. */
const OPEN = 1;

/** What the socket glue needs from the bot. */
export interface SocketHost {
  readonly botName: string;
  getWebSockets(tag?: string): WebSocket[];
  hello(thread: ThreadId): Omit<Extract<ServerMessage, { type: "hello" }>, "type">;
  state(parts?: readonly (keyof BotState)[]): Promise<Partial<BotState>>;
  knownThreads(): Promise<ThreadId[]>;
  events(thread: ThreadId): Promise<AgentEventStream>;
  command(thread: ThreadId, message: ClientMessage): Promise<unknown>;
}

export function threadFromRequest(request: Request): ThreadId {
  const thread = new URL(request.url).searchParams.get("thread");
  if (thread === null || thread === "") return ROOT_THREAD;
  if (!isThreadId(thread)) throw new Error(`Invalid thread ${JSON.stringify(thread)}`);
  return thread;
}

function threadOf(tags: readonly string[]): ThreadId {
  return tags.find((tag) => tag.startsWith(THREAD_TAG))?.slice(THREAD_TAG.length) ?? ROOT_THREAD;
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Closed between the check and the send.
  }
}

/**
 * App glue between the `WebSockets` capability and the bot. Each socket
 * follows one thread through its own pi event watch: a snapshot first, then
 * one batch per pi commit. Watches live in memory, so after the object
 * restarts `reattach()` gives every surviving (hibernated) socket a fresh
 * watch, and the client replaces its view with the new snapshot.
 */
export class BotSockets {
  readonly #host: SocketHost;
  readonly #watches = new Map<WebSocket, AgentEventStream>();

  constructor(host: SocketHost) {
    this.#host = host;
  }

  options(): WebSocketsOptions {
    return {
      // Plain JSON frames only: no Agent protocol frames on these sockets.
      protocol: () => false,
      getConnectionTags: (_connection, ctx) => [
        `${THREAD_TAG}${threadFromRequest(ctx.request)}`
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) => this.#onMessage(connection, message),
        onClose: (connection) => this.#unwatch(connection),
        onError: (connection) => this.#unwatch(connection)
      }
    };
  }

  /** Re-watch every socket that outlived the previous isolate. */
  async reattach(): Promise<void> {
    if (this.#host.getWebSockets().length === 0) return;
    for (const thread of await this.#host.knownThreads()) {
      for (const socket of this.#host.getWebSockets(`${THREAD_TAG}${thread}`)) {
        if (!this.#watches.has(socket)) await this.#watch(socket, thread);
      }
    }
  }

  /** Send bot-wide state to every socket. */
  async broadcast(parts?: readonly (keyof BotState)[]): Promise<void> {
    const sockets = this.#host.getWebSockets();
    if (sockets.length === 0) return;
    const state = await this.#host.state(parts);
    for (const socket of sockets) send(socket, { type: "state", ...state });
  }

  async close(): Promise<void> {
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(watches.map((watch) => watch.stop()));
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const thread = threadFromRequest(ctx.request);
    send(connection, { type: "hello", ...this.#host.hello(thread) });
    send(connection, { type: "state", ...(await this.#host.state()) });
    await this.#watch(connection, thread);
  }

  async #watch(socket: WebSocket, thread: ThreadId): Promise<void> {
    await this.#unwatch(socket);
    const stream = await this.#host.events(thread);
    this.#watches.set(socket, stream);
    send(socket, { type: "events", thread, events: [stream.snapshot] });
    stream.start(async (events) => {
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      send(socket, { type: "events", thread, events });
      // Thread list busy flags change when a run starts or ends.
      if (events.some((event) => event.type === "run_start" || event.type === "run_end")) {
        void this.broadcast(["threads"]);
      }
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);
    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage): Promise<void> {
    if (typeof raw !== "string") return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    const thread = threadOf(connection.tags);
    try {
      const result =
        message.type === "resync"
          ? await this.#watch(connection, thread).then(() => null)
          : await this.#host.command(thread, message);
      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result: result ?? null });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
