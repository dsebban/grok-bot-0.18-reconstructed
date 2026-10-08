import type { AgentEvent } from "@earendil-works/pi-durable";

/**
 * GrokBot's WebSocket protocol. One socket follows one thread of one bot:
 * `/agents/grok-bot/<bot>?thread=<id>`. pi's own `AgentEvent`s for that
 * thread are forwarded unchanged; bot-wide state (threads, memory, files,
 * automations) is broadcast to every socket of the bot.
 */

export type ThreadId = string;

export type ModelRef = { readonly provider: string; readonly modelId: string };

export type ModelInfo = ModelRef & {
  readonly name: string;
  /** Provider display name, for grouping in the picker. */
  readonly group: string;
};

export type ThreadInfo = {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly parent?: ThreadId;
  readonly busy: boolean;
};

export type MemoryItem = {
  readonly id: number;
  readonly content: string;
  readonly createdAt: number;
};

export type FileInfo = {
  readonly path: string;
  readonly size: number;
  readonly updatedAt: number;
};

export type Automation = {
  readonly id: string;
  readonly thread: ThreadId;
  readonly prompt: string;
  readonly nextRun: number;
  /** Repeat interval; absent for a one-shot. */
  readonly everyMinutes?: number;
  readonly runs: number;
  readonly lastRun?: number;
  readonly active: boolean;
};

export type ToolInfo = { readonly name: string; readonly description: string };

export type UsageInfo = {
  readonly input: number;
  readonly output: number;
  readonly cost: number;
};

export type BotState = {
  readonly threads: readonly ThreadInfo[];
  readonly memory: readonly MemoryItem[];
  readonly files: readonly FileInfo[];
  readonly automations: readonly Automation[];
};

/** Client → server. Commands carrying an `id` are answered with `result` or `error`. */
export type ClientMessage = { readonly id?: string } & (
  | {
      readonly type: "send";
      readonly text: string;
      readonly whenBusy?: "followUp" | "steer";
      readonly operationId?: string;
    }
  | { readonly type: "abort" }
  | { readonly type: "reset"; readonly handoff?: string }
  | { readonly type: "resync" }
  | { readonly type: "thread.create" }
  | { readonly type: "thread.fork" }
  | { readonly type: "thread.rename"; readonly title: string }
  | { readonly type: "thread.archive"; readonly archived: boolean }
  | { readonly type: "model.set"; readonly model: ModelRef }
  | { readonly type: "usage" }
  | { readonly type: "memory.add"; readonly content: string }
  | { readonly type: "memory.delete"; readonly memoryId: number }
  | { readonly type: "file.read"; readonly path: string }
  | { readonly type: "file.delete"; readonly path: string }
  | { readonly type: "automation.delete"; readonly automationId: string }
);

/** Server → client. */
export type ServerMessage =
  | {
      readonly type: "hello";
      readonly bot: string;
      readonly thread: ThreadId;
      readonly models: readonly ModelInfo[];
      readonly tools: readonly ToolInfo[];
    }
  /** pi's agent events for the socket's thread; a batch may start with a `snapshot`. */
  | {
      readonly type: "events";
      readonly thread: ThreadId;
      readonly events: readonly AgentEvent[];
    }
  | ({ readonly type: "state" } & Partial<BotState>)
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export const ROOT_THREAD: ThreadId = "1";

export function isThreadId(value: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(value);
}

export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/** `provider/model-id` (the model id may itself contain slashes). */
export function parseModelKey(key: string): ModelRef | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
}
