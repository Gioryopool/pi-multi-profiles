# Subagent runtime

The package includes a neutral, self-contained runtime for markdown-defined subagents. It owns its execution sessions, public projections, completion messages, and SQLite history; it does not import Joker code or read Joker storage.

## Agent discovery

Definitions are loaded in this order, with later valid definitions replacing earlier same-name definitions:

1. `<getAgentDir()>/agents/*.md`
2. `<getAgentDir()>/subagents/*.md`
3. `<cwd>/.pi/agents/*.md` for trusted projects
4. `<cwd>/.pi/subagents/*.md` for trusted projects

Names are normalized to lowercase. A malformed later definition blocks the same normalized earlier definition rather than silently falling back. Diagnostics report unreadable files, ambiguous `tools` frontmatter, invalid `subagent_mode`, and duplicate names.

A definition may use this frontmatter:

```markdown
---
name: researcher
description: Investigates a bounded question
tools: read, memory_search, memory_get
model: openai/gpt-4.1
effort: high
subagent_mode: task
---

Instructions for the isolated subagent session.
```

`tools` may instead be a YAML-style list, but inline and list forms cannot be mixed. Delegation tools beginning with `subagent_` or `agent_profiles_subagent_` are always removed to prevent recursive delegation. Model format is `provider/id`; efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; mode is `task` or `background`.

## Compatible runtime configuration

The runtime reads existing global `<getAgentDir()>/subagents.json` and trusted-project `<cwd>/.pi/subagents.json` files. It never writes them. Project values override global values field by field.

```json
{
  "default_model": "openai/gpt-4.1",
  "default_effort": "medium",
  "timeout_ms": 1200000,
  "stall_timeout_ms": 240000,
  "max_concurrency": 5,
  "default_tools": ["read", "memory_context", "memory_search", "memory_recall", "memory_get"],
  "session_resources": "lean",
  "default_mode": "task",
  "history_limit": 100,
  "enable_continue": true,
  "background_handoff_shortcut": "ctrl+h",
  "history_panel_shortcut": "alt+o",
  "detail_cancel_shortcut": "x",
  "model_profiles": {
    "researcher": { "model": "openai/gpt-4.1", "effort": "high" }
  }
}
```

| Field | Default and constraint |
| --- | --- |
| `default_model` | Current orchestrator model; accepts `provider/id` or `{ "provider", "id" }`. |
| `default_effort` | Current orchestrator effort; aliases `default_thinking_level` and `thinkingLevel` are accepted. |
| `timeout_ms` | `1200000`; positive integer total task timeout. |
| `stall_timeout_ms` | `240000`; positive integer inactivity timeout. |
| `max_concurrency` | `5`; positive integer. |
| `default_tools` | Five read/memory tools shown above; must be a nonempty-string array. Recursive delegation tools are removed. |
| `session_resources` | `lean`; accepts `lean` or `full`. |
| `default_mode` | `task`; accepts `task` or `background`. |
| `history_limit` | `100`; positive integer rows retained per parent session. |
| `enable_continue` | `true`; only explicit `false` disables continuation execution. |
| `background_handoff_shortcut` | `ctrl+h`; trusted-project overrides must be `ctrl+` plus one letter. Reload after changing it. |
| `history_panel_shortcut` | `alt+o`; the old `ctrl+,` value normalizes to it, and other values are unsupported because Pi registers the global shortcut at construction. Project overrides are not applied. |
| `detail_cancel_shortcut` | `x`; must be one letter. |
| `model_profiles` | `{}`; normalized per-agent routes. Project profiles apply only to project definitions and global profiles only to global definitions. |

Effective model and effort resolve independently: active agent profile route, matching `model_profiles` entry, definition frontmatter, runtime default, then current orchestrator route.

## Tools and execution modes

The canonical tool catalog contains:

- `subagent_list_agents`
- `subagent_run`
- `subagent_status`
- `subagent_result`
- `subagent_list_tasks`
- `subagent_cancel`
- `subagent_send_message`
- `subagent_continue`

When another compatible runtime already owns those names, the same catalog is registered once with the `agent_profiles_subagent_*` prefix.

Each selected agent resolves mode independently. An invocation `mode` overrides every selected member; otherwise `subagent_mode` and then `default_mode` apply. A mixed multi-agent run waits only for task-mode members and returns background task IDs immediately.

Foreground calls return the bounded result or error to the parent model. Model-visible task text is capped at 16,000 characters, so expanded cards cannot recover text beyond that retained boundary. Calls and results use compact colored cards; responses and errors are collapsed by default and `ctrl+o` expands them.

Background launch returns immediately. While exact-session work is queued or running, a below-editor widget lists main and each task's status/current activity. Navigation starts only from an empty editor: `Down`/`Up` navigate; `Enter` on a task opens its history detail, while `Enter` on main returns to editor input. The widget disappears when no active work remains and does not capture input while the history panel is open.

Terminal background completion sends exactly one Pi follow-up with a collapsed package-owned card. Its model-visible content contains the bounded final response once. Card details exclude definitions, paths, parent-session identifiers, and raw runtime state.

## History panel

`alt+o` is a two-key terminal-safe default selected because the old `ctrl+,` default is terminal-owned in common terminals.

`/subagents` opens a full-width, parent-session-isolated history panel; `alt+o` opens the same panel globally. The execution strip follows the focused task, and the detail view supports arrow keys, Page Up/Down, Home/End, and mouse-wheel scrolling. Opening the overlay enables terminal mouse tracking; closing or disposing it restores terminal mode.

The header shows public agent, status, attempt, mode, model, effort, ID, duration, usage, context/activity summaries, and configured timeout/stall hints. Structured task, activity, and thread rows retain the final response. `ctrl+o` toggles tool output, `ctrl+t` toggles thinking, and `x` or `detail_cancel_shortcut` cancels only the selected queued/running task.

The panel reads a bounded, sanitized exact-session timeline. It never renders agent definitions, instructions, nested-session paths, parent-session identifiers, or private runtime fields. Running cards show a bounded completed activity trail and one explicit current activity, refreshing approximately every 500 ms. Parent live cards prefer up to three bounded standalone bold semantic-heading summaries authored by the nested assistant in thinking/reasoning updates; only the last heading in each update is considered. Unsafe headings are rejected, and safe generic activity fallbacks are used until semantic headings exist. Tool arguments, paths, full reasoning, and final assistant text never feed the parent card; `/subagents` retains the detailed thread.

History is stored at `<getAgentDir()>/pi-agent-profiles/runtime/history.sqlite`; old Joker history is never read or imported. Rows are parent-session isolated and pruned to the newest `history_limit` rows per parent session. Stale in-progress work is marked interrupted after restart. Persistence is best effort: runtime execution remains available if history storage cannot be opened.

## Messaging, handoff, and cancellation

Live messages are bounded and accepted only for an active task owned by the exact parent session. They require Pi nested-session steering support and may queue until that bridge is ready. Queue acceptance does not prove model consumption, and undelivered messages are not replayed into a later attempt.

`ctrl+h` hands exact-session foreground work to background mode without aborting its nested session. A compatible global shortcut may use Pi-supported modifier combinations; a trusted-project override must be `ctrl+` plus one letter. Pi registers the global chord at construction, while a supported session-scoped terminal-input subscription matches a trusted-project override only for its active foreground session.

A double Escape delivered through that same exact-session subscription cancels active work only for that parent session. The history-panel cancel key affects only the selected queued/running task.

## Continuation

Continuation requires a terminal task, a valid package-owned nested-session file, and Pi `SessionManager.open`. It creates a new attempt in the same task lineage. Unsafe, missing, or unsupported session files return a clear error.

`subagent_continue` accepts an optional `mode: task|background`. Mode resolves from the explicit input, previous effective mode, then `default_mode`. A background continuation returns its task ID immediately and sends one terminal follow-up when complete.

The tool remains registered to keep the eight-tool catalog stable, but execution is rejected when effective `enable_continue` is `false`. Unlike the referenced Joker behavior, this package enables continuation when that field is absent; only explicit global or trusted-project `false` disables it.

## Compatibility ownership

`pi-subagents:model-route:v1` is an optional route adapter for an externally loaded compatible runtime. The neutral `pi-subagents:agents:v1` catalog event is emitted once, synchronously, at construction as a compatibility probe. External catalog data is used only when internal discovery is unavailable. Repeated or late replies are ignored or diagnosed. Joker 1.5.4 does not implement this event.

Before registering tools, the extension checks only Pi's managed npm package locations: `<getAgentDir()>/npm/node_modules/pi-subagents-j0k3r/package.json` and `<cwd>/.pi/npm/node_modules/pi-subagents-j0k3r/package.json`. Presence at either location selects the eight `agent_profiles_subagent_*` aliases, independent of settings order. With no installed-package signal, compatible responder, or existing package-local owner, it registers eight canonical `subagent_*` tools. It does not read Joker source, configuration, history, or storage.

Pi 0.84.2 exposes neither active-package enumeration nor registered-tool lookup to extensions. Detection therefore has explicit limits: a disabled Joker package left in a managed npm root still selects aliases; git, local-path, legacy global npm, and temporary installs are not detected by package presence. Those installation forms avoid a conflict only when the other runtime participates in the synchronous compatibility probe or package-local owner contract. Joker 1.5.4 does neither, so those forms are not claimed as automatically compatible.

Catalog events require nonempty `name`, `description`, and `scope` strings. Names are normalized to lowercase and duplicates are rejected case-insensitively. Event routes never contain profile persistence sentinels.

The compatibility event details are specified in the [session routing contract](session-routing-contract.md). Adapted behavior provenance and licensing are in [Third-party notices](../THIRD_PARTY_NOTICES.md).
