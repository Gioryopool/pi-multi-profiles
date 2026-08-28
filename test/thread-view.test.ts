import { describe, expect, it } from "vitest";
import {
  appendThreadEvent,
  buildThreadSnapshot,
  sanitizeThreadSnapshot,
} from "../src/subagents-runtime/thread-view.js";

type Snapshot = ReturnType<typeof appendThreadEvent>;
const append = (snapshot: Snapshot | undefined, event: unknown) =>
  appendThreadEvent(snapshot, event);
const persistedAppend = (snapshot: Snapshot | undefined, event: unknown) =>
  sanitizeThreadSnapshot(JSON.parse(JSON.stringify(append(snapshot, event))));
const message = (
  role: "assistant" | "user",
  content: unknown,
  id?: string,
) => ({ ...(id ? { id } : {}), role, content });
const assistant = (content: unknown, id?: string) =>
  message("assistant", content, id);
const sdk = (type: string, value: object) => ({ type, message: value });
const parts = (text: string) => [
  { type: "thinking", thinking: "plan" },
  { type: "text", text },
];

describe("thread snapshots", () => {
  it("bounds real nested events and excludes private definition/session fields", () => {
    const snapshot = buildThreadSnapshot([
      {
        type: "message_end",
        message: { role: "assistant", content: "answer", usage: { input: 3 } },
      },
      {
        type: "tool_result",
        toolName: "read",
        result: "ok",
        nestedSessionPath: "/private/session",
        definition: { instructions: "SECRET" },
      },
    ]);
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", text: "answer" }),
        expect.objectContaining({ role: "tool", name: "read", text: "ok" }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /SECRET|nestedSessionPath|\/private\/session/,
    );
  });
  it("drops malformed persisted snapshots", () => {
    expect(
      sanitizeThreadSnapshot({
        entries: [
          { role: "assistant", text: 3 },
          { role: "tool", name: "x", text: "ok" },
        ],
      }),
    ).toEqual({ entries: [{ role: "tool", name: "x", text: "ok" }] });
  });
  it("builds Pi message parts and structured tool lifecycle entries without retaining private fields", () => {
    const snapshot = buildThreadSnapshot([
      sdk(
        "message_end",
        assistant([
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "answer" },
        ]),
      ),
      {
        type: "tool_execution_end",
        toolName: "read",
        args: { path: "/private/file" },
        result: { content: [{ type: "text", text: "ok" }] },
        nestedSessionPath: "/private/session",
      },
    ]);
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "thinking", text: "plan" }),
        expect.objectContaining({ role: "assistant", text: "answer" }),
        expect.objectContaining({
          role: "tool",
          name: "read",
          text: expect.stringContaining("ok"),
        }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain("nestedSessionPath");
  });
  it("round-trips one SDK lifecycle into one user and final assistant frame", () => {
    let snapshot = persistedAppend(
      undefined,
      sdk("message_start", message("user", "verify this", "user-1")),
    );
    snapshot = persistedAppend(
      snapshot,
      sdk("message_end", message("user", "verify this", "user-1")),
    );
    snapshot = persistedAppend(
      snapshot,
      sdk("message_start", assistant([], "assistant-1")),
    );
    for (const text of ["a", "ab", "answer"])
      snapshot = persistedAppend(
        snapshot,
        sdk("message_update", assistant(parts(text), "assistant-1")),
      );
    snapshot = persistedAppend(
      snapshot,
      sdk("message_end", assistant(parts("answer"), "assistant-1")),
    );
    snapshot = persistedAppend(snapshot, assistant("answer"));
    expect(snapshot.entries.filter((entry) => entry.role === "user")).toEqual([
      { role: "user", text: "verify this" },
    ]);
    expect(
      snapshot.entries.filter((entry) => entry.role === "assistant"),
    ).toEqual([{ role: "assistant", text: "answer" }]);
  });
  it("round-trips explicit assistant starts while SDK response IDs hydrate", () => {
    let snapshot = persistedAppend(
      undefined,
      sdk("message_start", { role: "assistant" }),
    );
    for (const [responseId, thinking] of [
      [undefined, "one"],
      ["hydrated-1", "two"],
      ["hydrated-2", "three"],
    ] as const)
      snapshot = persistedAppend(
        snapshot,
        sdk("message_update", {
          role: "assistant",
          responseId,
          content: [{ type: "thinking", thinking }],
        }),
      );
    expect(snapshot.frame?.started).toBe(true);
    snapshot = persistedAppend(
      snapshot,
      sdk("message_end", {
        role: "assistant",
        responseId: "hydrated-2",
        content: [
          { type: "thinking", thinking: "final plan" },
          { type: "text", text: "final" },
        ],
      }),
    );
    snapshot = persistedAppend(snapshot, assistant("final"));
    expect(snapshot.entries).toEqual([
      { role: "thinking", text: "final plan" },
      { role: "assistant", text: "final" },
    ]);
    expect(
      snapshot.entries.filter((entry) => entry.role === "assistant"),
    ).toHaveLength(1);
    expect(snapshot.frame?.id).toBe("hydrated-2");
    snapshot = persistedAppend(
      snapshot,
      sdk("message_start", assistant("final", "second")),
    );
    snapshot = persistedAppend(
      snapshot,
      sdk("message_end", assistant("final", "second")),
    );
    expect(
      snapshot.entries.filter((entry) => entry.role === "assistant"),
    ).toEqual([
      { role: "assistant", text: "final" },
      { role: "assistant", text: "final" },
    ]);
  });
  it("keeps update-only assistant frames separate when IDs differ", () => {
    let snapshot = persistedAppend(
      undefined,
      sdk("message_update", assistant("first", "one")),
    );
    snapshot = persistedAppend(
      snapshot,
      sdk("message_update", assistant("second", "two")),
    );
    expect(snapshot.entries).toEqual([
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second" },
    ]);
  });
  it("keeps only the latest multipart streamed assistant frame", () => {
    let snapshot: Snapshot | undefined;
    for (const text of ["a", "ab", "abc"])
      snapshot = append(
        snapshot,
        sdk("message_update", assistant(parts(text))),
      );
    expect(snapshot!.entries).toEqual([
      { role: "thinking", text: "plan" },
      { role: "assistant", text: "abc" },
    ]);
  });
  it("finalizes a streamed frame without collapsing separate assistant messages", () => {
    let snapshot = append(
      undefined,
      sdk("message_update", assistant(parts("partial"))),
    );
    snapshot = append(snapshot, sdk("message_end", assistant(parts("final"))));
    snapshot = append(snapshot, sdk("message_end", assistant("separate")));
    expect(snapshot.entries).toEqual([
      { role: "thinking", text: "plan" },
      { role: "assistant", text: "final" },
      { role: "assistant", text: "separate" },
    ]);
  });
  it("does not append the manager result already emitted by message_end", () => {
    let snapshot = append(
      undefined,
      sdk("message_update", assistant("partial", "m1")),
    );
    snapshot = append(snapshot, sdk("message_end", assistant("final", "m1")));
    snapshot = append(snapshot, assistant("final"));
    expect(snapshot.entries).toEqual([{ role: "assistant", text: "final" }]);
    snapshot = append(snapshot, assistant("separate raw result"));
    expect(snapshot.entries).toEqual([
      { role: "assistant", text: "final" },
      { role: "assistant", text: "separate raw result" },
    ]);
  });
  it("ignores turn and agent envelopes that repeat a terminal assistant message", () => {
    const final = assistant("final answer", "assistant-1");
    let snapshot = append(
      undefined,
      sdk("message_start", assistant("partial", "assistant-1")),
    );
    snapshot = append(
      snapshot,
      sdk("message_update", assistant("final", "assistant-1")),
    );
    for (const type of [
      "message_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ])
      snapshot = append(snapshot, sdk(type, final));
    snapshot = append(snapshot, assistant("final answer"));
    expect(
      snapshot.entries.filter((entry) => entry.role === "assistant"),
    ).toEqual([{ role: "assistant", text: "final answer" }]);
  });
  it("replaces only the active message frame when consecutive IDs stream", () => {
    let snapshot = append(
      undefined,
      sdk("message_update", assistant("first", "m1")),
    );
    for (const content of ["second", "second-more"])
      snapshot = append(
        snapshot,
        sdk("message_update", assistant(content, "m2")),
      );
    snapshot = append(snapshot, sdk("message_update", assistant("id-less")));
    expect(snapshot.entries).toEqual([
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second-more" },
      { role: "assistant", text: "id-less" },
    ]);
  });
  it("retains active-frame bounds after ENTRY_LIMIT tail slicing", () => {
    let snapshot = buildThreadSnapshot(
      Array.from({ length: 99 }, (_, index) => ({
        role: "user" as const,
        text: `prior-${index}`,
      })),
    );
    snapshot = append(
      snapshot,
      sdk("message_update", assistant("first", "m1")),
    );
    for (const content of ["second", "second-more"])
      snapshot = append(
        snapshot,
        sdk("message_update", assistant(content, "m2")),
      );
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries.slice(-2)).toEqual([
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second-more" },
    ]);
  });
  it("resumes stream coalescing after a serialization boundary", () => {
    let snapshot = append(
      undefined,
      sdk("message_update", assistant("partial", "m1")),
    );
    snapshot = sanitizeThreadSnapshot(JSON.parse(JSON.stringify(snapshot)));
    snapshot = append(
      snapshot,
      sdk("message_update", assistant("later", "m1")),
    );
    expect(snapshot.entries).toEqual([{ role: "assistant", text: "later" }]);
  });
  it("keeps identical replies from separate lifecycles and rejects malformed persisted markers", () => {
    let snapshot: Snapshot | undefined;
    for (const id of ["one", "two"]) {
      snapshot = append(snapshot, sdk("message_start", assistant("same", id)));
      snapshot = append(snapshot, sdk("message_end", assistant("same", id)));
    }
    expect(
      snapshot!.entries.filter((entry) => entry.role === "assistant"),
    ).toEqual([
      { role: "assistant", text: "same" },
      { role: "assistant", text: "same" },
    ]);
    expect(
      sanitizeThreadSnapshot({
        entries: snapshot!.entries,
        frame: {
          role: "assistant",
          phase: "terminal",
          id: "x".repeat(500),
          terminalText: "SECRET /private/path",
          start: -1,
          count: 1,
          definition: { instructions: "SECRET" },
        },
      }),
    ).toEqual({ entries: snapshot!.entries });
  });
  it("keeps persisted lifecycle markers bounded and path-free", () => {
    const snapshot = append(
      undefined,
      sdk("message_end", assistant("answer", "m".repeat(500))),
    );
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.frame).toMatchObject({
      role: "assistant",
      phase: "terminal",
      start: 0,
      count: 1,
      terminalText: "answer",
    });
    expect(snapshot.frame?.id?.length).toBe(120);
    expect(serialized).not.toMatch(
      /definition|instructions|nestedSessionPath|filePath/,
    );
  });
  it("keeps streamed frames separated by tools and repeated tool calls", () => {
    let snapshot = append(
      undefined,
      sdk("message_update", assistant("partial")),
    );
    snapshot = append(snapshot, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "one" },
    });
    snapshot = append(snapshot, sdk("message_end", assistant("after tool")));
    snapshot = append(snapshot, {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: "again",
    });
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        { role: "assistant", text: "partial" },
        {
          role: "tool",
          name: "bash",
          toolCallId: "call-1",
          text: 'args: {"command":"one"}',
        },
        { role: "assistant", text: "after tool" },
        { role: "tool", name: "bash", toolCallId: "call-2", text: "again" },
      ]),
    );
  });
  it("merges repeated tool lifecycle and streamed assistant updates into one entry each", () => {
    let snapshot = append(undefined, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "compact" },
    });
    snapshot = append(snapshot, {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      partialResult: "working",
    });
    snapshot = append(snapshot, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: "complete",
    });
    snapshot = append(snapshot, sdk("message_update", assistant("partial")));
    snapshot = append(snapshot, sdk("message_end", assistant("final answer")));
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        role: "tool",
        name: "bash",
        toolCallId: "call-1",
        text: expect.stringContaining("complete"),
      }),
      { role: "assistant", text: "final answer" },
    ]);
  });
});
