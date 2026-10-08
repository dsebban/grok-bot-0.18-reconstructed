/** Bindings and vars of the GrokBot Worker (see wrangler.jsonc). */
interface Env {
  AI: Ai;
  GrokBot: DurableObjectNamespace<import("./src/server/bot").GrokBot>;
  /** Model behind Settings → Router "Cursor" (the default), as provider/model-id. */
  DEFAULT_MODEL?: string;
  /** Optional direct provider keys (`wrangler secret put`). */
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Optional shared secret; when set, every API call and socket must carry it. */
  GROKBOT_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
