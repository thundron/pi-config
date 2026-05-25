# pi-config

Personal pi-coding-agent setup. Tracks the parts of `~/.local/bin/` and
`~/.pi/` that I want backed up across machines.

This is **not** a fork of [earendil-works/pi-mono]; it's dotfiles. Pi is
installed normally via `npm install -g @earendil-works/pi-coding-agent`
(or `brew install`); this repo overlays a wrapper, a couple of config
files, and my personal extensions on top.

## Install on a fresh machine

```bash
git clone git@github.com:thundron/pi-config.git ~/dev/pi-config
~/dev/pi-config/install.sh
```

The installer is **idempotent and cross-platform** (macOS, Linux, WSL).
It symlinks each tracked file into its expected location, backing up any
pre-existing real file to `*.pre-symlink.<ts>` first. Re-running it is
always safe — already-correct links report `ok`.

After install, ensure `~/.local/bin` is on `$PATH` ahead of the real pi
binary:

```bash
# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Verify the wrapper is in front:

```text
$ which -a pi
~/.local/bin/pi             ← this wrapper (symlink into ~/dev/pi-config/bin/pi)
/path/to/real/pi            ← the npm/brew-installed binary
```

The wrapper auto-detects the real binary by walking `$PATH` and picking
the first `pi` that isn't itself. Override with `PI_REAL=...` if it
picks wrong.

Optional fleet tooling (separate project, install only if you use it):

```bash
# pip / pipx / etc — see https://github.com/thundron/pi-fleet
```

The `fleet-citizen.ts` extension and `pi-fleet` skill tracked here are
useful only once `pi-fleet` itself is installed.

## What's tracked, where it lives, and how it's synced

### Symlinks (edit either side, it's the same file)

| Live path                                            | → | Repo path                                  |
| ---------------------------------------------------- | --- | ---------------------------------------- |
| `~/.local/bin/pi`                                    | → | `bin/pi`                                 |
| `~/.pi/agent/system-prompt.txt`                      | → | `agent/system-prompt.txt`                |
| `~/.pi/agent/extensions/fleet-citizen.ts`            | → | `agent/extensions/fleet-citizen.ts`      |
| `~/.pi/agent/extensions/goal-mode.ts`                | → | `agent/extensions/goal-mode.ts`          |
| `~/.pi/agent/extensions/goal-mode.README.md`         | → | `agent/extensions/goal-mode.README.md`   |
| `~/.pi/agent/extensions/subagents.ts`                | → | `agent/extensions/subagents.ts`          |
| `~/.pi/agent/extensions/subagents.README.md`         | → | `agent/extensions/subagents.README.md`   |
| `~/.pi/agent/extensions/codex-cli-extras.ts`         | → | `agent/extensions/codex-cli-extras.ts`   |
| `~/.pi/agent/skills/claude-code/SKILL.md`            | → | `agent/skills/claude-code/SKILL.md`      |
| `~/.pi/agent/skills/subagents/SKILL.md`              | → | `agent/skills/subagents/SKILL.md`        |

### Copy (pi rewrites it at runtime; cannot be a symlink)

| Live path                          | ↔ | Repo path              | Notes                       |
| ---------------------------------- | --- | -------------------- | ------------------------- |
| `~/.pi/agent/settings.json`        | ↔ | `agent/settings.json`  | pi bumps `lastChangelogVersion` on its own; sync manually when you change a real setting |

The installer warns on drift for the copy case (it never clobbers).
Reconcile by hand: `cp <live> <repo>` or the other direction, depending
on which side is canonical.

## What's in here

### `bin/pi`

PATH-shadow wrapper. Forwards subcommands (`install`, `update`, `auth`,
…) untouched, but for actual chat invocations injects
`--system-prompt "$(cat ~/.pi/agent/system-prompt.txt)"` before
exec-ing the real pi binary. The injection is what makes Anthropic's
OAuth billing classifier treat the request as Claude Code rather than
a third-party app on accounts that don't have overage credit
configured.

Auto-detects the real `pi` binary by walking `$PATH` and skipping
itself, so it's portable across `/home/linuxbrew/.linuxbrew/bin/pi`
(WSL/Linuxbrew), `/opt/homebrew/bin/pi` (Apple Silicon), and
`/usr/local/bin/pi` (Intel macOS / npm install).

Escape hatches:

- `PI_NO_SPOOF=1 pi …` — one-off bypass.
- `PI_REAL=/path/to/pi pi …` — override the auto-detected real binary.
- `rm ~/.local/bin/pi` — permanent disable; falls back to the real
  binary.
- Edit `~/.pi/agent/system-prompt.txt` if Anthropic ever rotates the
  fingerprint.

The wrapper also steps aside automatically when you pass your own
`--system-prompt` or `--system-prompt-file`.

### `agent/system-prompt.txt`

The one line the wrapper injects:

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

### `agent/extensions/guardian.ts` (+ `fleet-citizen.ts` back-compat stub)

Loaded inside every pi sub-agent child (whether spawned by `subagents.ts`
or by the legacy [pi-fleet][pi-fleet] Python supervisor) to enforce
identity, agent-role, execution policy, and ritual workflow. Renamed from
`fleet-citizen.ts` and restructured into 5 codex-shaped sections:

1. **identity** — reads `PI_GUARDIAN_RUN_ID` / `PI_GUARDIAN_AGENT_ID` /
   `PI_GUARDIAN_RUN_DIR` / `PI_GUARDIAN_AGENT_DIR` env vars (with legacy
   `PI_FLEET_*` fallback) to know who this child is.
2. **agent-role** (codex `core/src/agent/role.rs` analog) — when
   `PI_GUARDIAN_ROLE` is set, loads `~/.pi/agent/roles/<name>.json` and
   layers its `developer_instructions` into the child's system prompt.
   Sample role `agent/roles/awaiter.json` ported verbatim from codex's
   `awaiter.toml`.
3. **execpolicy** (codex `execpolicy/` analog) — prefix-rule based
   tool-call blocker. Built-in defaults port the legacy bash regex
   guardrails (`find /`, `git push`, `rm -rf /`, etc.) into
   codex-shaped rules. User rules at `~/.pi/agent/execpolicy.json` layer
   on top; sample at `agent/execpolicy.example.json`.
4. **banned-phrases** — Lorenzo-specific assistant-text scanner (no codex
   equivalent). Auto-steers on hit, aborts after 3 hits.
5. **rituals** — `/done`, `/halt`, `/guardian` (new name) + `/fleet`
   (legacy alias for muscle memory).

`fleet-citizen.ts` is a one-line delegating stub kept in the repo because
pi-fleet's Python supervisor hardcodes that path (`supervisor.py:265`).
The `guardian()` factory itself owns a load-once sentinel so loading both
files is harmless — the first registration wins.

[pi-fleet]: https://github.com/thundron/pi-fleet

### `agent/extensions/goal-mode.ts` (+ README)

Ports OpenAI Codex's `/goal` primitive to pi as a pure extension. A
"goal" is a persistent objective that survives across turns: after each
agent loop settles, pi automatically re-engages the assistant with the
objective + remaining token budget so it keeps making progress without
the user typing "continue". The model can mark itself complete or
blocked via the registered `update_goal` tool, and a token budget
protects against runaway cost. See the sidecar README for the full
slash-command surface and design notes.

### `agent/skills/claude-code/SKILL.md`

Pi's claude-code skill with a trigger-rich `description` in the
frontmatter so the harness loads it automatically on coding-task
prompts (refactor / fix bug / review PR / multi-turn coding) rather
than only when invoked via `/claude-code`. Body is unchanged from
upstream.

### `agent/extensions/subagents.ts` (+ README)

Ports OpenAI Codex's `multi_agents` tool family (`subagent_spawn` /
`subagent_wait` / `subagent_list` / `subagent_close`) and the
`/subagents` slash command to pi. The **parent pi session dispatches
sub-agents as part of its own reasoning** by calling tools, replacing
the legacy [pi-fleet][pi-fleet] Python supervisor's manifest-driven
workflow. Sidesteps the upstream `pi --mode rpc` stream-handling bug
by spawning sub-agents as one-shot `pi -p --mode json` subprocesses.

State layout (`~/.pi/fleet/runs/<runId>/`) is preserved for backward
compatibility with the legacy `pi-fleet status / watch / tmux /
replay / reap` CLI commands. The manifest `fire` flow is reinstated
as `/subagents fire <manifest.json>`, so existing
`phase7.fleet.json`-style manifests keep working.

Naming aligns with industry standards (Anthropic Claude Code
"Subagents"; codex `/subagents` slash command). See the sidecar
README for the full tool surface, parameter shapes, and brief-writing
rules.

[pi-fleet]: https://github.com/thundron/pi-fleet

### `agent/skills/subagents/SKILL.md`

Teaches the agent when and how to dispatch sub-agents via the
`subagent_*` tools above — patterns for parallel implementation,
fan-out investigation, isolated long-running builds, and the
self-contained-brief rule (sub-agents inherit none of your session
state).

### `agent/extensions/codex-cli-extras.ts`

Grab-bag of small codex slash-command ports tracked in
[`PORT-PLAN.md`](./PORT-PLAN.md). Currently:

- `/diff` — `git diff` of tracked + untracked changes (ports
  `codex-rs/tui/src/get_git_diff.rs`).
- `/init` — generate `AGENTS.md` with project context (ports
  `codex-rs/tui/prompt_for_init_command.md`); guards against
  overwriting an existing file.
- `/review` — review code changes (ports `codex-rs/core/src/review_prompts.rs`).
  Usage: `/review` (uncommitted) / `/review base <branch>` / `/review commit <sha>` /
  `/review <free-text>`. Computes merge-base + commit titles automatically.
- `/rollout` — print the current session's JSONL rollout path.
- `/feedback` — print feedback channels + attachable context.
- `/test-approval` — exercise pi's `ctx.ui.confirm` + `ctx.ui.select` dialog APIs.

### `agent/extensions/side-conversation.ts`

Ports codex's `/side` + `/btw` ephemeral side-conversation pattern. A side
conversation forks the current thread into a separate session where inherited
history is treated as reference-only via a boundary prompt embedded verbatim
from `codex-rs/tui/src/app/side.rs`. Commands:

- `/side [text]` — fork the current state into an ephemeral side session,
  inject the codex boundary prompt, and (optionally) your first question.
- `/btw [text]` — codex alias for `/side`.
- `/return` — switch back to the parent session. Replaces codex's `Ctrl+C
  to return` shortcut (pi extensions can't sensibly rebind Ctrl+C).

### `agent/extensions/plan-mode.ts`

Ports codex's `/plan` collaboration mode. Embeds codex's
`collaboration-mode-templates/templates/plan.md` verbatim and injects it as a
synthetic context message before every LLM call while plan mode is active.
When toggled on, restricts the active tool set to read-mostly (`read`, `bash`,
`grep`, `find`, `ls`) and stashes the previous tool list. `/execute` exits and
restores the previous tools. State persists across session resumes via
`custom_message` entries on the branch.

### `agent/extensions/memories.ts`

Ports a focused subset of codex's `/memories` feature — a persistent
cross-session registry at `~/.pi/memories/MEMORY.md`. Registers `memory_save`
and `memory_recall` as model-callable tools, plus a `/memories` slash command
with `add` / `where` / `clear` subcommands. When the registry is non-empty, a
small context hint is prepended to every LLM call pointing the model at the
tools (paraphrased from `codex-rs/memories/read/templates/memories/read_path.md`).
v0 deliberately skips codex's rollout-extraction and consolidation pipelines
— those are documented in the extension header as deferred.

### `agent/extensions/personality.ts`

Ports codex's `/personality` slash command and its two communication-style
presets (`friendly`, `pragmatic`). Templates are embedded verbatim from
`codex-rs/core/templates/personalities/gpt-5.2-codex_{friendly,pragmatic}.md`
and injected into context on every LLM call when active. Usage:
`/personality` (list + show current), `/personality friendly|pragmatic` (set),
`/personality off` (clear). State persists across session resumes via
`custom_message` entries on the branch.

### `agent/extensions/introspection.ts`

Grab-bag for codex introspection slash commands. Currently:

- `/hooks` — list all 29 pi extension lifecycle events grouped by category,
  with per-session fire counts (`×N` badges). `/hooks all` for full descriptions,
  `/hooks reset` to zero the counts. Codex's static hook-declarations browser
  doesn't map cleanly to pi's extension event model (pi extensions subscribe via
  `pi.on(event, handler)` rather than TOML declarations), so this port surfaces
  live activity instead — useful when debugging extensions or learning what's
  fireable from a handler.
- `/tools` / `/mcp` — enumerate every registered tool grouped by source
  extension, with `●` active / `○` inactive markers and an optional substring
  filter. `/mcp` is an alias because pi treats MCP-sourced tools the same as
  any other extension tool (ports `codex-rs/tui/src/chatwidget.rs add_mcp_output`).
- `/debug-config` — dump runtime state (model, thinking level, cwd, session
  id+file), settings layers (global + project) with their top-level keys,
  every loaded extension and its slash commands, and pi/codex-related env
  vars (ports `codex-rs/tui/src/chatwidget.rs add_debug_config_output`).

### `agent/extensions/background-procs.ts`

Ports codex's `/ps` + `/stop` background-terminal management. Pi has no
unified-exec subsystem, so this extension tracks processes via two paths:
(1) a model-callable `bg_register({ pid, command })` tool the model invokes
after backgrounding a process, and (2) auto-detection on bash `tool_result`
when the command shows backgrounding patterns (`&`, `nohup`, `setsid`,
`disown`) and the output matches well-known PID announcements. Surfaces:
`/ps` (live alive-check via `kill -0`), `/stop <id|all>` (SIGTERM), and
`/bg cleanup` (purge dead from the registry).

### `agent/extensions/terminal-title.ts`

Ports codex's `/title` slash command. Uses `ctx.ui.setTitle()` to update the
terminal window/tab title from a templated string that interpolates runtime
placeholders: `{cwd}`, `{fullcwd}`, `{model}`, `{thinking}`, `{provider}`,
`{branch}`, `{session}`. Re-renders on every event that changes a value
(`turn_end`, `model_select`, `thinking_level_select`). Persists across
session resumes via `custom_message` entries on the branch.

### `agent/extensions/pets.ts`

Ports codex's `/pets` terminal pet. Animates an ASCII pet in the pi footer
via `setInterval` + `ctx.ui.setStatus`. Available pets: dog, cat, fish,
snake, hamster. Pure delight; persists across session resumes.

### `agent/settings.json`

Default provider / model / thinking level. Tracked for parity across
machines. Pi rewrites this at runtime (e.g. bumps
`lastChangelogVersion` on version updates), so it stays a copy rather
than a symlink — see the table above.

## Updating the repo from a machine you've been working on

Symlinked files are already the repo's files; just commit:

```bash
cd ~/dev/pi-config
git status
git add -A
git commit -m "describe what changed"
git push
```

For `settings.json` (the copy), sync explicitly when you've changed a
real setting:

```bash
cp ~/.pi/agent/settings.json ~/dev/pi-config/agent/settings.json
git diff agent/settings.json   # ignore lastChangelogVersion-only diffs
```

## Not upstreamable

The wrapper is a per-account workaround for Anthropic's billing-lane
classifier. Pi already mimics Claude Code's tool-naming convention in
its own `// Stealth mode` block — this wrapper is only needed for
accounts where that's still sub-threshold (typically: Pro/Max with no
extra-usage credit configured). Don't PR it.
