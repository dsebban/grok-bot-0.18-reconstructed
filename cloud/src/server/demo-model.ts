import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";

/**
 * "GrokBot Demo": a deterministic, offline model. It needs no account
 * or key and calls the real tools, so the whole stack (pi-durable, tools,
 * automations, sockets, UI) can be exercised and tested end to end. Its
 * answer depends only on the transcript, so a run that resumes after an
 * eviction gets the same answer it would have got before.
 */

export const DEMO_PROVIDER = "demo";
export const DEMO_MODEL = "grokbot-demo";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** The system prompt sections in effect, folded from system messages. */
function sections(context: TranscriptContext): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete shown[key];
      else shown[key] = value;
    }
  }
  return shown;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args as never)], {
    stopReason: "toolUse"
  });
}

const HELP = [
  "I'm the **offline demo model**. I don't need an API key; I follow a script so you can try every part of GrokBot. Try:",
  "",
  "- `remember that my favourite colour is teal`",
  "- `what do you remember?`",
  "- `write /notes/todo.md: buy milk`, then `read /notes/todo.md` or `list files`",
  "- `fetch https://example.com`",
  "- `remind me in 0.1 minutes to stretch` or `every 5 minutes check the news`",
  "- `list schedules`, `what time is it?`",
  "- `think about durable objects`, or `slow` for a long streamed answer",
  "",
  "Pick a real model (Workers AI, OpenRouter, Anthropic, OpenAI) in the model menu for actual conversations."
].join("\n");

const LOREM =
  "Durable Objects give each conversation a single-threaded home with its own SQLite database. pi-durable commits every model turn and tool call before it is shown, so an eviction mid-answer simply resumes from the last checkpoint. ";

/** One reply, derived from the transcript alone. */
export function demoReply(context: TranscriptContext): AssistantMessage {
  const visible = context.messages.filter((message) => message.role !== "system");
  const last = visible.at(-1);

  if (last?.role === "toolResult") {
    const result = textOf(last.content);
    const verb = last.isError ? "failed" : "returned";
    return fauxAssistantMessage([
      fauxText(`\`${last.toolName}\` ${verb}:\n\n\`\`\`\n${result.slice(0, 1_500)}\n\`\`\``)
    ]);
  }

  const prompt = last?.role === "user" ? textOf(last.content).trim() : "";
  const lower = prompt.toLowerCase();
  let match: RegExpExecArray | null;

  if ((match = /^\[(?:scheduled task|routine)\]\s*(.*)$/is.exec(prompt))) {
    return fauxAssistantMessage([fauxText(`⏰ Scheduled task: ${match[1]}`)]);
  }
  if ((match = /^remember(?: that)?\s+(.+)$/is.exec(prompt))) {
    return call("memory_save", { content: match[1].trim() });
  }
  if (/what do you (remember|know)|^recall\b/.test(lower)) {
    return call("memory_search", { query: "" });
  }
  if ((match = /^forget (?:memory )?#?(\d+)/i.exec(prompt))) {
    return call("memory_forget", { id: Number(match[1]) });
  }
  if ((match = /^(?:write|save)(?: file)?\s+(\/\S+):\s*([\s\S]*)$/i.exec(prompt))) {
    return call("files_write", { path: match[1], content: match[2] });
  }
  if ((match = /^read(?: file)?\s+(\/\S+)$/i.exec(prompt))) {
    return call("files_read", { path: match[1] });
  }
  if ((match = /^delete(?: file)?\s+(\/\S+)$/i.exec(prompt))) {
    return call("files_delete", { path: match[1] });
  }
  if (/^(list|show) files/.test(lower)) {
    return call("files_list", {});
  }
  if ((match = /(https?:\/\/\S+)/i.exec(prompt)) && /fetch|open|read|summari[sz]e/.test(lower)) {
    return call("web_fetch", { url: match[1].replace(/[).,]+$/, ""), maxChars: 2_000 });
  }
  if ((match = /^remind me in ([\d.]+) (second|minute)s? to (.+)$/i.exec(prompt))) {
    const amount = Number(match[1]);
    const minutes = match[2].toLowerCase() === "second" ? amount / 60 : amount;
    return call("schedule_prompt", {
      prompt: `Remind the user to ${match[3].trim()}`,
      inMinutes: minutes
    });
  }
  if ((match = /^every ([\d.]+) minutes? (.+)$/i.exec(prompt))) {
    return call("schedule_prompt", {
      prompt: match[2].trim(),
      // `@every` takes whole units.
      schedule: Number.isInteger(Number(match[1])) ? `@every ${Number(match[1])}m` : `@every ${Math.max(1, Math.round(Number(match[1]) * 60))}s`
    });
  }
  if ((match = /^cancel (?:schedule )?(\S+)$/i.exec(prompt))) {
    return call("cancel_schedule", { id: match[1] });
  }
  if (/^(list|show) schedules/.test(lower)) {
    return call("list_schedules", {});
  }
  if (/what time|what's the time|what day/.test(lower)) {
    return call("current_time", {});
  }
  if ((match = /^think about (.+)$/i.exec(prompt))) {
    return fauxAssistantMessage([
      fauxThinking(`The user wants me to consider ${match[1]}. Let me reason step by step.`),
      fauxText(`Here is my considered take on **${match[1]}**: it is worth exploring.`)
    ]);
  }
  if (lower === "slow") {
    return fauxAssistantMessage([fauxText(LOREM.repeat(12).trim())]);
  }
  if (lower === "help" || lower === "" || lower === "hi" || lower === "hello") {
    return fauxAssistantMessage([fauxText(HELP)]);
  }

  const memory = sections(context).memory;
  const remembered = memory ? memory.split("\n").filter((line) => line.startsWith("- ")).length : 0;
  return fauxAssistantMessage([
    fauxText(
      `You said: “${prompt}”.\n\n` +
        (remembered > 0
          ? `_I remember ${remembered} thing${remembered === 1 ? "" : "s"} about you._\n\n`
          : "") +
        "Type `help` to see what the demo model can do."
    )
  ]);
}

/** The demo provider for a pi-ai `Models` registry. */
export function createDemoProvider(options: { tokensPerSecond?: number } = {}) {
  const handle = fauxProvider({
    provider: DEMO_PROVIDER,
    models: [
      {
        id: DEMO_MODEL,
        name: "GrokBot Demo (offline)",
        reasoning: true,
        contextWindow: 128_000,
        maxTokens: 8_192
      }
    ],
    tokensPerSecond: options.tokensPerSecond ?? 400,
    tokenSize: { min: 3, max: 6 }
  });
  // The faux provider consumes one scripted step per request; keep one queued
  // forever by having each step queue its successor.
  const step = (context: TranscriptContext): AssistantMessage => {
    handle.appendResponses([step]);
    return demoReply(context);
  };
  handle.setResponses([step]);
  return handle;
}
