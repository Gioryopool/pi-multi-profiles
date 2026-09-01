# pi-multi-profiles

Named, session-scoped routing profiles for Pi, with a self-contained runtime for running markdown-defined subagents in the foreground or background.

> **Security:** Pi extensions execute with full system access. Install only code you trust, and review project configuration before trusting a project.

## Install

To install a release published on npm:

```bash
pi install npm:pi-multi-profiles
```

Use GitHub only to try the current unreleased code:

```bash
pi install git:github.com/Gioryopool/pi-multi-profiles
```

Restart Pi or run `/reload` after installation or configuration changes.

## Quick start

Create `<getAgentDir()>/pi-agent-profiles/config.json`:

```json
{
  "version": 1,
  "defaultProfile": "review",
  "profiles": {
    "review": {
      "order": 10,
      "orchestrator": { "effort": "high" },
      "agents": {}
    }
  }
}
```

`defaultProfile` loads the named profile when a new Pi session starts. In the panel, `◆` marks the active session profile; press `D` on a profile to set that scope's startup default, while `A` activates only the current session.

Reload Pi, then open `/agent-profiles` or activate the profile directly:

```text
/agent-profiles use review
```

Trusted projects may add project-scoped profiles. Project configuration is never read or written unless Pi reports that project as trusted.

## What it provides

- Named profiles that route the parent model/effort and per-agent model/effort independently.
- A consolidated keyboard-driven panel for creating, editing, saving, activating, cycling, and deleting profiles.
- Markdown-defined subagents with exact-session foreground/background execution, live messaging, cancellation, handoff, and continuation.
- A session-isolated history panel, active-task widget, bounded completion cards, and package-owned SQLite history.
- Safe route rollback and restoration of active/off state when a Pi session is rebound.
- Optional synchronous compatibility events for external runtimes, without making them a dependency.

## Controls

### Agent profiles

| Control | Action |
| --- | --- |
| `/agent-profiles` | Open the profile assignment panel. |
| `alt+p` | Cycle through configured profiles. |
| `Tab` / `Shift+Tab` | Move between profile tabs and `+ new`. |
| `Up` / `Down` / `j` / `k` | Move through assignments. |
| `Enter` / `M` / `E` | Edit the selected model or effort. |
| `S` / `A` / `D` | Save, save and activate for this session, or set the startup default for the profile's scope. |
| `N` / `R` / `Del` | Create, reset, or delete. |
| `Esc` / `Q` | Return or close the panel. Lowercase `q` also works. |

### Subagents

| Control | Action |
| --- | --- |
| `/subagents` / `alt+o` | Open execution history. |
| `Up` / `Down` / `Enter` | Select a task and open its details. |
| `ctrl+o` / `ctrl+t` | Toggle tool output or thinking. |
| `ctrl+h` | Hand foreground work to the background. |
| `x` | Cancel the selected queued or running task. |
| Double `Esc` | Cancel active work for the current parent session. |

See [Agent profiles and configuration](docs/agent-profiles.md) and [Subagent runtime](docs/subagent-runtime.md) for complete commands, configuration, and control behavior.

## Terminal shortcut troubleshooting

The two-key defaults are terminal-safe: `alt+p` and `alt+o` were selected because the old defaults are terminal-owned in common terminals.

## Compatibility and limits

This beta package requires Node.js 22.19.0 or newer. Its subagent runtime is standalone: it has no Joker imports and does not read Joker history or storage. When `pi-subagents-j0k3r` is installed through Pi's managed user or project npm root, this extension registers `agent_profiles_subagent_*` aliases regardless of package order; without that evidence it registers the canonical `subagent_*` names.

Pi does not expose active package or tool enumeration to extensions. A disabled managed npm installation can therefore still select aliases, while git, local-path, legacy global npm, and temporary Joker installations are not detected by package presence. See [Subagent runtime](docs/subagent-runtime.md#compatibility-ownership) for the exact boundary.

Model-visible task results are capped at 16,000 characters. History, messaging, continuation, shortcut, trust, and session-ownership limits are documented in [Subagent runtime](docs/subagent-runtime.md).

### Coexistence with Joker

`pi-multi-profiles` can run alongside `pi-subagents-j0k3r`, but the two packages do not share execution ownership. With a managed Joker installation present, normal orchestrators such as Gentle AI call Joker through the canonical `subagent_*` tools. The active `pi-multi-profiles` profile can still provide Joker with the model and effort assigned to each agent through the compatible model-route event. Switching profiles affects subsequent delegations, not tasks already running.

This package's standalone runtime remains registered under `agent_profiles_subagent_*`, but normal orchestrators do not select those aliases automatically. They are available only to prompts, agents, or extensions that explicitly invoke them. Remove Joker if you want this package's runtime to own the canonical `subagent_*` tools used by normal delegation.

Pi may also report expected extension issues when both packages register the same shortcuts. This does not prevent Pi from starting or either runtime from loading.

| Startup message | Effect |
| --- | --- |
| `Extension shortcut conflict` for `alt+o` or `ctrl+h` | Only one handler can own each shortcut. When Pi says it is using `pi-multi-profiles/index.ts`, these keys open this package's history panel and hand off this package's foreground task; they do not invoke Joker's corresponding handlers. |
| Tools registered with the `agent_profiles_subagent_` namespace | Joker owns the canonical `subagent_*` names, so normal delegation runs through Joker. This package's runtime remains available only through explicit calls to its aliases. |

The namespace message is a compatibility notice, not a failure. The shortcut message has a real but limited consequence: the handler named by Pi wins that key binding. Keep both packages when you want Joker to execute normal delegations while active profiles control their model and effort routing. Otherwise, install only one subagent runtime to avoid duplicated functionality and startup notices.

## Acknowledgements

This project owes meaningful inspiration to [**pi-subagents-j0k3r**](https://github.com/j0k3r-dev-rgl/pi-subagents-j0k3r) by [j0k3r](https://github.com/j0k3r-dev-rgl). Runtime and presentation behavior was independently adapted from that project under the MIT License. Thank you to j0k3r for making that work available.

This package remains self-contained and uses its own naming, storage, and runtime implementation; it does not import, bundle, claim ownership of, or provide support for Joker. See [Third-party notices](THIRD_PARTY_NOTICES.md) for the exact provenance and complete MIT notice.

## Documentation

- [Agent profiles and configuration](docs/agent-profiles.md)
- [Subagent runtime](docs/subagent-runtime.md)
- [Session routing compatibility contract](docs/session-routing-contract.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [MIT license](LICENSE)
