/** Bindings and vars of the GrokBot Worker (see wrangler.jsonc). */
interface Env {
  AI: Ai;
  GrokBot: DurableObjectNamespace<import("./src/server/bot").GrokBot>;
  DEFAULT_MODEL?: string;
  /** Optional provider keys, set with `wrangler secret put`. */
  OPENROUTER_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Optional shared secret; when set, every API and socket call must carry it. */
  GROKBOT_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
