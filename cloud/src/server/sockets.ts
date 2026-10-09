import { LifecycleCapability } from "agents/lifecycle";
import {
  COORDINATOR_PROTOCOL_VERSION,
  COORDINATOR_UNKNOWN_METHOD,
  parseCoordinatorFrame
} from "../../../source/shared/rpc/coordinator-port";

/**
 * The renderer's coordinator port, over WebSocket. Frames are exactly the
 * desktop app's MessagePort frames (source/shared/rpc/coordinator-port.ts):
 * `hello` → `ready`, `request` → `reply`, and server-pushed `event`s.
 *
 * Sockets are accepted without hibernation: a connected renderer keeps its
 * bot in memory, and live pi watches stay attached. After an eviction or a
 * deploy the socket drops and the renderer's client reconnects on its own.
 */

export class CoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface CoordinatorHost {
  call(method: string, args: unknown, socket: WebSocket): Promise<unknown>;
  /** `request` is the upgrade request (its URL names the renderer's tab). */
  connected(socket: WebSocket, request: Request): void;
  disconnected(socket: WebSocket): void;
}

export class CoordinatorSockets extends LifecycleCapability {
  readonly #host: CoordinatorHost;
  readonly #sockets = new Set<WebSocket>();

  constructor(host: CoordinatorHost) {
    super("grokbot-coordinator");
    this.#host = host;
  }

  get count(): number {
    return this.#sockets.size;
  }

  onWebSocketUpgrade({ request }: { request: Request }): Response | undefined {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return undefined;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    let ready = false;
    server.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return this.#shutdown(server, "malformed JSON frame");
      }
      const parsed = parseCoordinatorFrame(value);
      if (!parsed.accepted) return this.#shutdown(server, parsed.rejection.detail);
      const frame = parsed.frame;
      if (frame.kind === "lifecycle" && frame.phase === "hello") {
        if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
          return this.#shutdown(server, "unsupported coordinator protocol version");
        }
        ready = true;
        this.#sockets.add(server);
        this.#send(server, { kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION });
        this.#host.connected(server, request);
        return;
      }
      if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
        server.close(1000, "requested");
        return;
      }
      if (frame.kind === "request") {
        if (!ready) return this.#shutdown(server, "request before hello");
        void this.#host.call(frame.method, frame.args, server).then(
          (value) =>
            this.#send(server, {
              kind: "reply",
              requestId: frame.requestId,
              outcome: { status: "ok", value: value === undefined ? null : value }
            }),
          (error: unknown) =>
            this.#send(server, {
              kind: "reply",
              requestId: frame.requestId,
              outcome: {
                status: "failed",
                failure: {
                  code: error instanceof CoordinatorError ? error.code : "failed",
                  message: error instanceof Error ? error.message : String(error)
                }
              }
            })
        );
      }
    });
    const closed = () => {
      if (!this.#sockets.delete(server)) return;
      this.#host.disconnected(server);
    };
    server.addEventListener("close", closed);
    server.addEventListener("error", closed);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push an event frame to every connected renderer. */
  broadcast(family: string, payload: unknown): void {
    const frame = JSON.stringify({ kind: "event", family, payload });
    for (const socket of this.#sockets) {
      try {
        socket.send(frame);
      } catch {
        this.#sockets.delete(socket);
      }
    }
  }

  send(socket: WebSocket, family: string, payload: unknown): void {
    this.#send(socket, { kind: "event", family, payload });
  }

  #send(socket: WebSocket, frame: unknown): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      this.#sockets.delete(socket);
    }
  }

  #shutdown(socket: WebSocket, detail: string): void {
    this.#send(socket, { kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    try {
      socket.close(1002, "protocol error");
    } catch {
      // Already closed.
    }
  }
}

export function unknownMethod(method: string): CoordinatorError {
  return new CoordinatorError(COORDINATOR_UNKNOWN_METHOD, `GrokBot Cloud does not implement ${method}`);
}
