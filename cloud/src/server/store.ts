import type { AgentId } from "./types";

/**
 * GrokBot's own state, in `gb_*` tables beside pi's `pi_*` tables in the
 * same Durable Object SQLite database. Durable Object SQL is synchronous,
 * so prompt sections can read it while they render.
 */

export type AgentRow = {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hasUnread: boolean;
  readonly isHidden: boolean;
  readonly notifyOnUpdates: boolean;
  readonly lastPreview: string | null;
};

export type MemoryItem = { readonly id: number; readonly content: string; readonly createdAt: number };
export type FileInfo = { readonly path: string; readonly size: number; readonly updatedAt: number };

export type AutomationRun = {
  readonly id: string;
  readonly status: "running" | "ok" | "error";
  readonly startedAt: number;
  readonly detail?: string | null;
};

export type AutomationRow = {
  readonly id: string;
  readonly agentId: AgentId;
  readonly name: string;
  readonly prompt: string;
  /** A Routines schedule (`@every 5m`, cron, `CRON_TZ=… cron`) or `@at <ISO time>` for a one-shot. */
  readonly schedule: string;
  readonly isEnabled: boolean;
  readonly createdAt: number;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly runs: readonly AutomationRun[];
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gb_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    has_unread INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    notify_on_updates INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    last_preview TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS gb_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gb_files (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gb_automations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    next_run_at INTEGER,
    last_run_at INTEGER,
    runs TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS gb_nonces (
    agent_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    PRIMARY KEY (agent_id, entry_id)
  )`,
  `CREATE TABLE IF NOT EXISTS gb_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gb_usage (
    provider TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS gb_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`
];

export const MAX_FILE_CHARS = 512 * 1024;
export const MAX_MEMORIES = 200;
const MAX_RUNS = 20;

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.trim().split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("A file path is required");
  return `/${parts.join("/")}`;
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 45).trimEnd()}…` : line;
}

type Row = Record<string, SqlStorageValue>;

type AgentSqlRow = {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  has_unread: number;
  is_hidden: number;
  notify_on_updates: number;
  last_preview: string | null;
};

type AutomationSqlRow = {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string;
  is_enabled: number;
  created_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  runs: string;
};

function agentRow(row: AgentSqlRow): AgentRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasUnread: row.has_unread === 1,
    isHidden: row.is_hidden === 1,
    notifyOnUpdates: row.notify_on_updates === 1,
    lastPreview: row.last_preview
  };
}

function automationRow(row: AutomationSqlRow): AutomationRow {
  let runs: AutomationRun[] = [];
  try {
    runs = JSON.parse(row.runs) as AutomationRun[];
  } catch {
    runs = [];
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    runs
  };
}

export class Store {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    for (const statement of SCHEMA) this.#sql.exec(statement);
  }

  #all<T extends Row>(query: string, ...args: SqlStorageValue[]): T[] {
    return this.#sql.exec<T>(query, ...args).toArray();
  }

  // ── Settings ────────────────────────────────────────────────────────────

  setting(key: string): string | null {
    return this.#all<{ value: string }>(`SELECT value FROM gb_settings WHERE key = ?`, key)[0]?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.#sql.exec(
      `INSERT INTO gb_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    );
  }

  // ── Secrets (provider keys pasted in Settings → Router) ────────────────

  secret(name: string): string | null {
    return this.#all<{ value: string }>(`SELECT value FROM gb_secrets WHERE name = ?`, name)[0]?.value ?? null;
  }

  secretNames(): string[] {
    return this.#all<{ name: string }>(`SELECT name FROM gb_secrets ORDER BY name`).map((row) => row.name);
  }

  setSecret(name: string, value: string): void {
    this.#sql.exec(
      `INSERT INTO gb_secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      name,
      value
    );
  }

  removeSecret(name: string): void {
    this.#sql.exec(`DELETE FROM gb_secrets WHERE name = ?`, name);
  }

  // ── Usage by Router provider ─────────────────────────────────────────────

  recordUsage(provider: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    this.#sql.exec(
      `INSERT INTO gb_usage (provider, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, last_used_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         requests = requests + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         last_used_at = excluded.last_used_at`,
      provider,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      Date.now()
    );
  }

  usage(): Record<string, { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; lastUsedAt: number | null }> {
    const result: ReturnType<Store["usage"]> = {};
    for (const row of this.#all<{
      provider: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      last_used_at: number | null;
    }>(`SELECT * FROM gb_usage`)) {
      result[row.provider] = {
        requests: row.requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        lastUsedAt: row.last_used_at
      };
    }
    return result;
  }

  // ── Client nonces (renderer optimistic-send ids, by pi user entry) ──────

  setNonce(agentId: AgentId, entryId: string, nonce: string): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO gb_nonces (agent_id, entry_id, nonce) VALUES (?, ?, ?)`,
      agentId,
      entryId,
      nonce
    );
  }

  nonces(agentId: AgentId): Map<string, string> {
    return new Map(
      this.#all<{ entry_id: string; nonce: string }>(
        `SELECT entry_id, nonce FROM gb_nonces WHERE agent_id = ?`,
        agentId
      ).map((row) => [row.entry_id, row.nonce])
    );
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  addAgent(id: AgentId, name: string, description = ""): AgentRow {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO gb_agents (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      name,
      description,
      now,
      now
    );
    return this.agent(id)!;
  }

  agents(): AgentRow[] {
    return this.#all<AgentSqlRow>(
      `SELECT * FROM gb_agents WHERE is_deleted = 0 ORDER BY updated_at DESC`
    ).map(agentRow);
  }

  agent(id: AgentId): AgentRow | undefined {
    const [row] = this.#all<AgentSqlRow>(`SELECT * FROM gb_agents WHERE id = ? AND is_deleted = 0`, id);
    return row ? agentRow(row) : undefined;
  }

  updateAgent(
    id: AgentId,
    change: Partial<Pick<AgentRow, "name" | "description" | "hasUnread" | "isHidden" | "notifyOnUpdates" | "lastPreview">> & {
      touch?: boolean;
    }
  ): AgentRow | undefined {
    const sets: string[] = [];
    const args: SqlStorageValue[] = [];
    if (change.name !== undefined) sets.push("name = ?"), args.push(change.name.trim().slice(0, 120) || "New chat");
    if (change.description !== undefined) sets.push("description = ?"), args.push(change.description.slice(0, 2_000));
    if (change.hasUnread !== undefined) sets.push("has_unread = ?"), args.push(change.hasUnread ? 1 : 0);
    if (change.isHidden !== undefined) sets.push("is_hidden = ?"), args.push(change.isHidden ? 1 : 0);
    if (change.notifyOnUpdates !== undefined) sets.push("notify_on_updates = ?"), args.push(change.notifyOnUpdates ? 1 : 0);
    if (change.lastPreview !== undefined) sets.push("last_preview = ?"), args.push(change.lastPreview);
    if (change.touch) sets.push("updated_at = ?"), args.push(Date.now());
    if (sets.length > 0) this.#sql.exec(`UPDATE gb_agents SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
    return this.agent(id);
  }

  deleteAgent(id: AgentId): boolean {
    const removed = this.#sql.exec(`UPDATE gb_agents SET is_deleted = 1 WHERE id = ? AND is_deleted = 0`, id).rowsWritten > 0;
    this.#sql.exec(`DELETE FROM gb_automations WHERE agent_id = ?`, id);
    return removed;
  }

  // ── Memory ──────────────────────────────────────────────────────────────

  memories(): MemoryItem[] {
    return this.#all<{ id: number; content: string; created_at: number }>(`SELECT * FROM gb_memory ORDER BY id`).map(
      (row) => ({ id: row.id, content: row.content, createdAt: row.created_at })
    );
  }

  remember(content: string): MemoryItem {
    const text = content.trim();
    if (!text) throw new Error("Memory content is empty");
    const existing = this.memories().find((item) => item.content.toLowerCase() === text.toLowerCase());
    if (existing) return existing;
    const now = Date.now();
    const [row] = this.#all<{ id: number }>(
      `INSERT INTO gb_memory (content, created_at) VALUES (?, ?) RETURNING id`,
      text.slice(0, 2_000),
      now
    );
    this.#sql.exec(
      `DELETE FROM gb_memory WHERE id NOT IN (SELECT id FROM gb_memory ORDER BY id DESC LIMIT ?)`,
      MAX_MEMORIES
    );
    return { id: row.id, content: text, createdAt: now };
  }

  searchMemory(query: string): MemoryItem[] {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const all = this.memories();
    if (words.length === 0) return all;
    return all
      .map((item) => ({ item, score: words.filter((word) => item.content.toLowerCase().includes(word)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

  forget(id: number): boolean {
    return this.#sql.exec(`DELETE FROM gb_memory WHERE id = ?`, id).rowsWritten > 0;
  }

  // ── Files ───────────────────────────────────────────────────────────────

  files(prefix = "/"): FileInfo[] {
    const dir = prefix === "/" ? "/" : `${normalizePath(prefix)}/`;
    return this.#all<{ path: string; size: number; updated_at: number }>(
      `SELECT path, length(content) AS size, updated_at FROM gb_files WHERE substr(path, 1, ?) = ? ORDER BY path`,
      dir.length,
      dir
    ).map((row) => ({ path: row.path, size: row.size, updatedAt: row.updated_at }));
  }

  readFile(path: string): string | undefined {
    return this.#all<{ content: string }>(`SELECT content FROM gb_files WHERE path = ?`, normalizePath(path))[0]?.content;
  }

  writeFile(path: string, content: string): FileInfo {
    if (content.length > MAX_FILE_CHARS) throw new Error(`Files are limited to ${MAX_FILE_CHARS} characters`);
    const normalized = normalizePath(path);
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO gb_files (path, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      normalized,
      content,
      now
    );
    return { path: normalized, size: content.length, updatedAt: now };
  }

  deleteFile(path: string): boolean {
    return this.#sql.exec(`DELETE FROM gb_files WHERE path = ?`, normalizePath(path)).rowsWritten > 0;
  }

  // ── Automations (Routines) ───────────────────────────────────────────────

  automations(agentId?: AgentId): AutomationRow[] {
    const rows =
      agentId === undefined
        ? this.#all<AutomationSqlRow>(`SELECT * FROM gb_automations ORDER BY created_at`)
        : this.#all<AutomationSqlRow>(`SELECT * FROM gb_automations WHERE agent_id = ? ORDER BY created_at`, agentId);
    return rows.map(automationRow);
  }

  automation(id: string): AutomationRow | undefined {
    const [row] = this.#all<AutomationSqlRow>(`SELECT * FROM gb_automations WHERE id = ?`, id);
    return row ? automationRow(row) : undefined;
  }

  /** Insert; an existing id is kept as it is, so a retried insert is harmless. */
  addAutomation(row: Omit<AutomationRow, "runs" | "lastRunAt" | "createdAt">): AutomationRow {
    this.#sql.exec(
      `INSERT OR IGNORE INTO gb_automations (id, agent_id, name, prompt, schedule, is_enabled, created_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.agentId,
      row.name,
      row.prompt,
      row.schedule,
      row.isEnabled ? 1 : 0,
      Date.now(),
      row.nextRunAt
    );
    return this.automation(row.id)!;
  }

  updateAutomation(
    id: string,
    change: Partial<Pick<AutomationRow, "name" | "prompt" | "schedule" | "isEnabled" | "nextRunAt">>
  ): AutomationRow | undefined {
    const sets: string[] = [];
    const args: SqlStorageValue[] = [];
    if (change.name !== undefined) sets.push("name = ?"), args.push(change.name);
    if (change.prompt !== undefined) sets.push("prompt = ?"), args.push(change.prompt);
    if (change.schedule !== undefined) sets.push("schedule = ?"), args.push(change.schedule);
    if (change.isEnabled !== undefined) sets.push("is_enabled = ?"), args.push(change.isEnabled ? 1 : 0);
    if (change.nextRunAt !== undefined) sets.push("next_run_at = ?"), args.push(change.nextRunAt);
    if (sets.length > 0) this.#sql.exec(`UPDATE gb_automations SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
    return this.automation(id);
  }

  /** Record (or replace, by run id) a run, keeping the newest few. */
  recordRun(id: string, run: AutomationRun): void {
    const current = this.automation(id);
    if (!current) return;
    const runs = [run, ...current.runs.filter((existing) => existing.id !== run.id)].slice(0, MAX_RUNS);
    this.#sql.exec(
      `UPDATE gb_automations SET runs = ?, last_run_at = ? WHERE id = ?`,
      JSON.stringify(runs),
      Math.max(current.lastRunAt ?? 0, run.startedAt),
      id
    );
  }

  deleteAutomation(id: string): boolean {
    return this.#sql.exec(`DELETE FROM gb_automations WHERE id = ?`, id).rowsWritten > 0;
  }
}
