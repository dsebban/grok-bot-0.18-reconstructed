import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A plain-text tool result. */
export function text(value: string, isError = false): ToolExecutionResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

export function errorText(error: unknown): ToolExecutionResult {
  return text(error instanceof Error ? error.message : String(error), true);
}

/** Called after a tool changes bot-wide state, so sockets can be told. */
export type OnChange = (what: "memory" | "files" | "automations") => void;
