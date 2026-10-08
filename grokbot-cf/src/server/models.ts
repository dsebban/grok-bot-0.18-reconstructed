import type { Provider } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createAI } from "agents/models/pi-ai";
import type { ModelInfo, ModelRef } from "../shared/protocol";
import { parseModelKey } from "../shared/protocol";
import { createDemoProvider, DEMO_MODEL, DEMO_PROVIDER } from "./demo-model";

/**
 * The model router: GrokBot's answer to Grok Bot's inference router. One
 * pi-ai `Models` registry holds every provider this deployment can reach,
 * and each thread stores which one it uses.
 *
 * - `cloudflare`: Workers AI over the `AI` binding, plus third-party models
 *   through AI Gateway (unified billing, so no keys in the Worker).
 * - `openrouter`, `anthropic`, `openai`: direct, only when their API key
 *   secret is set.
 * - `demo`: the offline scripted model.
 */

/** Curated picks per provider; only those the provider actually lists are offered. */
const PICKS: Record<string, readonly string[]> = {
  cloudflare: [
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/moonshotai/kimi-k2.6",
    "@cf/zai-org/glm-4.7-flash",
    "@cf/openai/gpt-oss-120b",
    "@cf/qwen/qwen3.8-27b",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5.5",
    "openai/gpt-5.5",
    "xai/grok-4.3",
    "grok/grok-4.3"
  ],
  openrouter: [
    "x-ai/grok-4.3",
    "x-ai/grok-4.1-fast",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5.5",
    "openai/gpt-5.5",
    "google/gemini-3-pro-preview",
    "moonshotai/kimi-k2.6"
  ],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  openai: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.6-sol"]
};

const GROUPS: Record<string, string> = {
  [DEMO_PROVIDER]: "Offline",
  cloudflare: "Cloudflare (Workers AI & AI Gateway)",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI"
};

export const FALLBACK_MODEL: ModelRef = {
  provider: "cloudflare",
  modelId: "@cf/moonshotai/kimi-k2.7-code"
};

export type Router = {
  readonly models: MutableModels;
  readonly catalog: readonly ModelInfo[];
  readonly defaultModel: ModelRef;
  /** The demo provider's handle, for tests that tune its speed. */
  readonly demo: ReturnType<typeof createDemoProvider>;
};

export function createRouter(
  env: Env,
  options: { demoTokensPerSecond?: number } = {}
): Router {
  const lookup = env as unknown as Record<string, unknown>;
  const models = createModels({
    // Provider keys come from Worker secrets, not process.env.
    authContext: {
      env: async (name) => {
        const value = lookup[name];
        return typeof value === "string" && value !== "" ? value : undefined;
      },
      fileExists: async () => false
    }
  });

  const demo = createDemoProvider({ tokensPerSecond: options.demoTokensPerSecond });
  const providers: Provider[] = [demo.provider];
  if (env.AI) providers.push(createAI({ binding: env.AI }).provider);
  if (env.OPENROUTER_API_KEY) providers.push(openrouterProvider());
  if (env.ANTHROPIC_API_KEY) providers.push(anthropicProvider());
  if (env.OPENAI_API_KEY) providers.push(openaiProvider());
  for (const provider of providers) models.setProvider(provider);

  const catalog: ModelInfo[] = [];
  for (const provider of providers) {
    const known = new Map(provider.getModels().map((model) => [model.id, model]));
    const picks = provider.id === DEMO_PROVIDER ? [DEMO_MODEL] : (PICKS[provider.id] ?? []);
    for (const id of picks) {
      const model = known.get(id);
      if (!model) continue;
      catalog.push({
        provider: provider.id,
        modelId: id,
        name: model.name || id,
        group: GROUPS[provider.id] ?? provider.name
      });
    }
  }

  const wanted = env.DEFAULT_MODEL ? parseModelKey(env.DEFAULT_MODEL) : undefined;
  const available = (ref: ModelRef | undefined) =>
    ref !== undefined && models.getModel(ref.provider, ref.modelId) !== undefined;
  const defaultModel = available(wanted)
    ? wanted!
    : available(FALLBACK_MODEL)
      ? FALLBACK_MODEL
      : { provider: DEMO_PROVIDER, modelId: DEMO_MODEL };

  return { models, catalog, defaultModel, demo };
}
