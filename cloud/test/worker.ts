import { GrokBot, type BotOptions } from "../src/server/bot";

export { default } from "../src/server/index";

/** Pages the stubbed `web_fetch` can reach. */
const PAGES: Record<string, string> = {
  "https://example.test/": `<!doctype html><html><head><title>Example Test Page</title><script>alert(1)</script></head>
<body><h1>Hello &amp; welcome</h1><p>Durable Objects are <b>neat</b>.</p></body></html>`
};

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const page = PAGES[url];
  if (page === undefined) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** GrokBot with a stubbed network and a fast demo model. */
export class TestGrokBot extends GrokBot {
  protected override botOptions(): BotOptions {
    return { fetcher: stubFetch as typeof fetch, demoTokensPerSecond: 2_000 };
  }

  async busy(id: string): Promise<boolean> {
    return this.harness.session(id).busy();
  }

  async rawAnswers(id: string) {
    const entries = await this.harness.session(id).messages();
    return entries.flatMap((entry) => {
      const message = entry.model?.[0] as { role?: string; stopReason?: string } | undefined;
      return message?.role === "assistant" ? [message.stopReason] : [];
    });
  }
}
