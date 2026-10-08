import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import { computeNextRunAt, describeTrigger } from "../../../source/shared/automation-schedule";
import type { AgentId } from "./types";
import type { AutomationRow, Store } from "./store";

/**
 * Routines (scheduled prompts), on Lifecycle jobs. Each is a row in
 * `gb_automations` plus one job due at its next run; the job survives
 * eviction and deploys, and the object's alarm wakes it. A run submits the
 * prompt to its agent's pi conversation with an operation id derived from
 * the routine and its scheduled time, so a retried run never prompts twice.
 *
 * Schedules are the desktop Routines formats (`@every 5m`, cron, `CRON_TZ=`)
 * evaluated with the desktop's own `computeNextRunAt`, plus `@at <ISO>` for
 * one-shot reminders the model schedules.
 */

const RUN = "run";
const ONE_SHOT = /^@at\s+(\S+)$/i;

export type RoutineSpec = {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly isEnabled: boolean;
};

/** Delivers a run's prompt to the agent and resolves once it is durable; `settled` resolves when answered. */
export type Deliver = (
  agentId: AgentId,
  prompt: string,
  operationId: string
) => Promise<{ settled: Promise<{ ok: boolean; detail?: string }> }>;

function jobId(id: string): string {
  return `routine:${id}`;
}

export function oneShotAt(schedule: string): number | null {
  const match = ONE_SHOT.exec(schedule.trim());
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isNaN(at) ? null : at;
}

/** The next run strictly after `afterMs`, or null when there is none. */
export function nextRunAfter(schedule: string, afterMs: number, timeZone?: string): number | null {
  const at = oneShotAt(schedule);
  if (at !== null) return at > afterMs ? at : null;
  return computeNextRunAt(schedule, afterMs, timeZone);
}

export function isValidSchedule(schedule: string): boolean {
  return oneShotAt(schedule) !== null || computeNextRunAt(schedule, Date.now()) !== null;
}

export function describeSchedule(schedule: string, timeZone?: string): string {
  const at = oneShotAt(schedule);
  if (at !== null) {
    return `Once, ${new Date(at).toLocaleString("en-US", { timeZone: timeZone ?? "UTC", dateStyle: "medium", timeStyle: "short" })}`;
  }
  return describeTrigger({ type: "cron", schedule });
}

/** The renderer's RoutineAutomation shape. */
export function presentAutomation(row: AutomationRow, timeZone?: string) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    trigger: { type: "cron", schedule: row.schedule },
    triggerDescription: describeSchedule(row.schedule, timeZone),
    isEnabled: row.isEnabled,
    runs: row.runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.detail === undefined ? {} : { detail: run.detail })
    })),
    createdAt: row.createdAt,
    ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt })
  };
}

export class Automations extends LifecycleCapability {
  readonly #store: Store;
  readonly #deliver: Deliver;
  readonly #onChange: (agentId: AgentId) => void;
  readonly #timeZone: () => string | undefined;

  constructor(
    store: Store,
    deliver: Deliver,
    onChange: (agentId: AgentId) => void,
    timeZone: () => string | undefined
  ) {
    super("grokbot-routines");
    this.#store = store;
    this.#deliver = deliver;
    this.#onChange = onChange;
    this.#timeZone = timeZone;
  }

  async create(agentId: AgentId, spec: RoutineSpec, id: string = crypto.randomUUID()): Promise<AutomationRow> {
    await this.lifecycle.ready();
    this.#validate(spec);
    const existing = this.#store.automation(id);
    if (existing) return existing;
    const row = this.#store.addAutomation({
      id,
      agentId,
      name: spec.name.trim() || "Routine",
      prompt: spec.prompt.trim(),
      schedule: spec.schedule.trim(),
      isEnabled: spec.isEnabled,
      nextRunAt: spec.isEnabled ? nextRunAfter(spec.schedule, Date.now() - 1, this.#timeZone()) : null
    });
    await this.#sync(row);
    this.#onChange(agentId);
    return row;
  }

  async update(id: string, spec: RoutineSpec): Promise<AutomationRow | undefined> {
    await this.lifecycle.ready();
    this.#validate(spec);
    const row = this.#store.updateAutomation(id, {
      name: spec.name.trim() || "Routine",
      prompt: spec.prompt.trim(),
      schedule: spec.schedule.trim(),
      isEnabled: spec.isEnabled,
      nextRunAt: spec.isEnabled ? nextRunAfter(spec.schedule, Date.now() - 1, this.#timeZone()) : null
    });
    if (row) {
      await this.#sync(row);
      this.#onChange(row.agentId);
    }
    return row;
  }

  async setEnabled(id: string, isEnabled: boolean): Promise<AutomationRow | undefined> {
    const current = this.#store.automation(id);
    if (!current) return undefined;
    return this.update(id, { ...current, isEnabled });
  }

  async remove(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.automation(id);
    await this.lifecycle.jobs.cancel(jobId(id));
    const removed = this.#store.deleteAutomation(id);
    if (row) this.#onChange(row.agentId);
    return removed;
  }

  /** Run now, outside the schedule. */
  async runNow(id: string): Promise<void> {
    await this.lifecycle.ready();
    const row = this.#store.automation(id);
    if (!row) throw new Error("Routine not found");
    await this.#run(row, Date.now(), `manual-${crypto.randomUUID()}`);
  }

  override async onStart(): Promise<void> {
    // Rows are the source of truth: re-push any enabled routine whose job is missing.
    for (const row of this.#store.automations()) {
      if (row.isEnabled && row.nextRunAt !== null && !this.lifecycle.jobs.get(jobId(row.id))) await this.#sync(row);
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== RUN) return undefined;
    const id = (job.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return undefined;
    const row = this.#store.automation(id);
    if (!row?.isEnabled || row.nextRunAt === null) return undefined;

    const scheduled = row.nextRunAt;
    await this.#run(row, scheduled, String(scheduled));
    // Skip runs missed while the object was down instead of bursting them.
    const next = nextRunAfter(row.schedule, Math.max(scheduled, Date.now()), this.#timeZone());
    this.#store.updateAutomation(id, { nextRunAt: next, ...(next === null ? { isEnabled: false } : {}) });
    this.#onChange(row.agentId);
    return next === null ? undefined : { rescheduleAt: next };
  }

  async #run(row: AutomationRow, startedAt: number, runKey: string): Promise<void> {
    const runId = `${row.id}:${runKey}`;
    this.#store.recordRun(row.id, { id: runId, status: "running", startedAt });
    this.#onChange(row.agentId);
    const { settled } = await this.#deliver(row.agentId, `[routine] ${row.prompt}`, `routine:${runId}`);
    // The answer comes later; record it without holding the alarm.
    void settled.then(
      (outcome) => {
        this.#store.recordRun(row.id, {
          id: runId,
          status: outcome.ok ? "ok" : "error",
          startedAt,
          ...(outcome.detail ? { detail: outcome.detail } : {})
        });
        this.#onChange(row.agentId);
      },
      () => undefined
    );
  }

  #validate(spec: RoutineSpec): void {
    if (!spec.prompt.trim()) throw new Error("A routine needs a prompt");
    if (!isValidSchedule(spec.schedule)) throw new Error(`Unsupported schedule: ${spec.schedule}`);
  }

  async #sync(row: AutomationRow): Promise<void> {
    if (!row.isEnabled || row.nextRunAt === null) {
      await this.lifecycle.jobs.cancel(jobId(row.id));
      return;
    }
    await this.lifecycle.jobs.push({
      id: jobId(row.id),
      fn: RUN,
      time: row.nextRunAt,
      payload: { id: row.id },
      retry: { maxAttempts: 3 }
    });
  }
}
