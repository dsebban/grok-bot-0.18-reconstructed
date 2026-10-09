/** Shared server types. Wire shapes the renderer reads live in source/shared and frontend/. */

export type ModelRef = { readonly provider: string; readonly modelId: string };

export type ModelInfo = ModelRef & {
  readonly name: string;
  /** Provider display name, for grouping. */
  readonly group: string;
};

/** A pi conversation id as a string; it is also the renderer's agent id. */
export type AgentId = string;

export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/** `provider/model-id` (the model id may itself contain slashes). */
export function parseModelKey(key: string): ModelRef | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
}

/** A browser tab's id, as the web bridge sends it. */
export const VIEWER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value);
}

/** The Settings → Router choices of the desktop renderer. */
export type RouterProviderId = "cursor" | "claude-code" | "codex" | "openrouter";

export function isRouterProviderId(value: unknown): value is RouterProviderId {
  return value === "cursor" || value === "claude-code" || value === "codex" || value === "openrouter";
}
