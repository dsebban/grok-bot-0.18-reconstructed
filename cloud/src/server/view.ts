import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  MessageChange
} from "@earendil-works/pi-durable";
export type ModelRef = { readonly provider: string; readonly modelId: string };

/**
 * What the UI renders for one thread, folded from pi's `AgentEvent`s.
 * Pure: the browser and the tests run exactly this code.
 */

export type Part =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    };

export type ToolResult = {
  readonly name: string;
  readonly text: string;
  readonly error: boolean;
};

export type ChatMessage = {
  /** pi entry id, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "notice";
  readonly parts: readonly Part[];
  readonly timestamp: number;
  readonly error?: string;
  readonly model?: string;
  /** Cut off by an abort or a crash; pi continues in a new message. */
  readonly interrupted?: boolean;
};

export type RunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

export type ThreadView = {
  readonly messages: readonly ChatMessage[];
  /** Tool results by call id, shown inside the call that produced them. */
  readonly results: Readonly<Record<string, ToolResult>>;
  readonly live: ChatMessage | null;
  readonly running: boolean;
  readonly tools: readonly RunningTool[];
  readonly queued: number;
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: ModelRef | null;
  readonly error: string | null;
};

export const EMPTY_VIEW: ThreadView = {
  messages: [],
  results: {},
  live: null,
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  model: null,
  error: null
};

const LIVE = "live";

function contentText(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("");
}

function blockToPart(block: AssistantMessage["content"][number]): Part {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", text: block.thinking };
    case "toolCall":
      return {
        type: "tool-call",
        callId: block.id,
        name: block.name,
        args: block.arguments
      };
  }
}

function toChat(message: Message, id: string): ChatMessage | undefined {
  switch (message.role) {
    case "user":
      return {
        id,
        role: "user",
        timestamp: message.timestamp,
        parts:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.map((part) =>
                part.type === "text"
                  ? { type: "text", text: part.text }
                  : { type: "image", mimeType: part.mimeType, data: part.data }
              )
      };
    case "assistant":
      return {
        id,
        role: "assistant",
        timestamp: message.timestamp,
        parts: message.content.map(blockToPart),
        model: message.model,
        ...(message.stopReason === "aborted" ? { interrupted: true } : {}),
        ...(message.errorMessage ? { error: message.errorMessage } : {})
      };
    default:
      return undefined;
  }
}

type Folded = Pick<ThreadView, "messages" | "results">;

function fold(view: Folded, entry: EntryRecord): Folded {
  if (entry.kind === "pi.reset") {
    const notice: ChatMessage = {
      id: String(entry.id),
      role: "notice",
      parts: [{ type: "text", text: "Context reset" }],
      timestamp: 0
    };
    return { messages: [notice], results: {} };
  }
  const message = entry.model?.[0];
  if (!message || entry.kind === "pi.system") return view;
  if (message.role === "toolResult") {
    return {
      ...view,
      results: {
        ...view.results,
        [message.toolCallId]: {
          name: message.toolName,
          text: contentText(message.content),
          error: message.isError
        }
      }
    };
  }
  const chat = toChat(message, String(entry.id));
  if (!chat || view.messages.some((known) => known.id === chat.id)) return view;
  return { ...view, messages: [...view.messages, chat] };
}

function applyChanges(
  live: ChatMessage | null,
  changes: readonly MessageChange[]
): ChatMessage | null {
  let message = live;
  for (const change of changes) {
    if (change.type === "message") {
      message = toChat(change.message, LIVE) ?? message;
      continue;
    }
    if (!message) continue;
    const parts = [...message.parts];
    const previous = parts[change.contentIndex];
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        parts[change.contentIndex] = blockToPart(change.block);
        break;
      case "text_delta":
        parts[change.contentIndex] = {
          type: "text",
          text: (previous?.type === "text" ? previous.text : "") + change.delta
        };
        break;
      case "thinking_delta":
        parts[change.contentIndex] = {
          type: "thinking",
          text:
            (previous?.type === "thinking" ? previous.text : "") + change.delta
        };
        break;
      default:
        break;
    }
    message = { ...message, parts };
  }
  return message;
}

export function reduce(view: ThreadView, event: AgentEvent): ThreadView {
  switch (event.type) {
    case "snapshot": {
      const folded = event.entries.reduce<Folded>(fold, {
        messages: [],
        results: {}
      });
      const partial = event.generation?.message;
      return {
        ...folded,
        live: partial ? (toChat(partial, LIVE) ?? null) : null,
        running: event.run !== undefined,
        tools: event.tools
          .filter((slot) => slot.status === "running")
          .map((slot) => ({
            callId: slot.callId,
            name: slot.name,
            output: slot.output ?? ""
          })),
        queued: event.inbox.length,
        retry: event.generation?.retry ?? null,
        model: event.agent.model ?? null,
        error: null
      };
    }
    case "run_start":
      return { ...view, running: true, error: null };
    case "run_end":
      return { ...view, running: false, live: null, tools: [], retry: null };
    case "message_start":
      return event.message.role === "assistant"
        ? { ...view, live: toChat(event.message, LIVE) ?? null }
        : view;
    case "message_update":
      return { ...view, live: applyChanges(view.live, event.changes) };
    case "message_end": {
      const next = { ...view, ...fold(view, event.entry) };
      return event.entry.model?.[0]?.role === "assistant"
        ? { ...next, live: null }
        : next;
    }
    case "entry_appended":
      return { ...view, ...fold(view, event.entry) };
    case "tool_execution_start":
      return {
        ...view,
        tools: [
          ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" }
        ]
      };
    case "tool_execution_update": {
      const output = event.output;
      if (!output) return view;
      return {
        ...view,
        tools: view.tools.map((tool) => {
          if (tool.callId !== event.toolCallId) return tool;
          if ("set" in output) return { ...tool, output: output.set };
          return {
            ...tool,
            output:
              tool.output.slice(output.trimStart ?? 0) + (output.append ?? "")
          };
        })
      };
    }
    case "tool_execution_end":
      return {
        ...view,
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId)
      };
    case "inbox_update":
      return { ...view, queued: event.items.length };
    case "auto_retry_start":
      return { ...view, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...view, retry: null };
    case "agent_changed":
      return { ...view, model: event.agent.model ?? null };
    case "task_failed":
      return { ...view, error: event.message };
    case "submission":
      return event.record.status === "unanswered" &&
        event.record.reason !== "aborted" &&
        event.record.reason !== "withdrawn"
        ? { ...view, error: `Not answered: ${event.record.reason}` }
        : view;
    default:
      return view;
  }
}

export function reduceAll(
  view: ThreadView,
  events: readonly AgentEvent[]
): ThreadView {
  return events.reduce(reduce, view);
}

/** Plain text of a message's text parts, for tests and previews. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
