import { describe, expect, it } from "vitest";
import { createRouter } from "../src/server/models";

const fakeAI = { run: async () => ({}), gateway: () => ({ run: async () => new Response() }) } as unknown as Ai;

describe("model router", () => {
  it("offers Workers AI and AI Gateway models when the AI binding is present", () => {
    const router = createRouter({ AI: fakeAI } as Env);
    const keys = router.catalog.map((m) => `${m.provider}/${m.modelId}`);
    expect(keys).toContain("cloudflare/@cf/moonshotai/kimi-k2.7-code");
    expect(keys).toContain("demo/grokbot-demo");
    expect(router.defaultModel).toEqual({ provider: "cloudflare", modelId: "@cf/moonshotai/kimi-k2.7-code" });
  });

  it("adds keyed providers only when their secret is set, and honours DEFAULT_MODEL", () => {
    const router = createRouter({
      AI: fakeAI,
      OPENROUTER_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      DEFAULT_MODEL: "anthropic/claude-sonnet-5-5"
    } as Env);
    const providers = new Set(router.catalog.map((m) => m.provider));
    expect([...providers].sort()).toEqual(["anthropic", "cloudflare", "demo", "openrouter"]);
    expect(router.defaultModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
  });

  it("falls back to the demo model with no providers configured", () => {
    const router = createRouter({ DEFAULT_MODEL: "openai/gpt-5.5" } as Env);
    expect(router.defaultModel).toEqual({ provider: "demo", modelId: "grokbot-demo" });
  });
});
