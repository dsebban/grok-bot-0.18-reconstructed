# GrokBot Cloud

GrokBot Cloud rebuilds Grok Bot from scratch as a Cloudflare Worker. Every
bot is a **Durable Object**, and **[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)**
runs the agent loop inside it.

What you get:

- **Threads** you can create, fork, rename, archive and reset. Titles come
  from the first message.
- **A model router**: Workers AI, plus Anthropic/OpenAI/xAI through AI Gateway
  (no keys needed), plus optional direct OpenRouter, Anthropic and OpenAI. Each
  thread can use a different model. An offline **demo model** needs no account.
- **Tools**: long-term memory (shared across threads and injected into the
  system prompt), a durable file workspace, `web_fetch`, scheduled prompts
  (automations), and the current time.
- **Automations** that keep running with nobody connected: reminders and
  recurring checks are Lifecycle jobs on the object's alarm.
- **Durability end to end.** Transcripts, tool calls and your own state are
  committed to the object's SQLite before anything is shown. A deploy,
  eviction or crash mid-answer resumes from pi's last checkpoint.
- **Live UI**: streamed Markdown, thinking, tool cards with arguments and
  results, follow-ups queued while busy, *steer* into a running answer, stop,
  and reconnect or reload mid-answer from a snapshot.
- **REST API** for scripts and integrations.

See [PLAN.md](PLAN.md) for the design and the upstream sources it is based on.

## Architecture

```
browser ──ws /agents/grok-bot/<bot>?thread=<id>──► Worker ──► GrokBot Durable Object (one per bot)
        ──http /api/*─────────────────────────────►            ├─ PiHarness → pi-durable Harness (pi_* tables)
                                                               ├─ Automations (Lifecycle jobs + gb_automations)
                                                               ├─ Store (gb_threads, gb_memory, gb_files)
                                                               └─ WebSockets + BotSockets (JSON protocol)
```

| Path | What it is |
| --- | --- |
| `src/server/index.ts` | Worker entry: routing, optional token auth, REST API |
| `src/server/bot.ts` | `GrokBot` Durable Object: PiHarness, pi extension, commands |
| `src/server/models.ts` | Model router: one pi-ai `Models` registry for all providers |
| `src/server/demo-model.ts` | Deterministic offline model that drives the real tools |
| `src/server/automations.ts` | Scheduled prompts as durable, idempotent Lifecycle jobs |
| `src/server/tools/*` | `memory_*`, `files_*`, `web_fetch`, `current_time`, `schedule_*` |
| `src/server/sockets.ts` | One socket per thread; re-attaches after hibernation |
| `src/shared/protocol.ts` | Wire protocol shared by server and client |
| `src/shared/view.ts` | Pure reducer from pi `AgentEvent`s to the UI view (also used in tests) |
| `src/client/*` | React UI |

## Run locally

```sh
pnpm install
pnpm dev            # Vite + workerd. The AI binding is remote, so this needs `wrangler login`.
```

You can run fully offline (no Cloudflare account) on the demo model. In the
same build the e2e suite uses:

```sh
node e2e/run.mjs    # builds, starts wrangler dev without the AI binding, drives Chromium
```

Or set `"DEFAULT_MODEL": "demo/grokbot-demo"` in `wrangler.jsonc`, remove the
`ai` block, and run `pnpm dev`. In the demo model, type `help` to see what it
can do: `remember that …`, `write /notes/x.md: …`, `fetch https://…`,
`remind me in 1 minute to …`, `slow`, and more.

## Deploy

Everything runs on Cloudflare. One Worker serves the bots (Durable Objects),
the API, and the UI as static assets, all on the same origin.

### With GitHub Actions

[`.github/workflows/deploy-grokbot.yml`](../.github/workflows/deploy-grokbot.yml)
runs on every push to `main` that touches `grokbot-cf/`. You can also run it
by hand from **Actions → Deploy GrokBot**. It has two jobs:

1. **verify**: typecheck, the workerd tests, and the browser e2e suite.
2. **deploy-cloudflare**: `wrangler deploy`, with secrets uploaded in the
   same version. A smoke test then checks `/api/health` and the UI.

In **Settings → Environments → `cloudflare-production`**, set:

| Kind | Name | |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Required. Create it from the **Edit Cloudflare Workers** template. |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Required. |
| Secret | `GROKBOT_TOKEN` | Recommended. The access token the UI, API and sockets require. |
| Secret | `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Optional. Enable direct providers. |
| Variable | `GROKBOT_DEFAULT_MODEL` | Optional. Model for new threads. |
| Variable | `GROKBOT_URL` | Optional. The public URL, if you use a custom domain instead of workers.dev. |

### By hand

```sh
pnpm install
npx wrangler login
pnpm run deploy
npx wrangler secret put GROKBOT_TOKEN
```

Settings:

| Name | Purpose |
| --- | --- |
| `DEFAULT_MODEL` (var) | Model for new threads, `provider/model-id`. Default `cloudflare/@cf/moonshotai/kimi-k2.7-code`. |
| `GROKBOT_TOKEN` (secret) | Require this token on every API call and socket. The UI asks for it once. |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (secrets) | Enable those providers directly. |

**Set `GROKBOT_TOKEN` on any public deployment.** Without it, anyone with the
URL can use your bot and your Workers AI quota.

## REST API

```sh
# Send a message and wait for the answer
curl -X POST https://<host>/api/bots/default/threads/root/messages \
  -H 'authorization: Bearer $GROKBOT_TOKEN' -H 'content-type: application/json' \
  -d '{"text":"What is on my todo list?","wait":true}'

# Read a thread / list threads
curl https://<host>/api/bots/default/threads/1/messages -H 'authorization: Bearer …'
curl https://<host>/api/bots/default/threads -H 'authorization: Bearer …'
```

Without `wait`, the POST returns `202` with an `operationId` as soon as the
message is durable. Passing your own `operationId` makes retries idempotent.

## Tests

```sh
pnpm typecheck
pnpm test           # 19 tests in workerd against real Durable Objects
pnpm e2e            # 14 browser steps against `wrangler dev`
```

The suites cover:

- REST and auth edge cases;
- each tool through the model loop;
- memory reaching the model via the system prompt;
- automations firing via the alarm, and recurring rescheduling;
- threads, forks and model switching;
- the socket protocol: streaming, joining mid-run, follow-ups queued while busy;
- crash recovery. The object is aborted mid-answer and the alarm resumes it.
  In e2e, `wrangler dev` itself is `SIGKILL`ed mid-answer and restarted.

## Notes and limits

- pi-durable and `agents/harness/pi` are beta. Pinned versions:
  `agents@0.27.0` and `@earendil-works/pi-durable@1.1.0`.
- After a crash mid-answer, the cut-off partial answer stays in the
  transcript, marked *interrupted*, followed by the regenerated answer.
- pi has no conversation delete yet, so threads are archived instead.
- One Durable Object holds all of a bot's threads. Use separate bot names
  (`#/<bot>/…`, or the switcher under the logo) for separate people or
  workspaces.
