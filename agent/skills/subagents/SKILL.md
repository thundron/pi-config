---
name: subagents
description: Dispatch and reason over parallel pi sub-agents from inside an active pi session. Use when you have ≥2 independent units of work that can run in parallel (separate worktrees, separate briefs), when you want to fan out an exploration across multiple branches, or when a long-running task needs isolation from the current session. Replaces the legacy pi-fleet manifest workflow with model-driven dispatch via the `subagent_spawn` / `subagent_wait` / `subagent_list` / `subagent_close` tools. Patterned after OpenAI Codex's `/subagents` and Anthropic Claude Code's Subagents.
---

# subagents

You can spawn parallel pi sub-agents from inside the active session by
calling the `subagent_*` tool family. This skill teaches you when and
how to use it.

## When to dispatch sub-agents

Good fit:

- **Independent units of work** that don't share writes (e.g. "convert
  module A" and "convert module B" with no overlap).
- **Branch exploration**: try N approaches in parallel, keep the best.
- **Long compile/test in isolation** so it doesn't lock up your main
  session's working tree.
- **Read-mostly reconnaissance**: fan out N read-only agents to inspect
  different parts of a codebase, then synthesize.

Bad fit:

- Trivial tasks (overhead dominates).
- Tasks that share writes to the same files (use sequential turns).
- Tasks that need each other's results to start (chain sequentially or
  use a single agent with a multi-step plan).

## The tools

### `subagent_spawn(instruction, ...)`

Dispatch one sub-agent. Returns the assigned agent id and current
status (`queued` or `starting` — it has not begun work yet).

Required: `instruction` (string) — the brief / task as a user prompt.
The brief should be self-contained: the sub-agent has no shared memory
with you.

Optional:

- `id` — human-readable label (e.g. `"P73"`). Auto-assigned if omitted.
- `cwd` — working dir for the sub-agent. Defaults to your current cwd.
- `worktree_root` — if set, auto-creates a git worktree at
  `<root>/<runId>-<id>` and runs the sub-agent there. **Use this for
  any task that modifies files** so siblings don't conflict.
- `parent_ref` — git ref the worktree branches from. Defaults to `HEAD`.
- `model` / `thinking` / `provider` — override your defaults for this
  sub-agent. Use a cheaper model for grunt work, a stronger one for
  hard reasoning.
- `extra_args` — raw pi CLI flags. E.g. `["--no-tools"]` for a
  read-only sub-agent. Use sparingly.

### `subagent_wait(agent_ids, timeout_ms?)`

Block until the named sub-agents reach a terminal status
(`done` / `aborted` / `error`). Returns each one's final status, stop
reason, and **result text** (the last assistant message from each
sub-agent).

- Pass an empty `agent_ids` array (or omit the field) to wait for all
  live sub-agents.
- `timeout_ms` is optional; on timeout, you get a partial snapshot,
  not an error.

### `subagent_list(status_filter?)`

Read-only introspection. Returns the current set of sub-agents in this
run with their status, model, and cwd.

### `subagent_close(agent_ids)`

`SIGTERM` the named sub-agents. Pass `["all"]` to close everything.
Use when a sub-agent has clearly gone off the rails or you no longer
need its result.

## Patterns

### Pattern 1: parallel implementation across worktrees

```text
1. subagent_spawn({
     id: "A",
     instruction: "Implement X using strategy 1: ...",
     worktree_root: "../wt-explorations"
   })
2. subagent_spawn({
     id: "B",
     instruction: "Implement X using strategy 2: ...",
     worktree_root: "../wt-explorations"
   })
3. subagent_wait({ agent_ids: ["A", "B"] })
4. Read both result texts, compare, pick the winner, cherry-pick the
   relevant commits or restart from the winning worktree.
```

### Pattern 2: fan-out read-only investigation

```text
1. For each of N areas you want to inspect:
     subagent_spawn({
       id: areaName,
       instruction: "Investigate <area>: ...",
       extra_args: ["--no-tools", "--tools=read,grep,find,ls"]
     })
2. subagent_wait({ agent_ids: [] })   // wait for all
3. Synthesize the N result texts into a single report.
```

### Pattern 3: long isolated build / test

```text
1. subagent_spawn({
     id: "build-and-test",
     instruction: "Run the full bench suite and report results: ...",
     worktree_root: "../wt-bench"
   })
2. Continue your own work in the main session.
3. Later: subagent_wait({ agent_ids: ["build-and-test"] }) to collect.
```

## Brief-writing rules (sub-agents are blind to your context)

A sub-agent receives ONLY the `instruction` you pass — none of your
session history, none of the user's previous turns, none of the files
you've already read. The brief must be a complete, self-contained
prompt.

Always include:

- **What** — the concrete task and the requested end state.
- **Where** — paths to relevant files / commands / specs.
- **How to know it's done** — what tests / outputs / artifacts prove
  completion.
- **Constraints** — what NOT to touch, what NOT to mark complete.
- **Reporting format** — what the final assistant message should
  contain (so your `subagent_wait` reads back useful structure).

Bad brief:
> "Fix the bug."

Good brief:
> "In `~/dev/foo/src/parser.rs`, the function `parse_atom` (line 142)
> returns `Err(EOF)` for a trailing `\r\n` instead of accepting it as
> end-of-input.
>
> 1. Reproduce: `cargo test -p foo parser::tests::trailing_crlf`
>    currently fails.
> 2. Fix `parse_atom` so the trailing `\r\n` case is accepted.
> 3. Make sure the existing test suite still passes:
>    `cargo test -p foo`.
> 4. Do NOT modify any other crate.
> 5. Report: in your final message, paste the diff and the test output."

## Slash command surface (human)

You usually drive the tools from your reasoning. The human can also
inspect / steer the run with `/subagents`:

```text
/subagents                         show status
/subagents ls                      list (alias)
/subagents abort [id|all]          SIGTERM (prefix-match supported)
/subagents fire <manifest.json>    dispatch from a legacy pi-fleet manifest
/subagents cap <N>                 set concurrency cap (1..64)
```

## What runs in the sub-agent

Each sub-agent is a `pi -p --mode json` subprocess. It auto-discovers
your global extensions (including `fleet-citizen.ts`, which writes
guardrail state into the same per-agent dir). It does NOT inherit your
session history. It uses your default model unless overridden.

State is persisted to `~/.pi/fleet/runs/<runId>/agents/<id>/`:

| File | What |
| --- | --- |
| `instruction.md` | the brief you passed |
| `events.jsonl` | the child's full event stream |
| `state.json` | live status |
| `result.md` | the final assistant message text |
| `agent.json` | frozen spawn options |
| `pi.pid` | child pid |
| `stderr.log` | child stderr |

The legacy Python `pi-fleet status` CLI reads this same layout, so you
can use it for ad-hoc inspection from outside the parent session.

## What is NOT supported

- **Mid-flight `subagent_send_input`** — the rpc-mode fix isn't
  released upstream, so each sub-agent is one-shot. To "steer", let
  the current sub-agent finish, then `subagent_spawn` a new one with
  an updated brief.
- **`subagent_resume_agent`** — re-engaging a closed sub-agent is a
  fresh `subagent_spawn` with the prior `instruction`.

When the rpc-mode fix lands, both will be reinstated as proper tools.

## Provenance

Tool API + concurrency constants ported from
`codex-rs/core/src/tools/handlers/multi_agents/` and `agent_jobs.rs`.
Topology storage patterned after `codex-rs/agent-graph-store/`. State
layout preserves backward compatibility with the legacy
[`pi-fleet`][pi-fleet] Python orchestrator.

[pi-fleet]: https://github.com/thundron/pi-fleet
