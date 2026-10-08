import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GrokBot, type BotOptions } from "../src/server/bot";
import type { ThreadId } from "../src/shared/protocol";
import { messageText, reduceAll, EMPTY_VIEW } from "../src/shared/view";

export { default } from "../src/server/index";

/** Pages the stubbed `web_fetch` can reach. */
export const PAGES: Record<string, string> = {
  "https://example.test/": `<!doctype html><html><head><title>Example Test Page</title><style>p{}</style><script>alert(1)</script></head>
<body><h1>Hello &amp; welcome</h1><p>Durable Objects are <b>neat</b>.</p><ul><li>one</li><li>two</li></ul></body></html>`
};

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const page = PAGES[url];
  if (page === undefined) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** GrokBot with a stubbed network and a faster demo model. */
export class TestGrokBot extends GrokBot {
  protected override botOptions(): BotOptions {
    return { fetcher: stubFetch as typeof fetch, demoTokensPerSecond: 2_000 };
  }

  /** The thread's transcript as role-tagged text lines. */
  async transcript(thread: ThreadId = "1"): Promise<string[]> {
    const stream = await this.harness.session(thread).events(BACKGROUND_CONTEXT);
    await stream.stop();
    const view = reduceAll(EMPTY_VIEW, [stream.snapshot]);
    return view.messages.map((message) => `${message.role}: ${messageText(message)}`);
  }

  async toolResults(thread: ThreadId = "1"): Promise<Array<{ name: string; text: string; error: boolean }>> {
    const stream = await this.harness.session(thread).events(BACKGROUND_CONTEXT);
    await stream.stop();
    return Object.values(reduceAll(EMPTY_VIEW, [stream.snapshot]).results);
  }

  async entries(thread: ThreadId = "1") {
    const entries = await this.harness.session(thread).messages();
    return entries.map((entry) => {
      const message = entry.model?.[0] as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
      return { id: entry.id, kind: entry.kind, role: message?.role, stop: message?.stopReason, err: message?.errorMessage, len: JSON.stringify(message?.content ?? "").length };
    });
  }

  async busy(thread: ThreadId = "1"): Promise<boolean> {
    return this.harness.session(thread).busy();
  }
}
