import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage, ThreadInfo } from "../src/shared/protocol";
import { EMPTY_VIEW, messageText, reduceAll, type ThreadView } from "../src/shared/view";
import { htmlToText } from "../src/server/tools/web";
import type { TestGrokBot } from "./worker";

function bot(name = crypto.randomUUID()) {
  return env.GrokBot.getByName(name) as unknown as DurableObjectStub<TestGrokBot>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("Condition never held");
    await sleep(25);
  }
}

describe("REST API", () => {
  it("serves health and config", async () => {
    expect(await (await SELF.fetch("https://bot.test/api/health")).json()).toEqual({ ok: true, name: "grokbot" });
    const config = (await (await SELF.fetch("https://bot.test/api/config")).json()) as {
      models: Array<{ provider: string; modelId: string }>;
      defaultModel: { provider: string; modelId: string };
    };
    expect(config.defaultModel).toEqual({ provider: "demo", modelId: "grokbot-demo" });
    expect(config.models.map((m) => m.provider)).toContain("demo");
  });

  it("answers a message and lists the titled thread", async () => {
    const name = `rest-${crypto.randomUUID()}`;
    const response = await SELF.fetch(`https://bot.test/api/bots/${name}/threads/root/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Plan my trip to Lisbon", wait: true })
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { status: string; text: string };
    expect(result.status).toBe("done");
    expect(result.text).toContain("You said: “Plan my trip to Lisbon”");

    const threads = (await (await SELF.fetch(`https://bot.test/api/bots/${name}/threads`)).json()) as {
      threads: ThreadInfo[];
    };
    expect(threads.threads).toHaveLength(1);
    expect(threads.threads[0]).toMatchObject({ id: "1", title: "Plan my trip to Lisbon", busy: false });
  });

  it("rejects bad input", async () => {
    const bad = await SELF.fetch("https://bot.test/api/bots/x/threads/root/messages", {
      method: "POST",
      body: "{}"
    });
    expect(bad.status).toBe(400);
    expect((await SELF.fetch("https://bot.test/api/bots/x/threads/abc/messages", { method: "POST", body: '{"text":"x"}' })).status).toBe(400);
    expect((await SELF.fetch("https://bot.test/agents/grok-bot/bad%20name")).status).toBe(400);
  });
});

describe("tools through the model loop", () => {
  it("saves memories and shows them to the model in later turns, across threads", async () => {
    const stub = bot();
    const saved = await stub.prompt("1", "remember that my dog is called Rex");
    expect(saved.status).toBe("done");
    expect(saved.text).toContain("Saved memory #1: my dog is called Rex");

    // A different thread sees the memory through the system prompt section.
    const other = await stub.createThread();
    const reply = await stub.prompt(other, "how are you");
    expect(reply.text).toContain("I remember 1 thing about you");

    const recall = await stub.prompt(other, "what do you remember?");
    expect(recall.text).toContain("#1: my dog is called Rex");

    const forgot = await stub.prompt("1", "forget memory #1");
    expect(forgot.text).toContain("Forgot memory #1.");
    expect(await stub.state(["memory"])).toEqual({ memory: [] });
  });

  it("writes, reads, lists, edits and deletes workspace files", async () => {
    const stub = bot();
    expect((await stub.prompt("1", "write /notes/todo.md: buy milk")).text).toContain("Wrote /notes/todo.md");
    expect((await stub.prompt("1", "read /notes/todo.md")).text).toContain("buy milk");
    expect((await stub.prompt("1", "list files")).text).toContain("/notes/todo.md");
    const state = await stub.state(["files"]);
    expect(state.files?.map((f) => f.path)).toEqual(["/notes/todo.md"]);
    expect((await stub.prompt("1", "read /missing.txt")).text).toContain("`files_read` failed");
    expect((await stub.prompt("1", "delete /notes/todo.md")).text).toContain("Deleted /notes/todo.md");
    expect((await stub.state(["files"])).files).toEqual([]);
  });

  it("fetches web pages as text", async () => {
    const stub = bot();
    const reply = await stub.prompt("1", "fetch https://example.test/");
    expect(reply.text).toContain("Title: Example Test Page");
    expect(reply.text).toContain("Hello & welcome");
    expect(reply.text).not.toContain("alert(1)");
    const missing = await stub.prompt("1", "fetch https://example.test/nope");
    expect(missing.text).toContain("`web_fetch` failed");
    expect(missing.text).toContain("Status: 404");
  });

  it("answers the time and thinks", async () => {
    const stub = bot();
    expect((await stub.prompt("1", "what time is it?")).text).toMatch(/ISO \d{4}-\d\d-\d\dT/);
    const transcriptBefore = await stub.transcript("1");
    expect(transcriptBefore.length).toBeGreaterThan(1);
    expect((await stub.prompt("1", "think about caching")).text).toContain("considered take on **caching**");
  });
});

describe("automations", () => {
  it("runs a one-shot reminder through the Lifecycle alarm", async () => {
    const stub = bot();
    const reply = await stub.prompt("1", "remind me in 1 second to stretch");
    expect(reply.text).toMatch(/Scheduled call-.* for /);
    const { automations } = await stub.state(["automations"]);
    expect(automations).toHaveLength(1);
    expect(automations![0]).toMatchObject({ thread: "1", prompt: "Remind the user to stretch", active: true });

    await sleep(1_200);
    await runDurableObjectAlarm(stub as unknown as DurableObjectStub);
    const transcript = await eventually(async () => {
      const lines = await stub.transcript("1");
      return lines.some((line) => line.includes("⏰ Scheduled task: Remind the user to stretch")) && lines;
    });
    expect(transcript).toContain("user: [Scheduled task] Remind the user to stretch");
    const after = await stub.state(["automations"]);
    expect(after.automations![0]).toMatchObject({ runs: 1, active: false });
  });

  it("reschedules a repeating automation and delivers each run once", async () => {
    const stub = bot();
    await stub.prompt("1", "every 5 minutes check the news");
    const [automation] = (await stub.state(["automations"])).automations!;
    expect(automation.everyMinutes).toBe(5);

    const outcome = await runInDurableObject(stub as unknown as DurableObjectStub<TestGrokBot>, async (instance) => {
      const job = { fn: "run", payload: { id: automation.id } } as never;
      const first = await instance.automations.onJob({ job, attempt: 1 });
      return first;
    });
    expect(outcome).toEqual({ rescheduleAt: automation.nextRun + 5 * 60_000 });
    const [after] = (await stub.state(["automations"])).automations!;
    expect(after).toMatchObject({ runs: 1, active: true, nextRun: automation.nextRun + 5 * 60_000 });

    // The delivered prompt is answered once.
    await eventually(async () => (await stub.transcript("1")).some((l) => l.includes("⏰ Scheduled task: check the news")));
    expect((await stub.prompt("1", "list schedules")).text).toContain("every 5 min, runs 1: check the news");
    expect((await stub.prompt("1", `cancel ${automation.id}`)).text).toContain(`Cancelled ${automation.id}.`);
    expect((await stub.state(["automations"])).automations).toEqual([]);
  });
});

describe("threads and models", () => {
  it("creates, forks, renames, archives and switches models", async () => {
    const stub = bot();
    await stub.prompt("1", "first message");
    const fork = await stub.createThread("1");
    const forkTranscript = await stub.transcript(fork);
    expect(forkTranscript[0]).toBe("user: first message");

    await stub.command(fork, { type: "thread.rename", title: "Renamed" });
    await stub.command("1", { type: "thread.archive", archived: true });
    const threads = await stub.threads();
    expect(threads.find((t) => t.id === fork)).toMatchObject({ title: "Renamed", parent: "1" });
    expect(threads.find((t) => t.id === "1")).toMatchObject({ archived: true, title: "first message" });

    const failure = await stub.setModel("1", { provider: "nope", modelId: "x" }).then(
      () => "resolved",
      (error: Error) => error.message
    );
    expect(failure).toMatch(/Unknown model nope\/x/);
    await stub.setModel("1", { provider: "demo", modelId: "grokbot-demo" });
    const usage = await stub.usage("1");
    expect(usage.output).toBeGreaterThan(0);
  });
});

describe("the WebSocket protocol", () => {
  async function connect(name: string, thread = "1") {
    const response = await SELF.fetch(`https://bot.test/agents/grok-bot/${name}?thread=${thread}`, {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    let view: ThreadView = EMPTY_VIEW;
    const frames: ServerMessage[] = [];
    let maxLive = 0;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      frames.push(message);
      if (message.type === "events") {
        view = reduceAll(view, message.events);
        if (view.live) maxLive = Math.max(maxLive, messageText(view.live).length);
      }
    });
    let next = 0;
    const call = (message: object) => {
      const id = String(++next);
      socket.send(JSON.stringify({ ...message, id }));
      return eventually(async () => {
        const reply = frames.find((frame) => (frame.type === "result" || frame.type === "error") && frame.id === id);
        return reply;
      });
    };
    return { socket, frames, view: () => view, maxLive: () => maxLive, call };
  }

  it("greets, streams a run, and queues a follow-up while busy", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    await eventually(async () => client.frames.some((f) => f.type === "events"));
    const hello = client.frames.find((f) => f.type === "hello");
    expect(hello).toMatchObject({ bot: name, thread: "1" });
    expect((hello as Extract<ServerMessage, { type: "hello" }>).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["memory_save", "files_write", "web_fetch", "schedule_prompt", "current_time"])
    );
    expect(client.frames.find((f) => f.type === "state")).toMatchObject({ threads: [{ id: "1" }] });

    expect(await client.call({ type: "send", text: "slow" })).toMatchObject({ type: "result" });
    await eventually(async () => client.view().running);
    await client.call({ type: "send", text: "and then hello" });
    await eventually(async () => client.view().queued === 1 || client.view().messages.length >= 4);

    await eventually(async () => !client.view().running && client.view().messages.length === 4);
    const texts = client.view().messages.map((m) => `${m.role}: ${messageText(m).slice(0, 40)}`);
    expect(texts).toEqual([
      "user: slow",
      "assistant: Durable Objects give each conversation a",
      "user: and then hello",
      expect.stringContaining("assistant: You said: “and then hello”")
    ]);
    // Deltas streamed: the live message grew before it was committed.
    expect(client.maxLive()).toBeGreaterThan(100);
    client.socket.close();
  });

  it("gives a client that joins mid-run the partial answer", async () => {
    const name = crypto.randomUUID();
    const first = await connect(name);
    await first.call({ type: "send", text: "slow" });
    await eventually(async () => first.view().live !== null && messageText(first.view().live!).length > 50);
    const late = await connect(name);
    await eventually(async () => late.view().running);
    expect(late.view().live === null || messageText(late.view().live!).length > 0).toBe(true);
    await eventually(async () => !late.view().running && late.view().messages.length === 2);
    expect(messageText(late.view().messages[1])).toBe(messageText(first.view().messages[1] ?? late.view().messages[1]));
    first.socket.close();
    late.socket.close();
  });

  it("runs commands: create thread, memory, files, errors", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    const created = (await client.call({ type: "thread.create" })) as { result: { thread: string } };
    expect(created.result.thread).toMatch(/^\d+$/);
    await client.call({ type: "memory.add", content: "Prefers metric units" });
    await eventually(async () =>
      client.frames.some((f) => f.type === "state" && f.memory?.[0]?.content === "Prefers metric units")
    );
    const error = await client.call({ type: "model.set", model: { provider: "x", modelId: "y" } });
    expect(error).toMatchObject({ type: "error", message: "Unknown model x/y" });
    const unknown = await client.call({ type: "bogus" });
    expect(unknown).toMatchObject({ type: "error" });
    client.socket.close();
  });
});

describe("durability", () => {
  it("finishes a run after the object crashes mid-answer", async () => {
    const name = crypto.randomUUID();
    const stub = bot(name);
    const receipt = await stub.submit("1", "slow");
    await eventually(async () => await stub.busy("1"));
    await sleep(200);
    await abortAllDurableObjects();

    // The PiHarness wake job left a due alarm; firing it restarts the object
    // and pi resumes the interrupted generation from its checkpoint.
    const fresh = bot(name);
    await runDurableObjectAlarm(fresh as unknown as DurableObjectStub);
    const result = await fresh.wait("1", receipt.operationId);
    expect(result.status).toBe("done");
    expect(result.text).toContain("Durable Objects give each conversation");
    // pi commits the answer the crash cut off as an aborted partial, then
    // generates the full answer: the crash really landed mid-stream.
    const answers = (await fresh.entries("1")).filter((entry) => entry.role === "assistant");
    expect(answers.map((entry) => entry.stop)).toEqual(["aborted", "stop"]);
    expect(answers[0].len).toBeLessThan(answers[1].len);
    const view = await fresh.transcript("1");
    expect(view.at(-1)).toContain("Durable Objects give each conversation");
  });

  it("keeps memories, files and threads across an eviction", async () => {
    const name = crypto.randomUUID();
    const stub = bot(name);
    await stub.prompt("1", "remember that I live in Paris");
    await stub.prompt("1", "write /a.txt: hello");
    await abortAllDurableObjects();
    const fresh = bot(name);
    const state = await fresh.state();
    expect(state.memory?.map((m) => m.content)).toEqual(["I live in Paris"]);
    expect(state.files?.map((f) => f.path)).toEqual(["/a.txt"]);
    expect(state.threads?.[0]).toMatchObject({ id: "1", title: "remember that I live in Paris" });
  });
});

describe("htmlToText", () => {
  it("keeps structure and decodes entities", () => {
    const { title, text } = htmlToText(
      "<html><head><title>T</title></head><body><p>a &lt;b&gt; &#65;&#x42;</p><ul><li>x</li><li>y</li></ul></body></html>"
    );
    expect(title).toBe("T");
    expect(text).toBe("a <b> AB\n\n- x\n- y");
  });
});
