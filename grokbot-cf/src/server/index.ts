import { routeAgentRequest } from "agents";
import { isThreadId, ROOT_THREAD } from "../shared/protocol";
import { createRouter } from "./models";

export { GrokBot } from "./bot";

const BOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** With `GROKBOT_TOKEN` set, every API call and socket must present it. */
function authorized(request: Request, env: Env): boolean {
  if (!env.GROKBOT_TOKEN) return true;
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer ?? url.searchParams.get("token");
  return token === env.GROKBOT_TOKEN;
}

/**
 * The REST API, for scripts and integrations (the UI uses the socket):
 *
 *   POST /api/bots/:bot/threads/:thread/messages  { text, wait?, operationId? }
 *   GET  /api/bots/:bot/threads/:thread/messages
 *   GET  /api/bots/:bot/threads
 */
async function api(request: Request, env: Env, path: string[]): Promise<Response> {
  if (path[0] === "health") return json({ ok: true, name: "grokbot" });
  if (path[0] === "config") {
    const router = createRouter(env);
    return json({
      models: router.catalog,
      defaultModel: router.defaultModel,
      auth: Boolean(env.GROKBOT_TOKEN)
    });
  }
  if (path[0] !== "bots" || !path[1] || !BOT_NAME.test(path[1])) {
    return json({ error: "Not found" }, 404);
  }
  const bot = env.GrokBot.getByName(path[1]);
  if (path[2] === "threads" && path.length === 3 && request.method === "GET") {
    return json({ threads: await bot.threads() });
  }
  if (path[2] === "threads" && path[4] === "messages" && path.length === 5) {
    const thread = path[3] === "root" ? ROOT_THREAD : path[3];
    if (!isThreadId(thread)) return json({ error: "Invalid thread" }, 400);
    if (request.method === "GET") return json(await bot.messages(thread));
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = (await request.json().catch(() => null)) as {
      text?: unknown;
      wait?: unknown;
      operationId?: unknown;
    } | null;
    if (typeof body?.text !== "string" || body.text.trim() === "") {
      return json({ error: "Body must be { text: string }" }, 400);
    }
    if (body.wait === true) return json(await bot.prompt(thread, body.text));
    return json(
      await bot.submit(thread, body.text, {
        ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {})
      }),
      202
    );
  }
  return json({ error: "Not found" }, 404);
}

/**
 * Origins allowed to call the Worker from a browser, for a UI hosted
 * elsewhere (Vercel). `ALLOWED_ORIGINS` is a comma-separated list; unset
 * means any origin, which is safe for reads because auth is a bearer token,
 * never a cookie.
 */
function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (allowed.length === 0) return origin ?? "*";
  if (origin === null) return null;
  const self = new URL(request.url).origin;
  return origin === self || allowed.includes(origin) ? origin : null;
}

function withCors(response: Response, origin: string | null): Response {
  // WebSocket upgrades and opaque responses keep their headers as they are.
  if (origin === null || response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");
  const isAgent = url.pathname.startsWith("/agents/");
  if ((isApi || isAgent) && url.pathname !== "/api/health" && url.pathname !== "/api/config") {
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  }
  try {
    if (isApi) {
      return await api(request, env, url.pathname.slice(5).split("/").filter(Boolean));
    }
    if (isAgent) {
      const name = url.pathname.split("/")[3];
      if (!name || !BOT_NAME.test(decodeURIComponent(name))) {
        return json({ error: "Invalid bot name" }, 400);
      }
      return (await routeAgentRequest(request, env)) ?? json({ error: "Not found" }, 404);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error("GrokBot request failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env);
    const crossSite = request.headers.has("origin") && origin === null;
    if (request.method === "OPTIONS") {
      if (crossSite) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin ?? "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
          vary: "origin"
        }
      });
    }
    // With an allowlist, refuse other sites' pages, sockets included.
    if (crossSite) return json({ error: "Origin not allowed" }, 403);
    return withCors(await handle(request, env), origin);
  }
} satisfies ExportedHandler<Env>;
