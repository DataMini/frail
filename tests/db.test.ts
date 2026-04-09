import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import * as db from "../src/db/threads";

// Clean up between tests by clearing all threads
function clearAll() {
  for (const t of db.listThreads()) {
    db.deleteThread(t.id);
  }
}

describe("db/threads", () => {
  beforeEach(clearAll);
  afterAll(() => db.closeDb());

  test("createThread returns a thread with correct title", () => {
    const t = db.createThread("test thread");
    expect(t.id).toBeTruthy();
    expect(t.title).toBe("test thread");
    expect(t.createdAt).toBeGreaterThan(0);
    expect(t.updatedAt).toBe(t.createdAt);
  });

  test("listThreads returns all threads", () => {
    db.createThread("first");
    db.createThread("second");
    const list = db.listThreads();
    expect(list.length).toBe(2);
    const titles = list.map((t) => t.title);
    expect(titles).toContain("first");
    expect(titles).toContain("second");
  });

  test("listThreads order: updated thread comes first", () => {
    const t1 = db.createThread("first");
    const t2 = db.createThread("second");
    // Update t1 so its updated_at is newer
    db.updateThread(t1.id, "first-updated");
    const list = db.listThreads();
    expect(list[0]!.id).toBe(t1.id);
  });

  test("getThread returns null for missing id", () => {
    expect(db.getThread("nonexistent")).toBeNull();
  });

  test("getThread returns the correct thread", () => {
    const t = db.createThread("find me");
    const found = db.getThread(t.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("find me");
  });

  test("updateThread changes title and updatedAt", () => {
    const t = db.createThread("old");
    db.updateThread(t.id, "new");
    const updated = db.getThread(t.id);
    expect(updated!.title).toBe("new");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
  });

  test("deleteThread removes thread and its messages", () => {
    const t = db.createThread("doomed");
    db.addMessage(t.id, { role: "user", content: "hello" });
    db.deleteThread(t.id);
    expect(db.getThread(t.id)).toBeNull();
    expect(db.getMessages(t.id)).toEqual([]);
  });

  test("addMessage and getMessages round-trip", () => {
    const t = db.createThread("chat");
    db.addMessage(t.id, { role: "user", content: "hello" });
    db.addMessage(t.id, { role: "assistant", content: "hi there" });

    const msgs = db.getMessages(t.id);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hi there" });
  });

  test("addMessage stores string content", () => {
    const t = db.createThread("tools");
    db.addMessage(t.id, { role: "assistant", content: "Analysis complete." });

    const msgs = db.getMessages(t.id);
    expect(msgs[0]!.content).toBe("Analysis complete.");
  });

  test("clearMessages removes all messages but keeps thread", () => {
    const t = db.createThread("clear me");
    db.addMessage(t.id, { role: "user", content: "1" });
    db.addMessage(t.id, { role: "user", content: "2" });
    db.clearMessages(t.id);

    expect(db.getMessages(t.id)).toEqual([]);
    expect(db.getThread(t.id)).not.toBeNull();
  });
});
