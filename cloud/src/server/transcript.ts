import type { ChatMessage, Part, ThreadView, ToolResult } from "./view";

/**
 * Projects a pi conversation (folded into a `ThreadView` from pi's agent
 * events) into Grok Bot transcript entries, the shapes the desktop host
 * wrote and the renderer from frontend/ reads:
 *
 * - user input        → `{ kind: "message", role: "user", content }`
 * - assistant text    → `{ kind: "send-message", message: { type: "text", content } }`
 * - thinking          → not shown (the desktop host keeps it out of the transcript too)
 * - tool calls        → `{ kind: "tool-call", name, status, summary }`
 * - resets and errors → `{ kind: "notice", text }`
 *
 * Ids are positional like the desktop host's (`t{turn}u`, `t{turn}s{n}`),
 * prefixed with the context epoch, so the message pi is streaming has the
 * same id it will have once committed: the renderer gets an `updated`, not
 * a second bubble.
 */

export type GrokEntry = {
  readonly id: string;
  readonly kind: string;
  readonly timestampMs: number;
  readonly [key: string]: unknown;
};

export type ProjectOptions = {
  /** The renderer's clientNonce for a user entry, by pi entry id. */
  readonly nonceOf: (piEntryId: string) => string | undefined;
};

const MAX_SUMMARY = 140;

function textOf(parts: readonly Part[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function oneLine(value: string, max = MAX_SUMMARY): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function argSummary(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const values = Object.values(args as Record<string, unknown>).filter(
    (value) => typeof value === "string" || typeof value === "number"
  );
  return oneLine(values.map(String).join(" · "), 80);
}

function toolSummary(args: unknown, result: ToolResult | undefined): string | undefined {
  const parts = [argSummary(args)];
  if (result) parts.push(oneLine(result.text.split("\n")[0] ?? ""));
  const summary = parts.filter(Boolean).join(" → ");
  return summary.length > 0 ? oneLine(summary) : undefined;
}

function toolStatus(
  callId: string,
  view: ThreadView,
  message: ChatMessage,
  isLive: boolean
): "pending" | "running" | "done" | "failed" | "aborted" {
  const result = view.results[callId];
  if (result) return result.error ? "failed" : "done";
  if (view.tools.some((tool) => tool.callId === callId)) return "running";
  if (isLive || view.running) return "pending";
  return message.interrupted ? "aborted" : "aborted";
}

export function projectView(view: ThreadView, options: ProjectOptions): GrokEntry[] {
  const entries: GrokEntry[] = [];
  let epoch = "0";
  let turn = -1;
  let sends = 0;

  const push = (message: ChatMessage, isLive: boolean) => {
    const timestampMs = message.timestamp || Date.now();
    if (message.role === "notice") {
      // A reset starts a new context, and new ids.
      epoch = message.id;
      turn = -1;
      sends = 0;
      entries.push({ id: `e${epoch}n`, kind: "notice", content: textOf(message.parts) || "Context reset", timestampMs });
      return;
    }
    if (message.role === "user") {
      turn += 1;
      sends = 0;
      const clientNonce = options.nonceOf(message.id);
      entries.push({
        id: `e${epoch}t${turn}u`,
        kind: "message",
        role: "user",
        content: textOf(message.parts),
        isStreaming: false,
        timestampMs,
        ...(clientNonce ? { clientNonce } : {})
      });
      return;
    }
    const prefix = `e${epoch}t${turn < 0 ? "b" : turn}`;
    message.parts.forEach((part) => {
      if (part.type === "text") {
        if (part.text.length === 0 && !isLive) return;
        entries.push({
          id: `${prefix}s${sends++}`,
          kind: "send-message",
          message: { type: "text", content: part.text },
          timestampMs,
          ...(isLive ? { streaming: true } : {})
        });
      } else if (part.type === "tool-call") {
        const result = view.results[part.callId];
        const summary = toolSummary(part.args, result);
        entries.push({
          id: `${prefix}c-${part.callId}`,
          kind: "tool-call",
          name: part.name,
          status: toolStatus(part.callId, view, message, isLive),
          ...(summary ? { summary } : {}),
          timestampMs
        });
      }
    });
    if (message.error && !message.interrupted) {
      entries.push({ id: `${prefix}x${sends++}`, kind: "notice", content: `The model failed: ${message.error}`, timestampMs });
    }
  };

  for (const message of view.messages) push(message, false);
  if (view.live) push(view.live, true);
  if (view.error) {
    entries.push({ id: `e${epoch}t${turn}err`, kind: "notice", content: view.error, timestampMs: Date.now() });
  }
  return entries;
}

/** What the sidebar shows for an agent: its last visible text. */
export function lastText(entries: readonly GrokEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "send-message") {
      const content = (entry.message as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) return oneLine(content, 200);
    }
    if (entry.kind === "message" && typeof entry.content === "string" && entry.content.trim()) {
      return oneLine(entry.content, 200);
    }
  }
  return null;
}
