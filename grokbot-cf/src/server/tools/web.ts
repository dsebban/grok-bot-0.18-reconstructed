import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { errorText, text } from "./util";

const Fetch = Type.Object({
  url: Type.String({ description: "http(s) URL to fetch." }),
  maxChars: Type.Optional(
    Type.Number({ description: "Most characters of text to return; default 12000." })
  )
});
const Now = Type.Object({
  timeZone: Type.Optional(
    Type.String({ description: "IANA time zone, e.g. Europe/Paris. Default UTC." })
  )
});

const DEFAULT_CHARS = 12_000;
const MAX_CHARS = 50_000;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

/** HTML to readable text: drop scripts and styles, keep block structure. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|h[1-6]|tr|ul|ol|table|header|footer|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const point =
          code[1] === "x" || code[1] === "X"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(point) ? String.fromCodePoint(point) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

export function webTools(fetcher: typeof fetch = fetch): ToolRegistration[] {
  const webFetch: ToolRegistration<typeof Fetch> = {
    name: "web_fetch",
    description:
      "Fetch a web page or text/JSON URL and return its readable text. Use it to read links the user shares or to look things up.",
    parameters: Fetch,
    // A GET has no effect we would repeat.
    replay: "safe",
    async execute({ url, maxChars }, _api, context) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return text(`Not a valid URL: ${url}`, true);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return text("Only http and https URLs can be fetched.", true);
      }
      const limit = Math.min(Math.max(500, maxChars ?? DEFAULT_CHARS), MAX_CHARS);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = context.abortSignal
        ? AbortSignal.any([timeout, context.abortSignal])
        : timeout;
      try {
        const response = await fetcher(parsed.toString(), {
          signal,
          redirect: "follow",
          headers: {
            "user-agent": "GrokBotCloud/0.1 (+https://developers.cloudflare.com/agents/)",
            accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5"
          }
        });
        const type = response.headers.get("content-type") ?? "";
        const raw = (await response.text()).slice(0, MAX_BYTES);
        const page = /html|xml/i.test(type) || /^\s*</.test(raw)
          ? htmlToText(raw)
          : { title: "", text: raw };
        const clipped =
          page.text.length > limit
            ? `${page.text.slice(0, limit)}\n\n[truncated ${page.text.length - limit} characters]`
            : page.text;
        const header = [
          `URL: ${response.url || parsed.toString()}`,
          `Status: ${response.status}`,
          ...(page.title ? [`Title: ${page.title}`] : [])
        ].join("\n");
        return text(`${header}\n\n${clipped}`, !response.ok);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const now: ToolRegistration<typeof Now> = {
    name: "current_time",
    description: "The current date and time, optionally in a time zone.",
    parameters: Now,
    replay: "safe",
    async execute({ timeZone }) {
      const date = new Date();
      try {
        const local = date.toLocaleString("en-US", {
          timeZone: timeZone ?? "UTC",
          dateStyle: "full",
          timeStyle: "long"
        });
        return text(`${local} (ISO ${date.toISOString()})`);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  return [webFetch, now];
}
