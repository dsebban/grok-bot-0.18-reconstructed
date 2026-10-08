import type {
  Automation,
  FileInfo,
  MemoryItem,
  ThreadId
} from "../shared/protocol";

/**
 * GrokBot's own state, in `gb_*` tables beside pi's `pi_*` tables in the
 * same Durable Object SQLite database. Everything is synchronous: Durable
 * Object SQL runs in-process, so prompt sections can read it while they
 * render.
 */

export type ThreadRow = {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly parent?: ThreadId;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gb_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    parent TEXT
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
    thread TEXT NOT NULL,
    prompt TEXT NOT NULL,
    next_run INTEGER NOT NULL,
    every_minutes INTEGER,
    runs INTEGER NOT NULL DEFAULT 0,
    last_run INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`
];

/** Largest file the workspace accepts, in characters. */
export const MAX_FILE_CHARS = 512 * 1024;
/** Most memories kept; the oldest go first. */
export const MAX_MEMORIES = 200;

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

type Row = Record<string, SqlStorageValue>;

export class Store {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    for (const statement of SCHEMA) this.#sql.exec(statement);
  }

  #all<T extends Row>(query: string, ...args: SqlStorageValue[]): T[] {
    return this.#sql.exec<T>(query, ...args).toArray();
  }

  // ── Threads ─────────────────────────────────────────────────────────────

  ensureThread(id: ThreadId, parent?: ThreadId): void {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO gb_threads (id, title, created_at, updated_at, parent)
       VALUES (?, '', ?, ?, ?)`,
      id,
      now,
      now,
      parent ?? null
    );
  }

  threads(): ThreadRow[] {
    return this.#all<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      archived: number;
      parent: string | null;
    }>(`SELECT * FROM gb_threads ORDER BY updated_at DESC`).map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: row.archived === 1,
      ...(row.parent ? { parent: row.parent } : {})
    }));
  }

  thread(id: ThreadId): ThreadRow | undefined {
    return this.threads().find((thread) => thread.id === id);
  }

  /** Bump a thread to the top, titling it from its first message. */
  touchThread(id: ThreadId, firstText?: string): void {
    this.ensureThread(id);
    const now = Date.now();
    this.#sql.exec(
      `UPDATE gb_threads SET updated_at = ? WHERE id = ?`,
      now,
      id
    );
    if (firstText) {
      this.#sql.exec(
        `UPDATE gb_threads SET title = ? WHERE id = ? AND title = ''`,
        titleFrom(firstText),
        id
      );
    }
  }

  renameThread(id: ThreadId, title: string): void {
    this.ensureThread(id);
    this.#sql.exec(
      `UPDATE gb_threads SET title = ? WHERE id = ?`,
      title.trim().slice(0, 120),
      id
    );
  }

  archiveThread(id: ThreadId, archived: boolean): void {
    this.ensureThread(id);
    this.#sql.exec(
      `UPDATE gb_threads SET archived = ? WHERE id = ?`,
      archived ? 1 : 0,
      id
    );
  }

  // ── Memory ──────────────────────────────────────────────────────────────

  memories(): MemoryItem[] {
    return this.#all<{ id: number; content: string; created_at: number }>(
      `SELECT * FROM gb_memory ORDER BY id`
    ).map((row) => ({
      id: row.id,
      content: row.content,
      createdAt: row.created_at
    }));
  }

  remember(content: string): MemoryItem {
    const text = content.trim();
    if (!text) throw new Error("Memory content is empty");
    const existing = this.memories().find(
      (item) => item.content.toLowerCase() === text.toLowerCase()
    );
    if (existing) return existing;
    const now = Date.now();
    const [row] = this.#all<{ id: number }>(
      `INSERT INTO gb_memory (content, created_at) VALUES (?, ?) RETURNING id`,
      text.slice(0, 2_000),
      now
    );
    this.#sql.exec(
      `DELETE FROM gb_memory WHERE id NOT IN
         (SELECT id FROM gb_memory ORDER BY id DESC LIMIT ?)`,
      MAX_MEMORIES
    );
    return { id: row.id, content: text, createdAt: now };
  }

  searchMemory(query: string): MemoryItem[] {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const all = this.memories();
    if (words.length === 0) return all;
    return all
      .map((item) => ({
        item,
        score: words.filter((word) => item.content.toLowerCase().includes(word))
          .length
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

  forget(id: number): boolean {
    return (
      this.#sql.exec(`DELETE FROM gb_memory WHERE id = ?`, id)
        .rowsWritten > 0
    );
  }

  // ── Files ───────────────────────────────────────────────────────────────

  files(prefix = "/"): FileInfo[] {
    const dir = prefix === "/" ? "/" : `${normalizePath(prefix)}/`;
    return this.#all<{ path: string; size: number; updated_at: number }>(
      `SELECT path, length(content) AS size, updated_at FROM gb_files
       WHERE substr(path, 1, ?) = ? ORDER BY path`,
      dir.length,
      dir
    ).map((row) => ({
      path: row.path,
      size: row.size,
      updatedAt: row.updated_at
    }));
  }

  readFile(path: string): string | undefined {
    const [row] = this.#all<{ content: string }>(
      `SELECT content FROM gb_files WHERE path = ?`,
      normalizePath(path)
    );
    return row?.content;
  }

  writeFile(path: string, content: string): FileInfo {
    if (content.length > MAX_FILE_CHARS) {
      throw new Error(`Files are limited to ${MAX_FILE_CHARS} characters`);
    }
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
    return (
      this.#sql.exec(`DELETE FROM gb_files WHERE path = ?`, normalizePath(path))
        .rowsWritten > 0
    );
  }

  // ── Automations ─────────────────────────────────────────────────────────

  automations(): Automation[] {
    return this.#all<{
      id: string;
      thread: string;
      prompt: string;
      next_run: number;
      every_minutes: number | null;
      runs: number;
      last_run: number | null;
      active: number;
    }>(`SELECT * FROM gb_automations ORDER BY next_run`).map((row) => ({
      id: row.id,
      thread: row.thread,
      prompt: row.prompt,
      nextRun: row.next_run,
      ...(row.every_minutes ? { everyMinutes: row.every_minutes } : {}),
      runs: row.runs,
      ...(row.last_run ? { lastRun: row.last_run } : {}),
      active: row.active === 1
    }));
  }

  automation(id: string): Automation | undefined {
    return this.automations().find((item) => item.id === id);
  }

  addAutomation(item: {
    id: string;
    thread: ThreadId;
    prompt: string;
    nextRun: number;
    everyMinutes?: number;
  }): Automation {
    this.#sql.exec(
      `INSERT OR IGNORE INTO gb_automations (id, thread, prompt, next_run, every_minutes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      item.id,
      item.thread,
      item.prompt,
      item.nextRun,
      item.everyMinutes ?? null,
      Date.now()
    );
    return this.automation(item.id)!;
  }

  /** Record a run; the next run, or inactive for a finished one-shot. */
  recordRun(id: string, ranAt: number, nextRun: number | undefined): void {
    this.#sql.exec(
      `UPDATE gb_automations
         SET runs = runs + 1, last_run = ?, next_run = COALESCE(?, next_run),
             active = CASE WHEN ? IS NULL THEN 0 ELSE 1 END
       WHERE id = ?`,
      ranAt,
      nextRun ?? null,
      nextRun ?? null,
      id
    );
  }

  deleteAutomation(id: string): boolean {
    return (
      this.#sql.exec(`DELETE FROM gb_automations WHERE id = ?`, id)
        .rowsWritten > 0
    );
  }
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}
