import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describeSchedule, type Automations } from "../automations";
import type { Store } from "../store";
import { errorText, text } from "./util";

/**
 * The model's side of Routines: the same rows the Routines pane edits, so a
 * reminder the bot schedules shows up there and vice versa.
 */

const Schedule = Type.Object({
  prompt: Type.String({
    description: "What you should do when it runs, as an instruction to yourself, e.g. \"Remind the user to stretch.\""
  }),
  name: Type.Optional(Type.String({ description: "Short routine name shown to the user." })),
  inMinutes: Type.Optional(Type.Number({ description: "Run once, this many minutes from now (may be fractional)." })),
  at: Type.Optional(Type.String({ description: "Run once at this ISO 8601 time, e.g. 2026-10-09T08:00:00Z." })),
  schedule: Type.Optional(
    Type.String({
      description: "Repeat on a schedule instead: \"@every 30m\", \"@every 2h\", or a 5-field cron like \"0 9 * * 1-5\" (UTC unless prefixed CRON_TZ=Area/City)."
    })
  )
});
const Cancel = Type.Object({ id: Type.String() });
const Empty = Type.Object({});

export function scheduleTools(automations: Automations, store: Store): ToolRegistration[] {
  const schedule: ToolRegistration<typeof Schedule> = {
    name: "schedule_prompt",
    description:
      "Create a routine for this chat: a one-time reminder or follow-up, or a recurring check. It runs even when nobody has the app open, and appears in the chat's Routines.",
    parameters: Schedule,
    // The routine id is derived from the call id, so a replay finds the same routine.
    replay: "safe",
    async execute({ prompt, name, inMinutes, at, schedule: recurring }, api) {
      try {
        let spec: string;
        if (recurring) spec = recurring;
        else if (at !== undefined) spec = `@at ${new Date(Date.parse(at)).toISOString()}`;
        else spec = `@at ${new Date(Date.now() + Math.max(0, inMinutes ?? 0) * 60_000).toISOString()}`;
        const row = await automations.create(
          String(api.conversationId),
          { name: name ?? prompt.slice(0, 40), prompt, schedule: spec, isEnabled: true },
          `call-${api.callId}`.slice(0, 120)
        );
        return text(
          `Created routine ${row.id} (${describeSchedule(row.schedule)})` +
            (row.nextRunAt ? `; next run ${new Date(row.nextRunAt).toISOString()}.` : ".")
        );
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const list: ToolRegistration<typeof Empty> = {
    name: "list_schedules",
    description: "List this bot's routines (scheduled prompts).",
    parameters: Empty,
    replay: "safe",
    async execute() {
      const rows = store.automations();
      if (rows.length === 0) return text("Nothing is scheduled.");
      return text(
        rows
          .map(
            (row) =>
              `${row.id} [${row.isEnabled ? "on" : "off"}] chat ${row.agentId}, ${describeSchedule(row.schedule)}` +
              (row.nextRunAt ? `, next ${new Date(row.nextRunAt).toISOString()}` : "") +
              `, runs ${row.runs.length}: ${row.prompt}`
          )
          .join("\n")
      );
    }
  };

  const cancel: ToolRegistration<typeof Cancel> = {
    name: "cancel_schedule",
    description: "Delete a routine by id.",
    parameters: Cancel,
    replay: "safe",
    async execute({ id }) {
      const removed = await automations.remove(id);
      return text(removed ? `Deleted routine ${id}.` : `No routine ${id}.`);
    }
  };

  return [schedule, list, cancel];
}
