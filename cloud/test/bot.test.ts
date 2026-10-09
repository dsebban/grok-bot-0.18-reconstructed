import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { projectTranscriptEntry } from "../../frontend/src/production/model";
import { projectRendererAgents } from "../../frontend/src/production/model";
import type { GrokEntry } from "../src/server/transcript";
import type { TestGrokBot } from "./worker";

/**
 * The coordinator is tested the way the renderer uses it: the desktop frame
 * protocol over a WebSocket, against a real Durable Object in workerd, with
 * replies fed through the renderer's own projections from frontend/.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("Condition never held");
    await sleep(25);
  }
}

/** The bot's RPC surface the tests use (Workers RPC types widen `unknown` to `never`). */
type BotApi = {
  createAgent(name?: string, description?: string): Promise<{ id: string; name: string }>;
  prompt(id: string, prompt: string): Promise<{ status: string; text?: string; reason?: string }>;
  sendPrompt(id: string, prompt: string): Promise<{ operationId: string }>;
  transcript(id: string): Promise<GrokEntry[]>;
  busy(id: string): Promise<boolean>;
  rawAnswers(id: string): Promise<Array<string | undefined>>;
};

function stub(name: string): BotApi {
  return env.GrokBot.getByName(name) as unknown as BotApi;
}

function raw(name: string): DurableObjectStub {
  return env.GrokBot.getByName(name) as unknown as DurableObjectStub;
}

type Frame = { kind: string; [key: string]: unknown };

/** A renderer-side coordinator client: hello/ready, request/reply, events. */
async function connect(bot: string, viewer?: string) {
  const query = viewer ? `?viewer=${viewer}` : "";
  const response = await SELF.fetch(`https://bot.test/agents/grok-bot/${bot}${query}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Frame[] = [];
  const events: { family: string; payload: Record<string, unknown> }[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    frames.push(frame);
    if (frame.kind === "event") events.push({ family: frame.family as string, payload: frame.payload as Record<string, unknown> });
  });
  socket.send(JSON.stringify({ kind: "lifecycle", phase: "hello", protocolVersion: 1 }));
  await eventually(() => frames.some((frame) => frame.kind === "lifecycle" && frame.phase === "ready"));
  let next = 0;
  const call = async <T = unknown>(method: string, args: unknown = {}): Promise<T> => {
    const requestId = `r-${++next}`;
    socket.send(JSON.stringify({ kind: "request", requestId, method, args }));
    const reply = await eventually(() => frames.find((frame) => frame.kind === "reply" && frame.requestId === requestId));
    const outcome = reply.outcome as { status: string; value?: unknown; failure?: { code: string; message: string } };
    if (outcome.status !== "ok") throw Object.assign(new Error(outcome.failure!.message), { code: outcome.failure!.code });
    return outcome.value as T;
  };
  /** The renderer's view of an agent's transcript: page, then appended/updated events. */
  const transcript = (agentId: string, initial: readonly GrokEntry[]) => {
    const byId = new Map(initial.map((entry) => [entry.id, entry as Record<string, unknown>]));
    const order = initial.map((entry) => entry.id);
    let seen = 0;
    return () => {
      for (; seen < events.length; seen++) {
        const { family, payload } = events[seen]!;
        if (family !== "transcript" || (payload.agentId ?? payload.activeAgentId) !== agentId) continue;
        if (payload.type === "snapshot") {
          byId.clear();
          order.length = 0;
          for (const entry of payload.entries as Record<string, unknown>[]) {
            byId.set(entry.id as string, entry);
            order.push(entry.id as string);
          }
          continue;
        }
        const entry = payload.entry as Record<string, unknown>;
        if (!byId.has(entry.id as string)) order.push(entry.id as string);
        byId.set(entry.id as string, entry);
      }
      return order.map((id) => byId.get(id)!);
    };
  };
  return { socket, frames, events, call, transcript };
}

function text(entry: Record<string, unknown>): string {
  const projected = projectTranscriptEntry(entry, 0, "Grok Bot", "x") as { text?: string } | null;
  if (projected?.text !== undefined) return projected.text;
  const message = entry.message as { content?: string } | undefined;
  return message?.content ?? (entry.content as string) ?? "";
}

describe("coordinator protocol", () => {
  it("handshakes, onboards a first agent, and answers the renderer's startup calls", async () => {
    const client = await connect(crypto.randomUUID());
    const agents = projectRendererAgents(await client.call("listAgents"));
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "Grok Bot", isGroup: false });
    expect(await client.call("countAgents")).toBe(1);
    expect(await client.call("getTrays")).toEqual([]);
    expect(await client.call("getListenerIntegrations")).toEqual({ integrations: [] });
    expect(await client.call("getSharingState")).toMatchObject({ isEnabled: false, rooms: [] });
    expect(await client.call("getTeachRecordingStatus")).toMatchObject({ state: "idle" });
    expect(await client.call("getForeverBoxStatus", { id: "forever-box" })).toBeNull();
    await expect(client.call("noSuchMethod")).rejects.toMatchObject({ code: "unknown-method" });
    client.socket.close();
  });

  it("rejects a protocol version it does not speak", async () => {
    const response = await SELF.fetch(`https://bot.test/agents/grok-bot/${crypto.randomUUID()}`, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket!;
    socket.accept();
    const frames: Frame[] = [];
    socket.addEventListener("message", (event) => frames.push(JSON.parse(event.data as string)));
    socket.send(JSON.stringify({ kind: "lifecycle", phase: "hello", protocolVersion: 99 }));
    const shutdown = await eventually(() => frames.find((frame) => frame.kind === "lifecycle" && frame.phase === "shutdown"));
    expect(shutdown).toMatchObject({ reason: "protocol-error" });
  });

  it("streams a prompt as Grok Bot entries the renderer projects, echoing its clientNonce", async () => {
    const client = await connect(crypto.randomUUID());
    const { agent } = await client.call<{ agent: { id: string; name: string } }>("createAgent", { name: "New chat", description: "" });
    const page = await client.call<{ entries: GrokEntry[] }>("openAgentTail", { id: agent.id, limit: 200 });
    expect(page.entries).toEqual([]);
    const view = client.transcript(agent.id, page.entries);

    await client.call("sendPrompt", { agentId: agent.id, prompt: "slow", clientNonce: "nonce-1" });
    // The answer streams: an appended send-message marked streaming, updated in place.
    await eventually(() => view().some((entry) => entry.kind === "send-message" && entry.streaming === true));
    const done = await eventually(() => {
      const entries = view();
      const answer = entries.find((entry) => entry.kind === "send-message");
      return answer && answer.streaming !== true && entries;
    });
    expect(done.map((entry) => entry.kind)).toEqual(["message", "send-message"]);
    expect(done[0]).toMatchObject({ role: "user", content: "slow", clientNonce: "nonce-1" });
    // Transcript events are ordered per agent, in sequence.
    const sequences = client.events
      .filter((event) => event.family === "transcript" && event.payload.agentId === agent.id)
      .map((event) => (event.payload.ordered as { replicaKey: string; sequence: number }));
    expect(sequences.every((stamp) => stamp.replicaKey === `transcript:${agent.id}`)).toBe(true);
    expect(sequences.map((stamp) => stamp.sequence)).toEqual(sequences.map((_, index) => index + 1));
    expect(text(done[1]!)).toContain("Durable Objects give each conversation");
    // The renderer sees the same thing on a fresh page.
    const again = await client.call<{ entries: GrokEntry[] }>("getAgentTranscriptTail", { id: agent.id, limit: 200 });
    expect(again.entries.map((entry) => entry.id)).toEqual(done.map((entry) => entry.id));
    // The chat was titled from its first message, and the sidebar preview updated.
    const roster = projectRendererAgents(await client.call("listAgents"));
    const row = roster.find((item) => item.id === agent.id)!;
    expect(row.name).toBe("slow");
    expect(row.lastMessage).toContain("Durable Objects give each conversation");
    client.socket.close();
  });

  it("pages transcripts with nextBeforeSeq", async () => {
    const name = crypto.randomUUID();
    const bot = stub(name);
    const agent = await bot.createAgent("Paging");
    for (const prompt of ["one", "two", "three"]) await bot.prompt(agent.id, prompt);
    const client = await connect(name);
    const tail = await client.call<{ entries: GrokEntry[]; nextBeforeSeq?: number }>("getAgentTranscriptTail", { id: agent.id, limit: 2 });
    expect(tail.entries).toHaveLength(2);
    expect(tail.nextBeforeSeq).toBe(4);
    const earlier = await client.call<{ entries: GrokEntry[]; nextBeforeSeq?: number }>("getAgentTranscriptTail", {
      id: agent.id,
      limit: 10,
      beforeSeq: tail.nextBeforeSeq
    });
    expect(earlier.entries.map((entry) => text(entry as Record<string, unknown>))).toEqual(["one", expect.stringContaining("one"), "two", expect.stringContaining("two")]);
    expect(earlier.nextBeforeSeq).toBeUndefined();
    client.socket.close();
  });

  it("renames, hides, marks unread, duplicates and deletes agents", async () => {
    const client = await connect(crypto.randomUUID());
    const { agent } = await client.call<{ agent: { id: string } }>("createAgent", { name: "New chat" });
    await client.call("updateAgent", { id: agent.id, profile: { name: "Research", description: "Looks things up" } });
    await client.call("setAgentUnread", { id: agent.id, isUnread: true });
    await client.call("setAgentHiddenFromSidebar", { id: agent.id, isHidden: true });
    let row = projectRendererAgents(await client.call("listAgents")).find((item) => item.id === agent.id)!;
    expect(row).toMatchObject({ name: "Research", description: "Looks things up", hasUnread: true, isHidden: true });
    // Roster events carry the desktop host's ordering envelope.
    const upsert = client.events.find((event) => event.family === "agent-upserted" && (event.payload.agent as { name?: string }).name === "Research");
    expect(upsert?.payload).toMatchObject({ ordered: { replicaKey: "roster", sequence: expect.any(Number) }, agent: { snapshotEpoch: expect.any(String) } });

    const { agent: copy } = await client.call<{ agent: { id: string; name: string } }>("duplicateAgent", { id: agent.id });
    expect(copy.name).toBe("Research (copy)");
    await client.call("deleteAgents", { ids: [agent.id] });
    const ids = projectRendererAgents(await client.call("listAgents")).map((item) => item.id);
    expect(ids).toContain(copy.id);
    expect(ids).not.toContain(agent.id);
    const roster = client.events.filter((event) => event.family === "agents").at(-1)!.payload;
    expect(roster).toMatchObject({ coverage: { kind: "complete-roster" }, ordered: { replicaKey: "roster" } });
    row = projectRendererAgents(roster.agents)[0]!;
    expect(row).toBeDefined();
    client.socket.close();
  });

  it("answers the renderer's acceptance lookups so prompts lost in a reconnect are resent", async () => {
    const client = await connect(crypto.randomUUID());
    const { agent } = await client.call<{ agent: { id: string } }>("createAgent", { name: "New chat" });
    // A prompt that never reached the bot: the renderer resends it.
    expect(await client.call("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "lost" })).toEqual({ outcome: "not-found" });
    await client.call("sendPrompt", { agentId: agent.id, prompt: "hello", clientNonce: "kept" });
    expect(await client.call("promptAcceptanceStatus", { accountSlot: "host", clientNonce: "kept" })).toMatchObject({
      outcome: "found",
      record: { clientNonce: "kept", status: "accepted", agentId: agent.id }
    });
    // A resend with the same nonce is the same pi submission, not a second turn.
    await client.call("sendPrompt", { agentId: agent.id, prompt: "hello", clientNonce: "kept" });
    const entries = await eventually(async () => {
      const page = await client.call<{ entries: GrokEntry[] }>("getAgentTranscriptTail", { id: agent.id, limit: 50 });
      return page.entries.some((entry) => entry.kind === "send-message") && page.entries;
    });
    expect(entries.filter((entry) => entry.kind === "message")).toHaveLength(1);
    client.socket.close();
  });

  it("marks a chat read when the renderer opens it, and keeps pins in the bot", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    const { agent } = await client.call<{ agent: { id: string } }>("createAgent", { name: "Inbox" });
    await client.call("setAgentUnread", { id: agent.id, isUnread: true });
    await client.call("openAgentTail", { id: agent.id, limit: 50 });
    const row = projectRendererAgents(await client.call("listAgents")).find((item) => item.id === agent.id)!;
    expect(row.hasUnread).toBeFalsy();
    client.socket.close();

    const sidebar = (body?: unknown) =>
      SELF.fetch(`https://bot.test/api/bots/${name}/sidebar`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }).then((response) => response.json());
    // Nothing stored is an empty sidebar (the renderer reads null as "sections unavailable").
    expect(await sidebar()).toEqual({ pinnedAgentIds: [], sections: [] });
    expect(await sidebar({ pinnedAgentIds: [agent.id] })).toEqual({ pinnedAgentIds: [agent.id], sections: [] });
    expect(await sidebar()).toMatchObject({ pinnedAgentIds: [agent.id] });
    const bad = await SELF.fetch(`https://bot.test/api/bots/${name}/sidebar`, { method: "POST", body: JSON.stringify({ pinnedAgentIds: [1] }) });
    expect(bad.status).toBe(400);
  });
});

/** tab-1's socket, and helpers to run a routine and read an agent's unread flag. */
async function reconnectScaffold(name: string, viewer = "tab-1") {
  const client = await connect(name, viewer);
  const runRoutine = async (agentId: string, prompt: string) => {
    const [routine] = await client.call<Array<{ id: string }>>("createAgentAutomation", {
      id: agentId,
      spec: { name: prompt, prompt, trigger: { type: "cron", schedule: "0 9 * * 1-5" }, isEnabled: true }
    });
    await client.call("runAgentAutomationNow", { id: agentId, automationId: routine!.id });
    await eventually(async () => {
      const rows = await client.call<Array<{ id: string; runs: unknown[] }>>("getAgentAutomations", { id: agentId });
      return rows.find((row) => row.id === routine!.id)?.runs.length;
    });
  };
  const unread = async (agentId: string) =>
    projectRendererAgents(await client.call("listAgents")).find((item) => item.id === agentId)!.hasUnread === true;
  return { client, runRoutine, unread };
}

/** Past TestGrokBot's reconnect grace (1 s). */
const GRACE_PASSED = 1_100;

describe("unread tracking follows the chat each tab has selected", () => {
  let seq = 0;
  const viewing = (bot: string, viewer: string, agentId: string | null, at = ++seq) =>
    SELF.fetch(`https://bot.test/api/bots/${bot}/viewing`, { method: "POST", body: JSON.stringify({ viewer, agentId, seq: at }) });
  const scaffold = async (name: string) => {
    const tab = await reconnectScaffold(name);
    const { agent: a } = await tab.client.call<{ agent: { id: string } }>("createAgent", { name: "A" });
    const { agent: b } = await tab.client.call<{ agent: { id: string } }>("createAgent", { name: "B" });
    return { ...tab, a, b };
  };

  it("ignores a delayed report that is older than the tab's latest", async () => {
    const name = crypto.randomUUID();
    const { client, a, runRoutine, unread } = await scaffold(name);
    // The tab selected A (report 2), then was hidden (report 3); report 2 arrives last.
    expect((await viewing(name, "tab-1", null, 3)).status).toBe(200);
    expect((await viewing(name, "tab-1", a.id, 2)).status).toBe(200);
    await runRoutine(a.id, "while hidden");
    expect(await unread(a.id)).toBe(true);
    expect((await viewing(name, "tab-1", a.id, 0)).status).toBe(400);
    client.socket.close();
  });

  it("keeps a dropped tab's chat watched while it reconnects, then lets it go", async () => {
    const name = crypto.randomUUID();
    const { client, a } = await scaffold(name);
    const other = await reconnectScaffold(name, "tab-9");
    await viewing(name, "tab-1", a.id);
    await sleep(GRACE_PASSED);
    // tab-1 drops: within the grace a routine in its chat is not unread...
    client.socket.close();
    await other.runRoutine(a.id, "during the blip");
    expect(await other.unread(a.id)).toBe(false);
    // ...after it, nobody is watching.
    await sleep(GRACE_PASSED);
    await other.runRoutine(a.id, "after the blip");
    expect(await other.unread(a.id)).toBe(true);
    other.client.socket.close();
  });

  it("gives no grace on a cold start to tabs that left long ago", async () => {
    for (const ageMs of [3_600_000, 3 * 86_400_000 - 60_000]) {
      const name = crypto.randomUUID();
      const { client, a } = await scaffold(name);
      // Saved state from a tab that selected A and then went away ageMs ago.
      await viewing(name, "tab-old", a.id);
      client.socket.close();
      await runInDurableObject(raw(name) as DurableObjectStub<TestGrokBot>, (instance: TestGrokBot) =>
        instance.store.touchViewers(["tab-old"], Date.now() - ageMs)
      );
      await abortAllDurableObjects();
      // The cold start (here: another tab's socket) must not revive it.
      const other = await reconnectScaffold(name, "tab-9");
      await other.runRoutine(a.id, "unattended");
      expect(await other.unread(a.id)).toBe(true);
      other.client.socket.close();
    }
  });

  it("remembers selections across a restart while tabs reconnect", async () => {
    const name = crypto.randomUUID();
    let { client, a, runRoutine, unread } = await scaffold(name);
    await viewing(name, "tab-1", a.id);
    await abortAllDurableObjects();
    // Right after the restart, before tab-1 is back, its saved selection still counts...
    const other = await reconnectScaffold(name, "tab-9");
    await other.runRoutine(a.id, "while reconnecting");
    expect(await other.unread(a.id)).toBe(false);
    // ...for the reconnect grace only.
    await sleep(GRACE_PASSED);
    await other.runRoutine(a.id, "nobody came back");
    expect(await other.unread(a.id)).toBe(true);
    // tab-1 reconnects and the bridge reports again on ready (marking A viewed);
    // the saved sequence number still orders its reports.
    ({ client, runRoutine, unread } = await reconnectScaffold(name));
    await viewing(name, "tab-1", null, 1);
    await viewing(name, "tab-1", a.id);
    expect(await unread(a.id)).toBe(false);
    await sleep(GRACE_PASSED);
    await runRoutine(a.id, "after restart");
    expect(await unread(a.id)).toBe(false);
    client.socket.close();
    other.client.socket.close();
  });

  it("switching A → B → cached A moves the watch back to A", async () => {
    const name = crypto.randomUUID();
    const { client, a, b, runRoutine, unread } = await scaffold(name);

    // A is opened, then B, then A again from the renderer's cache: no
    // openAgentTail, only the persisted selection the bridge reports.
    await client.call("openAgentTail", { id: a.id, limit: 50 });
    expect((await viewing(name, "tab-1", a.id)).status).toBe(200);
    await client.call("openAgentTail", { id: b.id, limit: 50 });
    await viewing(name, "tab-1", b.id);
    await viewing(name, "tab-1", a.id);

    // An update in the chat on screen is not unread; one in the background is.
    await runRoutine(a.id, "check A");
    expect(await unread(a.id)).toBe(false);
    await runRoutine(b.id, "check B");
    expect(await unread(b.id)).toBe(true);

    // Selecting B from cache marks it viewed, as opening it would.
    await viewing(name, "tab-1", b.id);
    expect(await unread(b.id)).toBe(false);

    // A selection only counts while its tab is connected; a hidden tab reports none.
    await viewing(name, "tab-1", null);
    await runRoutine(b.id, "check B again");
    expect(await unread(b.id)).toBe(true);
    // A tab without a socket counts only for the reconnect grace.
    await viewing(name, "tab-2", a.id);
    await sleep(GRACE_PASSED);
    await runRoutine(a.id, "check A again");
    expect(await unread(a.id)).toBe(true);

    expect((await viewing(name, "bad tab!", a.id)).status).toBe(400);
    expect((await viewing(name, "tab-1", "not-an-id")).status).toBe(400);
    client.socket.close();
  });
});

describe("tools through the model loop", () => {
  it("saves memories and shows them to the model in another chat", async () => {
    const bot = stub(crypto.randomUUID());
    const first = await bot.createAgent();
    const saved = await bot.prompt(first.id, "remember that my dog is called Rex");
    expect(saved.text).toContain("Saved memory #1: my dog is called Rex");
    const second = await bot.createAgent();
    expect((await bot.prompt(second.id, "how are you")).text).toContain("I remember 1 thing about you");
    expect((await bot.prompt(second.id, "what do you remember?")).text).toContain("#1: my dog is called Rex");
  });

  it("writes and reads workspace files, and fetches pages", async () => {
    const bot = stub(crypto.randomUUID());
    const { id } = await bot.createAgent();
    expect((await bot.prompt(id, "write /notes/todo.md: buy milk")).text).toContain("Wrote /notes/todo.md");
    expect((await bot.prompt(id, "read /notes/todo.md")).text).toContain("buy milk");
    const page = await bot.prompt(id, "fetch https://example.test/");
    expect(page.text).toContain("Title: Example Test Page");
    expect(page.text).toContain("Hello & welcome");
    expect(page.text).not.toContain("alert(1)");
  });

  it("shows tool calls as tool-call entries the renderer accepts", async () => {
    const bot = stub(crypto.randomUUID());
    const { id } = await bot.createAgent();
    await bot.prompt(id, "what time is it?");
    const entries = await bot.transcript(id);
    const call = entries.find((entry) => entry.kind === "tool-call")!;
    expect(call).toMatchObject({ name: "current_time", status: "done" });
    expect(projectTranscriptEntry(call, 0, "Grok Bot", id)).toMatchObject({ kind: "tool-call", name: "current_time", status: "done" });
  });
});

describe("routines", () => {
  it("creates a routine from the Routines pane and runs it now", async () => {
    const client = await connect(crypto.randomUUID());
    const { agent } = await client.call<{ agent: { id: string } }>("createAgent", { name: "New chat" });
    const list = await client.call<Array<Record<string, unknown>>>("createAgentAutomation", {
      id: agent.id,
      spec: { name: "Standup", prompt: "what time is it?", trigger: { type: "cron", schedule: "0 9 * * 1-5" }, isEnabled: true }
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Standup", isEnabled: true, triggerDescription: "Weekdays at 9:00 AM", runs: [] });
    const routine = list[0]!;
    await client.call("runAgentAutomationNow", { id: agent.id, automationId: routine.id });
    const view = client.transcript(agent.id, []);
    await eventually(() => view().some((entry) => text(entry).includes("⏰ Scheduled task: what time is it?")));
    expect(view().some((entry) => entry.kind === "message" && entry.content === "[routine] what time is it?")).toBe(true);
    const after = await eventually(async () => {
      const rows = await client.call<Array<{ runs: Array<{ status: string }> }>>("getAgentAutomations", { id: agent.id });
      return rows[0]!.runs[0]?.status === "ok" && rows;
    });
    expect(after[0]!.runs).toHaveLength(1);
    expect(client.events.some((event) => event.family === "automations")).toBe(true);

    await client.call("setAgentAutomationEnabled", { id: agent.id, automationId: routine.id, isEnabled: false });
    expect((await client.call<Array<{ isEnabled: boolean }>>("getAgentAutomations", { id: agent.id }))[0]!.isEnabled).toBe(false);
    await client.call("deleteAgentAutomation", { id: agent.id, automationId: routine.id });
    expect(await client.call("getAgentAutomations", { id: agent.id })).toEqual([]);
    client.socket.close();
  });

  it("fires a reminder the model scheduled through the alarm", async () => {
    const name = crypto.randomUUID();
    const bot = stub(name);
    const { id } = await bot.createAgent();
    const reply = await bot.prompt(id, "remind me in 1 second to stretch");
    expect(reply.text).toMatch(/Created routine .* \(Once, /);
    await sleep(1_200);
    await runDurableObjectAlarm(raw(name));
    const entries = await eventually(async () => {
      const list = await bot.transcript(id);
      return list.some((entry) => (entry.message as { content?: string } | undefined)?.content?.includes("Scheduled task")) && list;
    });
    expect(entries.some((entry) => entry.kind === "message" && entry.content === "[routine] Remind the user to stretch")).toBe(true);
    const rows = await runInDurableObject(raw(name) as DurableObjectStub<TestGrokBot>, (instance: TestGrokBot) => instance.store.automations());
    expect(rows[0]).toMatchObject({ isEnabled: false, nextRunAt: null });
  });

  it("keeps a recurring routine the model scheduled running", async () => {
    const name = crypto.randomUUID();
    const bot = stub(name);
    const { id } = await bot.createAgent();
    const reply = await bot.prompt(id, "every 2 minutes check the news");
    expect(reply.text).toMatch(/Created routine .* \(Every 2 minutes/);
    const rows = await runInDurableObject(raw(name) as DurableObjectStub<TestGrokBot>, (instance: TestGrokBot) => instance.store.automations());
    expect(rows[0]).toMatchObject({ schedule: "@every 2m", isEnabled: true });
    expect(rows[0]!.nextRunAt).toBeGreaterThan(Date.now());
  });
});

describe("settings", () => {
  it("routes Settings → Router and stores provider keys", async () => {
    const name = crypto.randomUUID();
    const router = (await (await SELF.fetch(`https://bot.test/api/bots/${name}/router`)).json()) as {
      provider: string;
      local: Record<string, { authenticated: boolean }>;
    };
    expect(router.provider).toBe("cursor");
    // No AI binding or keys in tests: the vendor routes are not ready.
    expect(router.local["claude-code"]!.authenticated).toBe(false);

    const set = await SELF.fetch(`https://bot.test/api/bots/${name}/router`, { method: "POST", body: JSON.stringify({ provider: "openrouter" }) });
    expect(((await set.json()) as { provider: string }).provider).toBe("openrouter");
    const saved = await SELF.fetch(`https://bot.test/api/bots/${name}/secrets`, {
      method: "POST",
      body: JSON.stringify({ upsert: { OPENROUTER_API_KEY: "sk-test" } })
    });
    expect(((await saved.json()) as { keys: string[] }).keys).toEqual(["OPENROUTER_API_KEY"]);
    const bad = await SELF.fetch(`https://bot.test/api/bots/${name}/secrets`, {
      method: "POST",
      body: JSON.stringify({ upsert: { AWS_SECRET: "x" } })
    });
    expect(bad.status).toBe(400);
    const after = (await (await SELF.fetch(`https://bot.test/api/bots/${name}/router`)).json()) as { model: string };
    expect(after.model).toBe("openrouter/x-ai/grok-4.3");
  });
});

describe("durability", () => {
  it("finishes an answer after the object crashes mid-stream", async () => {
    const name = crypto.randomUUID();
    let bot = stub(name);
    const { id } = await bot.createAgent();
    const receipt = await bot.sendPrompt(id, "slow");
    await eventually(async () => await bot.busy(id));
    await sleep(150);
    await abortAllDurableObjects();
    bot = stub(name);
    await runDurableObjectAlarm(raw(name));
    const result = await bot.prompt(id, "and now?");
    expect(result.status).toBe("done");
    expect(await bot.rawAnswers(id)).toEqual(["aborted", "stop", "stop"]);
    const entries = await bot.transcript(id);
    expect(entries.filter((entry) => entry.kind === "message").map((entry) => entry.content)).toEqual(["slow", "and now?"]);
    // The interrupted partial answer is superseded by the retry: one answer per turn,
    // and the retry keeps the id the partial streamed under.
    expect(entries.map((entry) => `${entry.id}:${entry.kind}`)).toEqual([
      "e0t0u:message",
      "e0t0s0:send-message",
      "e0t1u:message",
      "e0t1s0:send-message"
    ]);
    expect(text(entries[1] as Record<string, unknown>)).toMatch(/resumes from the last checkpoint\.$/);
    void receipt;
  });
});
