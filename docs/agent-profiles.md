# Agent profiles and configuration

Agent profiles assign model and thinking-effort routes to the parent Pi session and to individual subagents. This guide covers configuration scope, the complete profile schema, the assignment panel, and rollback behavior.

## Configuration scope and trust

Global configuration is stored at `<getAgentDir()>/pi-agent-profiles/config.json`. A trusted project may add `<cwd>/<CONFIG_DIR_NAME>/pi-agent-profiles/config.json`.

Project configuration is never read or written unless Pi reports the project as trusted. Effective configuration merges global and trusted-project profiles. A same-name project profile replaces the complete global profile; profile fields are not merged individually. `shortcut` always comes from global configuration, so a project cannot override it.

## Complete schema

```json
{
  "version": 1,
  "shortcut": "alt+p",
  "defaultProfile": "review work",
  "cycle": ["review work", "fast"],
  "profiles": {
    "review work": {
      "order": 10,
      "orchestrator": {
        "model": { "provider": "anthropic", "id": "claude-sonnet" },
        "effort": "medium"
      },
      "defaultRoute": {
        "model": null,
        "effort": "inherit"
      },
      "agents": {
        "researcher": {
          "model": { "provider": "openai", "id": "gpt-4.1" },
          "effort": "high"
        }
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Required schema version; currently `1`. |
| `shortcut` | Optional global cycling shortcut. Defaults to `alt+p` and is registered when the extension is created. |
| `defaultProfile` | Optional profile activated when a session has no stored active/off marker. It must name an existing profile. |
| `cycle` | Optional unique list of existing profile names used by `next` and the shortcut. |
| `profiles` | Required map of arbitrary nonempty profile names to profile definitions. |
| `order` | Required integer used to order profiles when `cycle` is absent. A new panel draft receives the next order. |
| `orchestrator` | Optional route applied to the parent Pi session while the profile is active. |
| `defaultRoute` | Optional route for agents without a named override. |
| `agents` | Optional map of agent names to route overrides. Keys are trimmed, normalized to lowercase, and must be unique after normalization. |

A route must contain `model`, `effort`, or both. A model is `{ "provider": "...", "id": "..." }`. Valid efforts are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

`model: null` and `effort: "inherit"` are persisted suppression sentinels. In an agent override they remove the corresponding default-route field, causing the consumer/runtime value to be inherited. They are configuration-only and are never sent through an event or stored in an active route snapshot.

## Commands

`/agent-profiles` opens the assignment panel. These textual commands remain available:

| Command | Action |
| --- | --- |
| `/agent-profiles list` | List configured profiles. |
| `/agent-profiles status` | Show the active profile or `off`. |
| `/agent-profiles use <name>` | Activate a profile. |
| `/agent-profiles next` | Activate the next profile in `cycle` or order. |
| `/agent-profiles create` | Open the inline profile-name editor. |
| `/agent-profiles edit <name>` | Open and focus an existing profile. |
| `/agent-profiles delete <name>` | Confirm and delete a saved profile. |
| `/agent-profiles off` | Restore the session baseline and deactivate routing. |

## Assignment panel

Top tabs follow profile-manager order. `Tab` and `Shift+Tab` wrap through profiles and the final `+ new` tab. Tabs show `G`/`P` scope, `*` for active, and a dot for an unsaved draft.

| Key | Action |
| --- | --- |
| `Up` / `Down` / `j` / `k` | Move between selectable assignments; group headings are skipped. |
| `Enter` / `M` | Open the selected assignment's model picker. |
| `E` | Open the selected assignment's effort picker. |
| `R` | Reset the selected assignment; on a bulk row, remove that group's overrides. |
| `S` | Save the current profile. |
| `A` | Save a dirty profile, then activate it. |
| `N` or `+ new` + `Enter` | Create an in-memory draft. |
| `Del` | Delete the current draft or confirm deletion of a saved profile. This is forward Delete, not Backspace. |
| `Esc` / `q` | Return from a picker or close the assignment view. |

The compact list shows `label  model=<effective value>, effort=<effective value>` for Orchestrator, Default agents, and grouped `sdd-*`, `jd-*`, `review-*`, and Other agents. Each nonempty group has a `Set all ...` row. `Enter` or `M` changes only that group's model; `E` changes only its effort. Pickers replace the assignment body inside the same overlay and use the same navigation keys.

Creating a profile opens an inline name editor and then a scope screen. `Esc` returns from scope to name and from name to `+ new`. Empty or duplicate names are inline errors. Global scope is always available; Project scope appears only for a trusted project. Confirmation creates a dirty in-memory draft without writing storage.

Closing with dirty drafts asks whether to discard them. Deleting an unsaved draft changes memory only; deleting a saved profile requires confirmation. A durable save must succeed before effective in-memory configuration changes.

## Shortcut behavior

The global cycling shortcut defaults to `alt+p`. Invalid global shortcuts fall back to that value and are reported at `session_start`. Shortcut changes require a restart or `/reload` because Pi registers shortcuts at extension construction.

An existing generated `ctrl+tab` default resolves to `alt+p` after reload and is written as `alt+p` on the next durable profile save. Other explicit shortcut values are preserved. `order` affects `/agent-profiles next` and shortcut cycling only when `cycle` is not configured.

### Terminal shortcut troubleshooting

`alt+p` is a two-key terminal-safe default selected because the old default is terminal-owned in common terminals.

## Session behavior and rollback

The first profile activation captures the session's pre-profile model and effort as its baseline. Switching profiles keeps that original baseline and restores omitted, `null`, or `inherit` parent-route fields from it.

If activation or switching fails, the manager attempts to restore the previous active parent route and snapshot; on initial activation it restores the captured baseline. If `/agent-profiles off` cannot restore the baseline, deactivation is not persisted and the profile remains active.

Active and off markers are persisted in the Pi session branch. A rebound extension restores the latest valid marker on `session_start`. The exact event, validation, and lifecycle rules are in the [session routing contract](session-routing-contract.md).
