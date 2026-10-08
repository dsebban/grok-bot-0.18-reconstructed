import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Automations } from "../automations";
import type { Store } from "../store";
import { errorText, text } from "./util";

const Schedule = Type.Object({
  prompt: Type.String({
    description:
      "What you should do when it runs, written as an instruction to yourself, e.g. \"Remind the user to stretch.\""
  }),
  inMinutes: Type.Optional(
    Type.Number({ description: "Run this many minutes from now (may be fractional)." })
  ),
  at: Type.Optional(
    Type.String({ description: "Run at this ISO 8601 time instead, e.g. 2026-10-09T08:00:00Z." })
  ),
  everyMinutes: Type.Optional(
    Type.Number({ description: "Repeat every N minutes after the first run." })
  )
});
const Cancel = Type.Object({ id: Type.String() });
const Empty = Type.Object({});

function describe(at: number): string {
  return new Date(at).toISOString();
}

export function scheduleTools(
  automations: Automations,
  store: Store
): ToolRegistration[] {
  const schedule: ToolRegistration<typeof Schedule> = {
    name: "schedule_prompt",
    description:
      "Schedule a prompt to run later in this conversation (a reminder, a recurring check, a follow-up). It runs even if nobody has the app open.",
    parameters: Schedule,
    // The automation id is the call id, so a replay finds the same automation.
    replay: "safe",
    async execute({ prompt, inMinutes, at, everyMinutes }, api) {
      try {
        let when: number;
        if (at !== undefined) {
          when = Date.parse(at);
          if (Number.isNaN(when)) return text(`Could not parse time ${at}`, true);
        } else {
          when = Date.now() + Math.max(0, inMinutes ?? 0) * 60_000;
        }
        const automation = await automations.schedule({
          id: `call-${api.callId}`.slice(0, 120),
          thread: String(api.conversationId),
          prompt,
          at: when,
          ...(everyMinutes === undefined ? {} : { everyMinutes })
        });
        return text(
          `Scheduled ${automation.id} for ${describe(automation.nextRun)}` +
            (automation.everyMinutes
              ? `, repeating every ${automation.everyMinutes} min.`
              : ".")
        );
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const list: ToolRegistration<typeof Empty> = {
    name: "list_schedules",
    description: "List scheduled prompts (automations) of this bot.",
    parameters: Empty,
    replay: "safe",
    async execute() {
      const items = store.automations();
      if (items.length === 0) return text("Nothing is scheduled.");
      return text(
        items
          .map(
            (item) =>
              `${item.id} [${item.active ? "active" : "done"}] thread ${item.thread}, next ${describe(item.nextRun)}` +
              (item.everyMinutes ? `, every ${item.everyMinutes} min` : "") +
              `, runs ${item.runs}: ${item.prompt}`
          )
          .join("\n")
      );
    }
  };

  const cancel: ToolRegistration<typeof Cancel> = {
    name: "cancel_schedule",
    description: "Cancel a scheduled prompt by id.",
    parameters: Cancel,
    replay: "safe",
    async execute({ id }) {
      const removed = await automations.cancel(id);
      return text(removed ? `Cancelled ${id}.` : `No automation ${id}.`);
    }
  };

  return [schedule, list, cancel];
}
