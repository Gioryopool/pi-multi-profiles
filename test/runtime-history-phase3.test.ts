import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RuntimeHistory } from "../src/subagents-runtime/history.js";
import { appendThreadEvent } from "../src/subagents-runtime/thread-view.js";

describe("Phase 3 package-owned runtime history", () => {
  it("persists and isolates bounded task history by parent session", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path, 1);
    history.save({
      id: "one",
      parentSessionId: "parent-a",
      agent: "worker",
      task: "first",
      mode: "background",
      status: "completed",
      createdAt: "now",
      result: "done",
    });
    history.save({
      id: "two",
      parentSessionId: "parent-a",
      agent: "worker",
      task: "second",
      mode: "task",
      status: "failed",
      createdAt: "later",
      error: "no",
    });
    history.save({
      id: "other",
      parentSessionId: "parent-b",
      agent: "worker",
      task: "private",
      mode: "task",
      status: "completed",
      createdAt: "now",
    });
    history.close();

    const reopened = new RuntimeHistory(path, 1);
    expect(reopened.list("parent-a").map((task) => task.id)).toEqual(["two"]);
    expect(reopened.get("one", "parent-b")).toBeUndefined();
    expect(reopened.get("one", "parent-a")).toBeUndefined();
    reopened.close();
  });
  it("uses WAL so a second connection can read history while a writer holds a transaction", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const writer = new RuntimeHistory(path);
    writer.save({
      id: "saved",
      parentSessionId: "parent",
      agent: "worker",
      task: "work",
      mode: "background",
      status: "completed",
      createdAt: "now",
    });
    const reader = new RuntimeHistory(path);
    const lock = new DatabaseSync(path);
    expect(lock.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    lock.exec("BEGIN IMMEDIATE");
    expect(reader.list("parent").map((task) => task.id)).toEqual(["saved"]);
    lock.exec("COMMIT");
    lock.close();
    reader.close();
    writer.close();
  });
  it("prunes persisted rows per parent session and retains only each session's newest limit after reopen", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path, 2);
    for (const id of ["a1", "a2", "a3"])
      history.save({
        id,
        parentSessionId: "a",
        agent: "worker",
        task: id,
        status: "completed",
        createdAt: id,
      });
    for (const id of ["b1", "b2", "b3"])
      history.save({
        id,
        parentSessionId: "b",
        agent: "worker",
        task: id,
        status: "completed",
        createdAt: id,
      });
    history.close();
    const db = new DatabaseSync(path);
    expect(
      db
        .prepare(
          "SELECT parent_session_id, id FROM runtime_tasks ORDER BY parent_session_id, rowid",
        )
        .all(),
    ).toEqual([
      { parent_session_id: "a", id: "a2" },
      { parent_session_id: "a", id: "a3" },
      { parent_session_id: "b", id: "b2" },
      { parent_session_id: "b", id: "b3" },
    ]);
    db.close();
    const reopened = new RuntimeHistory(path, 2);
    expect(reopened.list("a").map((task) => task.id)).toEqual(["a3", "a2"]);
    expect(reopened.list("b").map((task) => task.id)).toEqual(["b3", "b2"]);
    reopened.close();
  });
  it("records idempotent schema metadata and skips a malformed row inserted directly", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path);
    history.save({
      id: "good",
      parentSessionId: "parent",
      agent: "worker",
      task: "x",
      status: "completed",
      createdAt: "now",
    });
    history.close();
    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 1,
    });
    db.prepare(
      "INSERT INTO runtime_tasks (id, parent_session_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
    ).run("bad", "parent", "completed", "later", "not json");
    db.close();
    const reopened = new RuntimeHistory(path);
    expect(reopened.list("parent").map((task) => task.id)).toEqual(["good"]);
    expect(reopened.get("bad", "parent")).toBeUndefined();
    reopened.close();
    reopened.close();
  });
  it("sanitizes legacy definitions while preserving continuation state when rewritten", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path);
    history.close();
    const db = new DatabaseSync(path);
    const legacy = {
      id: "legacy",
      parentSessionId: "parent",
      agent: "worker",
      task: "x",
      status: "completed",
      createdAt: "now",
      nestedSessionPath: "/owned/session.jsonl",
      definition: {
        instructions: "SECRET_INTERNAL_INSTRUCTIONS",
        filePath: "/private/worker.md",
      },
    };
    db.prepare(
      "INSERT INTO runtime_tasks (id, parent_session_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy", "parent", "completed", "now", JSON.stringify(legacy));
    db.close();
    const reopened = new RuntimeHistory(path);
    const task = reopened.get("legacy", "parent")!;
    expect(task).toMatchObject({ nestedSessionPath: "/owned/session.jsonl" });
    expect(task).not.toHaveProperty("definition");
    reopened.save(task);
    reopened.close();
    const verified = new DatabaseSync(path);
    expect(
      String(
        (
          verified
            .prepare("SELECT data FROM runtime_tasks WHERE id = ?")
            .get("legacy") as any
        ).data,
      ),
    ).not.toMatch(/SECRET_INTERNAL_INSTRUCTIONS|"definition"/);
    verified.close();
  });
  it("marks malformed stale payload rows interrupted in their status column during recovery", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path);
    history.close();
    const db = new DatabaseSync(path);
    db.prepare(
      "INSERT INTO runtime_tasks (id, parent_session_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)",
    ).run("bad-running", "parent", "running", "now", "not json");
    db.close();
    const reopened = new RuntimeHistory(path);
    reopened.close();
    const verified = new DatabaseSync(path);
    expect(
      verified
        .prepare("SELECT status FROM runtime_tasks WHERE id = ?")
        .get("bad-running"),
    ).toEqual({ status: "interrupted" });
    verified.close();
  });
  it("round-trips an SDK lifecycle through SQLite without duplicate streamed or manager results", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path);
    try {
      let task: Parameters<RuntimeHistory["save"]>[0] = {
        id: "lifecycle",
        parentSessionId: "parent",
        agent: "worker",
        task: "answer the prompt",
        status: "running",
        createdAt: "now",
      };
      const apply = (event: unknown) => {
        task = { ...task, thread: appendThreadEvent(task.thread, event) };
        history.save(task);
        task = history.get("lifecycle", "parent")!;
      };
      apply({
        type: "message_start",
        message: {
          id: "user-1",
          role: "user",
          content: "verify SQLite lifecycle",
        },
      });
      apply({
        type: "message_end",
        message: {
          id: "user-1",
          role: "user",
          content: "verify SQLite lifecycle",
        },
      });
      const assistantId = `assistant-${"x".repeat(200)}`;
      apply({
        type: "message_start",
        message: { id: assistantId, role: "assistant", content: [] },
      });
      for (const content of [
        [
          { type: "thinking", thinking: "draft plan" },
          { type: "text", text: "a" },
        ],
        [
          { type: "thinking", thinking: "refined plan" },
          { type: "text", text: "an" },
        ],
        [
          { type: "thinking", thinking: "final plan" },
          { type: "text", text: "answer" },
        ],
      ])
        apply({
          type: "message_update",
          message: { id: assistantId, role: "assistant", content },
        });
      apply({
        type: "message_end",
        message: {
          id: assistantId,
          role: "assistant",
          content: [
            { type: "thinking", thinking: "final plan" },
            { type: "text", text: "answer" },
          ],
        },
        definition: { instructions: "SECRET" },
        nestedSessionPath: "/private/session",
      });
      apply({ role: "assistant", content: "answer" });
      const thread = task.thread!;
      expect(thread.entries.filter((entry) => entry.role === "user")).toEqual([
        { role: "user", text: "verify SQLite lifecycle" },
      ]);
      expect(
        thread.entries.filter((entry) => entry.role === "assistant"),
      ).toEqual([{ role: "assistant", text: "answer" }]);
      expect(
        thread.entries.filter((entry) => entry.role === "thinking"),
      ).toEqual([{ role: "thinking", text: "final plan" }]);
      expect(thread.frame).toMatchObject({
        role: "assistant",
        phase: "terminal",
        terminalText: "answer",
      });
      expect(thread.frame?.id).toHaveLength(120);
      expect(JSON.stringify(thread)).not.toMatch(
        /SECRET|nestedSessionPath|private\/session/,
      );
      let separate: Parameters<RuntimeHistory["save"]>[0] = {
        ...task,
        id: "separate",
        thread: undefined,
      };
      const applySeparate = (event: unknown) => {
        separate = {
          ...separate,
          thread: appendThreadEvent(separate.thread, event),
        };
        history.save(separate);
        separate = history.get("separate", "parent")!;
      };
      for (const id of ["one", "two"]) {
        applySeparate({
          type: "message_start",
          message: { id, role: "assistant", content: "same" },
        });
        applySeparate({
          type: "message_end",
          message: { id, role: "assistant", content: "same" },
        });
      }
      expect(
        separate.thread?.entries.filter((entry) => entry.role === "assistant"),
      ).toEqual([
        { role: "assistant", text: "same" },
        { role: "assistant", text: "same" },
      ]);
    } finally {
      history.close();
    }
  });
});
