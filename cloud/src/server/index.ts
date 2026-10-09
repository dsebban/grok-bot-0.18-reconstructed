import { BOT_SECRET_KEYS, createRouter } from "./models";
import { isAgentId, isRouterProviderId, VIEWER_ID } from "./types";

export { GrokBot } from "./bot";

const BOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** With `GROKBOT_TOKEN` set, every API call and socket must present it. */
function authorized(request: Request, env: Env): boolean {
  if (!env.GROKBOT_TOKEN) return true;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return (bearer ?? new URL(request.url).searchParams.get("token")) === env.GROKBOT_TOKEN;
}

/**
 * GrokBot Cloud's Worker. The UI (main's renderer, built from frontend/) is
 * served as static assets; this handles:
 *
 *   GET  /api/health, /api/config         public
 *   GET  /api/auth                        200 when the token is valid
 *   POST /api/bots/:bot/settings          { routerProvider?, timeZone? }
 *   GET|POST /api/bots/:bot/router        Settings → Router state / { provider }
 *   GET|POST /api/bots/:bot/secrets       key names / { upsert?, remove? }
 *   GET|POST /api/bots/:bot/sidebar       pinned agents and sidebar sections
 *   POST /api/bots/:bot/viewing           { viewer, agentId } the chat a tab has selected
 *   GET  /api/bots/:bot/agents            the roster
 *   POST /api/bots/:bot/agents/:id/messages  { text } → waits for the answer
 *   WS   /agents/grok-bot/:bot            the coordinator socket
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, name: "grokbot" });
      // The renderer reports its boot health to its dev host; nothing to do here.
      if (url.pathname === "/__reconstructed_health") return new Response(null, { status: 204 });
      if (url.pathname === "/api/config") {
        const router = createRouter(env);
        return json({ auth: Boolean(env.GROKBOT_TOKEN), models: router.catalog, defaultModel: router.defaultModel });
      }
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/auth") return json({ ok: true });

      if (path[0] === "agents" && path[1] === "grok-bot" && path.length === 3) {
        const bot = decodeURIComponent(path[2]!);
        if (!BOT_NAME.test(bot)) return json({ error: "Invalid bot name" }, 400);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
        return env.GrokBot.getByName(bot).fetch(request);
      }

      if (path[0] === "api" && path[1] === "bots" && path[2] && BOT_NAME.test(path[2])) {
        const bot = env.GrokBot.getByName(path[2]);
        if (path[3] === "settings" && path.length === 4 && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { routerProvider?: unknown; timeZone?: unknown };
          if (body.routerProvider !== undefined && !isRouterProviderId(body.routerProvider)) {
            return json({ error: "Unknown router provider" }, 400);
          }
          return json(await bot.updateSettings(body));
        }
        if (path[3] === "router" && path.length === 4) {
          if (request.method === "GET") return json(await bot.inferenceRouter());
          const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
          if (!isRouterProviderId(body.provider)) return json({ error: "Unknown router provider" }, 400);
          return json(await bot.setInferenceRouter(body.provider));
        }
        if (path[3] === "secrets" && path.length === 4) {
          if (request.method === "GET") return json(await bot.secrets());
          const body = (await request.json().catch(() => ({}))) as { upsert?: Record<string, unknown>; remove?: unknown[] };
          const unknown = Object.keys(body.upsert ?? {}).filter((name) => !(BOT_SECRET_KEYS as readonly string[]).includes(name));
          if (unknown.length > 0) return json({ error: `Cannot store ${unknown.join(", ")}` }, 400);
          return json(await bot.secrets(body));
        }
        if (path[3] === "sidebar" && path.length === 4) {
          if (request.method === "GET") return json(await bot.sidebar());
          const text = await request.text();
          if (text.length > 64 * 1024) return json({ error: "Sidebar state is too large" }, 413);
          let body: { pinnedAgentIds?: unknown; sections?: unknown };
          try {
            body = (JSON.parse(text || "{}") ?? {}) as typeof body;
          } catch {
            return json({ error: "Body must be JSON" }, 400);
          }
          const pins = body.pinnedAgentIds;
          if (pins !== undefined && !(Array.isArray(pins) && pins.every((id) => typeof id === "string"))) {
            return json({ error: "pinnedAgentIds must be a list of agent ids" }, 400);
          }
          if (body.sections !== undefined && !Array.isArray(body.sections)) return json({ error: "sections must be a list" }, 400);
          return json(await bot.sidebar(body));
        }
        if (path[3] === "viewing" && path.length === 4 && request.method === "POST") {
          const body = (await request.json().catch(() => null)) as { viewer?: unknown; agentId?: unknown } | null;
          if (typeof body?.viewer !== "string" || !VIEWER_ID.test(body.viewer)) return json({ error: "viewer must be a tab id" }, 400);
          const agentId = body.agentId ?? null;
          if (agentId !== null && !isAgentId(agentId)) return json({ error: "agentId must be an agent id or null" }, 400);
          await bot.viewing(body.viewer, agentId);
          return json({ ok: true });
        }
        if (path[3] === "agents" && path.length === 4 && request.method === "GET") {
          return json({ agents: await bot.listAgents() });
        }
        if (path[3] === "agents" && path[5] === "messages" && path.length === 6) {
          const id = path[4]!;
          if (request.method === "GET") return json({ entries: await bot.transcript(id) });
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
          if (typeof body?.text !== "string" || !body.text.trim()) return json({ error: "Body must be { text: string }" }, 400);
          return json(await bot.prompt(id, body.text));
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("GrokBot request failed", error);
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
