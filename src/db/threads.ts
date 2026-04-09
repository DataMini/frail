import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

const DB_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "frail"
);

let db: Database | null = null;

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function getDb(): Database {
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(path.join(DB_DIR, "threads.db"));
    db.run("PRAGMA journal_mode=WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      )
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)`
    );

    // Daemon state (session ID, etc.)
    db.run(`
      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Persistent session messages for daemon restart recovery
    db.run(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT DEFAULT 'tui',
        tool_calls TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_session_messages ON session_messages(session_id, created_at)`
    );
  }
  return db;
}

function generateId(): string {
  return crypto.randomUUID();
}

// Thread CRUD

export function createThread(title: string = "New Thread"): Thread {
  const d = getDb();
  const now = Date.now();
  const thread: Thread = {
    id: generateId(),
    title,
    createdAt: now,
    updatedAt: now,
  };
  d.run(
    "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [thread.id, thread.title, thread.createdAt, thread.updatedAt]
  );
  return thread;
}

export function listThreads(): Thread[] {
  const d = getDb();
  const rows = d
    .query(
      "SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM threads ORDER BY updated_at DESC"
    )
    .all() as Thread[];
  return rows;
}

export function getThread(id: string): Thread | null {
  const d = getDb();
  const row = d
    .query(
      "SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM threads WHERE id = ?"
    )
    .get(id) as Thread | null;
  return row;
}

export function updateThread(id: string, title: string): void {
  const d = getDb();
  d.run("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?", [
    title,
    Date.now(),
    id,
  ]);
}

export function deleteThread(id: string): void {
  const d = getDb();
  d.run("DELETE FROM messages WHERE thread_id = ?", [id]);
  d.run("DELETE FROM threads WHERE id = ?", [id]);
}

// Message CRUD

export function addMessage(threadId: string, message: ChatMessage): string {
  const d = getDb();
  const id = generateId();
  const now = Date.now();
  d.run(
    "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, threadId, message.role, message.content, now]
  );
  d.run("UPDATE threads SET updated_at = ? WHERE id = ?", [now, threadId]);
  return id;
}

export function getMessages(threadId: string): ChatMessage[] {
  const d = getDb();
  const rows = d
    .query(
      "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC"
    )
    .all(threadId) as { role: string; content: string }[];

  return rows.map((row) => ({
    role: row.role as ChatMessage["role"],
    content: row.content,
  }));
}

export function clearMessages(threadId: string): void {
  const d = getDb();
  d.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
}

// Daemon state

export function getDaemonState(key: string): string | null {
  const d = getDb();
  const row = d
    .query("SELECT value FROM daemon_state WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setDaemonState(key: string, value: string): void {
  const d = getDb();
  d.run(
    "INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)",
    [key, value]
  );
}

// Session messages

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  source: "feishu" | "tui";
  toolCalls?: string;
  createdAt: number;
}

export function addSessionMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  source: "feishu" | "tui",
  toolCalls?: string
): void {
  const d = getDb();
  d.run(
    "INSERT INTO session_messages (session_id, role, content, source, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionId, role, content, source, toolCalls ?? null, Date.now()]
  );
}

export function getSessionMessages(
  sessionId: string,
  limit?: number
): SessionMessage[] {
  const d = getDb();
  const sql = limit
    ? "SELECT role, content, source, tool_calls as toolCalls, created_at as createdAt FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?"
    : "SELECT role, content, source, tool_calls as toolCalls, created_at as createdAt FROM session_messages WHERE session_id = ? ORDER BY created_at ASC";
  const args = limit ? [sessionId, limit] : [sessionId];
  return d.query(sql).all(...args) as SessionMessage[];
}

export function clearSessionMessages(sessionId: string): void {
  const d = getDb();
  d.run("DELETE FROM session_messages WHERE session_id = ?", [sessionId]);
}

export function getSessionMessageCount(sessionId: string): number {
  const d = getDb();
  const row = d
    .query("SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
