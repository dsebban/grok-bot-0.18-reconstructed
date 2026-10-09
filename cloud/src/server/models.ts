import type { Provider } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createAI } from "agents/models/pi-ai";
import { parseModelKey, type ModelInfo, type ModelRef, type RouterProviderId } from "./types";
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
  /** The model behind a Settings → Router choice, falling back to the default. */
  forProvider(provider: RouterProviderId): ModelRef;
  /** Whether a Router choice has a real route (key or gateway) rather than the fallback. */
  isReady(provider: RouterProviderId): boolean;
  /** The demo provider's handle, for tests that tune its speed. */
  readonly demo: ReturnType<typeof createDemoProvider>;
};

/** Keys a bot can hold itself (pasted in Settings → Router), checked before Worker secrets. */
export const BOT_SECRET_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

const KEYED: Record<string, (typeof BOT_SECRET_KEYS)[number]> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY"
};

export function createRouter(
  env: Env,
  options: { demoTokensPerSecond?: number; secret?: (name: string) => string | null | undefined } = {}
): Router {
  const envLookup = env as unknown as Record<string, unknown>;
  const lookup = new Proxy(envLookup, {
    get: (target, name: string) => options.secret?.(name) || target[name]
  });
  const hasKey = (provider: string) => {
    const name = KEYED[provider];
    return name === undefined || Boolean(lookup[name]);
  };
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
  // Keyed providers are always registered, so a key pasted later works at
  // once; routing only picks them while a key is present.
  providers.push(openrouterProvider(), anthropicProvider(), openaiProvider());
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
    ref !== undefined && hasKey(ref.provider) && models.getModel(ref.provider, ref.modelId) !== undefined;
  const defaultModel = available(wanted)
    ? wanted!
    : available(FALLBACK_MODEL)
      ? FALLBACK_MODEL
      : { provider: DEMO_PROVIDER, modelId: DEMO_MODEL };

  // Settings → Router, as on the desktop app: "cursor" is the deployment's
  // default model; the others prefer a direct key and fall back to the same
  // vendor through AI Gateway, then to the default.
  const ROUTES: Record<RouterProviderId, readonly ModelRef[]> = {
    cursor: [defaultModel],
    "claude-code": [
      { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      { provider: "cloudflare", modelId: "anthropic/claude-sonnet-5.5" }
    ],
    codex: [
      { provider: "openai", modelId: "gpt-5.5" },
      { provider: "cloudflare", modelId: "openai/gpt-5.5" }
    ],
    openrouter: [
      { provider: "openrouter", modelId: "x-ai/grok-4.3" },
      { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }
    ]
  };
  const forProvider = (provider: RouterProviderId): ModelRef =>
    ROUTES[provider].find((ref) => available(ref)) ?? defaultModel;

  const isReady = (provider: RouterProviderId): boolean => ROUTES[provider].some((ref) => available(ref));

  return { models, catalog: catalog.filter((model) => hasKey(model.provider)), defaultModel, demo, forProvider, isReady };
}
