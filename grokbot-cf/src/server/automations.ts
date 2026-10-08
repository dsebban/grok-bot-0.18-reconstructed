import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import type { Automation, ThreadId } from "../shared/protocol";
import type { Store } from "./store";

const RUN = "run";
const MINUTE = 60_000;
/** Shortest repeat interval an automation may have. */
export const MIN_EVERY_MINUTES = 1;

export type AutomationRequest = {
  /** Stable id; scheduling the same id twice keeps the first. */
  readonly id: string;
  readonly thread: ThreadId;
  readonly prompt: string;
  readonly at: number;
  readonly everyMinutes?: number;
};

/** Delivers a due automation's prompt to its thread, idempotently by `operationId`. */
export type Deliver = (
  thread: ThreadId,
  prompt: string,
  operationId: string
) => Promise<void>;

function jobId(id: string): string {
  return `automation:${id}`;
}

/**
 * Scheduled prompts ("automations"). Each one is a row in `gb_automations`
 * plus a Lifecycle job due at its next run. The job outlives evictions and
 * deploys: Lifecycle's alarm wakes the object, the job delivers the prompt to
 * its thread as an ordinary submission, and a repeating automation
 * reschedules itself. The submission's operation id is derived from the
 * automation and its scheduled time, so a run that is retried after a crash
 * never prompts the model twice.
 */
export class Automations extends LifecycleCapability {
  readonly #store: Store;
  readonly #deliver: Deliver;
  readonly #onChange: () => void;

  constructor(store: Store, deliver: Deliver, onChange: () => void) {
    super("grokbot-automations");
    this.#store = store;
    this.#deliver = deliver;
    this.#onChange = onChange;
  }

  async schedule(request: AutomationRequest): Promise<Automation> {
    if (!request.prompt.trim()) throw new Error("An automation needs a prompt");
    if (!Number.isFinite(request.at)) throw new Error("Invalid run time");
    if (
      request.everyMinutes !== undefined &&
      !(request.everyMinutes >= MIN_EVERY_MINUTES)
    ) {
      throw new Error(`Repeat interval must be at least ${MIN_EVERY_MINUTES} minute`);
    }
    await this.lifecycle.ready();
    const existing = this.#store.automation(request.id);
    if (existing) return existing;
    const automation = this.#store.addAutomation({
      id: request.id,
      thread: request.thread,
      prompt: request.prompt.trim(),
      nextRun: Math.max(request.at, Date.now()),
      ...(request.everyMinutes === undefined
        ? {}
        : { everyMinutes: Math.round(request.everyMinutes) })
    });
    await this.#push(automation);
    this.#onChange();
    return automation;
  }

  async cancel(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    await this.lifecycle.jobs.cancel(jobId(id));
    const removed = this.#store.deleteAutomation(id);
    if (removed) this.#onChange();
    return removed;
  }

  override async onStart(): Promise<void> {
    // Rows are the source of truth: re-push any active automation whose job
    // is missing (for instance one written before its job was pushed).
    for (const automation of this.#store.automations()) {
      if (automation.active && !this.lifecycle.jobs.get(jobId(automation.id))) {
        await this.#push(automation);
      }
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== RUN) return undefined;
    const id = (job.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return undefined;
    const automation = this.#store.automation(id);
    if (!automation?.active) return undefined;

    const scheduled = automation.nextRun;
    await this.#deliver(
      automation.thread,
      `[Scheduled task] ${automation.prompt}`,
      `automation:${id}:${scheduled}`
    );

    let next: number | undefined;
    if (automation.everyMinutes) {
      const every = automation.everyMinutes * MINUTE;
      next = scheduled + every;
      // Skip runs missed while the object was down, rather than bursting.
      while (next <= Date.now()) next += every;
    }
    this.#store.recordRun(id, Date.now(), next);
    this.#onChange();
    return next === undefined ? undefined : { rescheduleAt: next };
  }

  #push(automation: Automation) {
    return this.lifecycle.jobs.push({
      id: jobId(automation.id),
      fn: RUN,
      time: automation.nextRun,
      payload: { id: automation.id },
      retry: { maxAttempts: 3 }
    });
  }
}
