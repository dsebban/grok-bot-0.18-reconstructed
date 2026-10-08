import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  BotState,
  ClientMessage,
  ModelInfo,
  ServerMessage,
  ThreadId,
  ToolInfo
} from "../shared/protocol";
import { EMPTY_VIEW, reduceAll, type ThreadView } from "../shared/view";

export type ConnectionStatus = "connecting" | "open" | "closed";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type Command = ClientMessage extends infer M ? (M extends unknown ? Omit<M, "id"> : never) : never;

const EMPTY_STATE: BotState = { threads: [], memory: [], files: [], automations: [] };

function socketUrl(bot: string, thread: ThreadId, token: string | null): string {
  const url = new URL(`/agents/grok-bot/${encodeURIComponent(bot)}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("thread", thread);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/**
 * One WebSocket to one thread of one bot. pi's events fold into a
 * `ThreadView` with the shared reducer; bot-wide state arrives as `state`
 * frames. Reconnects with backoff, and every reconnect starts from a fresh
 * snapshot, so a reload or a server restart mid-run just continues.
 */
export function useBot(bot: string, thread: ThreadId, token: string | null) {
  const [view, dispatch] = useReducer(
    (current: ThreadView, action: { reset?: true; events?: ServerMessage & { type: "events" } }) =>
      action.reset ? EMPTY_VIEW : action.events ? reduceAll(current, action.events.events) : current,
    EMPTY_VIEW
  );
  const [state, setState] = useState<BotState>(EMPTY_STATE);
  const [models, setModels] = useState<readonly ModelInfo[]>([]);
  const [tools, setTools] = useState<readonly ToolInfo[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const nextId = useRef(0);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    dispatch({ reset: true });

    const open = () => {
      if (disposed) return;
      setStatus("connecting");
      const ws = new WebSocket(socketUrl(bot, thread, token));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data) as ServerMessage;
        switch (message.type) {
          case "hello":
            setModels(message.models);
            setTools(message.tools);
            break;
          case "events":
            if (message.thread === thread) dispatch({ events: message });
            break;
          case "state": {
            const { type: _type, ...parts } = message;
            setState((current) => ({ ...current, ...parts }));
            break;
          }
          case "result":
            pending.current.get(message.id)?.resolve(message.result);
            pending.current.delete(message.id);
            break;
          case "error":
            if (message.id !== undefined && pending.current.has(message.id)) {
              pending.current.get(message.id)!.reject(new Error(message.message));
              pending.current.delete(message.id);
            } else {
              setLastError(message.message);
            }
            break;
        }
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        for (const [, waiter] of pending.current) waiter.reject(new Error("Disconnected"));
        pending.current.clear();
        if (disposed) return;
        setStatus("closed");
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        timer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [bot, thread, token]);

  const call = useCallback(<T = unknown>(command: Command): Promise<T> => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected"));
    }
    const id = String(++nextId.current);
    return new Promise<T>((resolve, reject) => {
      pending.current.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ ...command, id }));
    });
  }, []);

  return { view, state, models, tools, status, call, lastError, clearError: () => setLastError(null) };
}
