# GrokBot Cloud — plan

A from-scratch rebuild of Grok Bot as a Cloudflare Worker. Each bot runs
inside a Durable Object, and **pi-durable** runs the agent loop.

## Sources studied

| Source | What we take from it |
| --- | --- |
| `dsebban/pi` → `packages/durable` (`@earendil-works/pi-durable` 1.1) | The durable agent harness. It handles the transcript, inbox (steer and follow-up), generation and tool tasks, retries, and crash recovery. |
| `cloudflare/agents` → `packages/agents/src/harness/pi` (`agents/harness/pi`) | `PiHarness`: hosts pi on the Durable Object's SQLite and wakes it with Lifecycle jobs after eviction. |
| `cloudflare/agents` → `examples/next/harnesses/pi` | The reference "pi durable example": socket glue, the event reducer, and the wrangler config. |
| this repo (`source/`, Grok Bot 0.18) | Product shape: threads, a provider router, tools/plugins, automations, memory, and usage display. |

None of the example's code is copied. We depend on the published npm packages
(`agents`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`) and write the
app ourselves.

## Architecture

```
browser (React SPA, Vite)
   │  WebSocket /agents/grok-bot/<bot>?thread=<id>     HTTP /api/*
   ▼
Worker (src/server/index.ts) ── routeAgentRequest ──► GrokBot Durable Object (one per bot)
                                                        │
                                                        ├─ Lifecycle (single alarm, job queue)
                                                        ├─ PiHarness  ─► pi-durable Harness (pi_* tables)
                                                        │                 └─ registry: "grokbot" extension
                                                        │                     sections: persona, memory, clock
                                                        │                     tools: memory_*, files_*, web_fetch,
                                                        │                            schedule_*, current_time
                                                        ├─ Automations capability (Lifecycle jobs → harness.submit)
                                                        ├─ Store (gb_* tables: threads, memory, files, automations)
                                                        └─ WebSockets capability + BotSockets glue
```

* **One Durable Object per bot.** Each thread is a pi session (conversation)
  inside it. Memory, files, and automations are shared across the bot's threads,
  the same way Grok Bot's per-user state works.
* **Model router** (`models.ts`). It registers several pi-ai providers on one
  `Models` registry:
  * `cloudflare` (Workers AI and AI Gateway, through the `AI` binding). This is
    the production default.
  * `openrouter`, `anthropic`, `openai`, each registered only when its key is
    set as a secret.
  * `demo`, a deterministic offline model (pi-ai `fauxProvider` driven by a
    script). It calls the real tools, so the whole app can be exercised without
    credentials. Tests and local verification use it.
  Each thread stores its model, and the UI picker calls `session.setModel`.
* **Tools** (written from scratch as pi-durable `ToolRegistration`s, with
  explicit `replay` safety):
  * `memory_save` / `memory_search` / `memory_forget`. These are long-term facts.
    Saved facts are also rendered into a `memory` system-prompt section.
  * `files_write` / `files_read` / `files_list` / `files_delete` /
    `files_edit`, a durable workspace in SQLite.
  * `web_fetch`, which turns a URL's HTML into text, truncated.
  * `schedule_prompt` / `list_schedules` / `cancel_schedule`. Automations are
    stored rows plus Lifecycle jobs. When one fires, it submits a prompt to its
    thread with an idempotent `operationId` and reschedules itself if it
    recurs.
  * `current_time`.
* **Wire protocol** (`shared/protocol.ts`). Each socket follows one thread, so
  pi's `AgentEvent`s stream as-is. Bot-level updates (the thread list, memory,
  files, automations) are broadcast to every socket. Commands are `send`
  (follow-up or steer), `abort`, `reset`, `fork`, `rename`, `archive`,
  `setModel`, plus the list and delete commands for memory, files, and
  automations.
* **UI reducer** (`shared/view.ts`). It is pure, so the browser and the tests
  run the same code.
* **Hibernation and eviction.** Watches live in memory, so `onStart` re-watches
  every socket that is still open. PiHarness's wake job resumes interrupted
  runs.

## Verification plan

1. `tsc --noEmit` for the server, shared code, and client.
2. Vitest with `@cloudflare/vitest-pool-workers`, against a real Durable Object
   in workerd:
   * a demo-model prompt round-trip;
   * each tool family, through the model loop (memory, then the memory
     section in the prompt; files; web_fetch against a stubbed fetch;
     automations firing and recurring);
   * the thread list, titles, fork, archive, and model switching;
   * WebSocket protocol: snapshot, streamed events, follow-up while busy;
   * crash mid-run (`abortAllDurableObjects`), with the alarm wake recovering
     the run.
3. End to end: `vite build` → `wrangler dev` (local workerd) → Playwright in
   headless Chromium, driving the real UI (create a thread, chat, tool cards,
   memory panel, reload mid-run, switch threads).
4. `wrangler deploy --dry-run` to prove the bundle is deployable.

Deploying to a real account needs `CLOUDFLARE_API_TOKEN`, which is not
available in this environment. See the README for the one-command deploy.
