# subagents

A pi extension that ports OpenAI Codex's `multi_agents` tool family +
`agent-graph-store` topology to pi, so the **parent pi session can
dispatch sub-agents as part of its own reasoning** by calling tools.

This replaces the legacy [`pi-fleet`][pi-fleet] Python orchestrator's
model-facing surface area. Naming follows industry standards
(Anthropic Claude Code "Subagents", codex `/subagents`).

[pi-fleet]: https://github.com/thundron/pi-fleet

## Why this is more stable than legacy pi-fleet

The legacy `pi-fleet` is a Python supervisor that drives child pi
processes via `pi --mode rpc`. The upstream `--mode rpc` stream
handling has a bug that triggers a ~33% stall on heavy Opus streams,
which is why pi-fleet v0.9.1 had to *remove* mid-flight steering /
abort / model-swap / compact — every control plane operation went
away.

This extension sidesteps the rpc bug entirely:

1. **Single-shot subprocesses, one per dispatch** — sub-agents are
   `pi -p --mode json` invocations. No long-lived rpc channel ⇒ no
   stalls.
2. **Model-driven orchestration** — the parent agent dispatches via
   `subagent_spawn` and reasons about results from `subagent_wait`.
   The control plane lives inside the parent's tool-execution loop,
   so there's no separate IPC to break.
3. **Codex's well-tested tool shapes** — the `multi_agents/`
   crate in codex-rs is the source of the API.

What's lost vs. the in-process codex design:
- **Mid-flight `send_input`**: impossible against a one-shot child.
  Reinstated as a tool stub when pi rpc lands the fix upstream.
- **`resume_agent`** of a closed child: subprocess model treats this
  as "re-spawn from saved instruction", which works but is more
  expensive than codex's in-memory resume.

## Tool surface (model-callable)

All four tools are registered as standard pi tools and visible to the
parent agent. Codex naming preserved where possible.

| Tool | Codex source | Behavior |
| --- | --- | --- |
| `subagent_spawn` | `multi_agents/spawn.rs` | Spawn one sub-agent, return immediately with its id + status. Optionally creates a git worktree per sub-agent. |
| `subagent_wait` | `multi_agents/wait.rs` | Block until named (or all) sub-agents reach a terminal status. Returns the result text of each. |
| `subagent_list` | (introspection) | List sub-agents in the current run with status, model, cwd. |
| `subagent_close` | `multi_agents/close_agent.rs` | SIGTERM the named (or `['all']`) sub-agents. |

### `subagent_spawn` parameters

| Field | Type | Purpose |
| --- | --- | --- |
| `instruction` | string (required) | The brief / task — becomes the sub-agent's user prompt. |
| `id` | string | Human-readable label. Auto-assigned as `agent-N` if omitted. |
| `cwd` | string | Working directory for the sub-agent. Defaults to parent's cwd. |
| `worktree_root` | string | If set, auto-creates a git worktree at `<root>/<runId>-<id>` and runs the sub-agent there. |
| `parent_ref` | string | Git ref to base the worktree on. Defaults to `HEAD`. |
| `model` | string | Override parent's model. |
| `thinking` | enum | Override parent's thinking level. |
| `provider` | string | Override parent's provider. |
| `extra_args` | string[] | Raw pi CLI flags. Use sparingly. |

Compatibility aliases accepted before validation (Codex MultiAgentV2-ish callers):

| Alias | Canonical pi field |
| --- | --- |
| `message` | `instruction` |
| `task_name` | `id` |
| `agent_type` | `role` |
| `reasoning_effort` | `thinking` |

### `subagent_wait` parameters

| Field | Type | Purpose |
| --- | --- | --- |
| `agent_ids` | string[] (required) | Ids to wait for. Empty = all live sub-agents. |
| `timeout_ms` | number | Max time to block. On timeout, returns partial status snapshot. |

### `subagent_close` parameters

| Field | Type | Purpose |
| --- | --- | --- |
| `agent_ids` | string[] (required) | Ids to SIGTERM. Pass `['all']` to close everything. |

### `subagent_list` parameters

| Field | Type | Purpose |
| --- | --- | --- |
| `status_filter` | enum | Optionally restrict to one of `queued | starting | streaming | done | aborted | error`. |

## Human-facing slash command: `/subagents`

```text
/subagents                         show status of all sub-agents in this session
/subagents ls                      list (alias for the above)
/subagents mode                    show Codex MultiAgentV2 mode
/subagents mode explicit           only spawn when the user explicitly asks
/subagents mode proactive          allow proactive delegation when useful
/subagents abort [id|all]          SIGTERM matching sub-agents (prefix-match like pi-fleet)
/subagents fire <manifest.json>    dispatch from a legacy pi-fleet manifest
/subagents cap <N>                 set concurrency cap (1..64)
```

The mode is persisted as a hidden branch entry (`subagents/mode`) and injected
before model calls with Codex's `<multi_agent_mode>...</multi_agent_mode>`
marker. The default is `explicit-request-only`, matching Codex's safe default:
sub-agents should not be spawned unless the user explicitly asks for delegation
or parallel agent work. `proactive` mode overrides that and lets the model spawn
sub-agents when doing so materially improves speed, coverage, or quality.

`/subagents fire` reads the existing pi-fleet manifest format and
dispatches each agent via `subagent_spawn`, so the existing
`phase7.fleet.json` and similar files keep working.

## State layout (back-compat with `pi-fleet status`)

State is rooted at `~/.pi/fleet/runs/<runId>/` (legacy path preserved so
the Python `pi-fleet status` CLI still works against runs created here):

```text
~/.pi/fleet/runs/<runId>/
├── run.json                     # { runId, createdAt, parentSessionId, source: "fleet-mode" }
└── agents/<agentId>/
    ├── agent.json               # frozen spawn options
    ├── instruction.md           # brief, frozen
    ├── pi.pid                   # child pid
    ├── events.jsonl             # child's stdout stream, stamped with _pi_fleet_t for replay
    ├── stderr.log               # child stderr
    ├── state.json               # live snapshot read by /subagents
    └── result.md                # last assistant message text after agent_end
```

`fleet-citizen.ts` (sibling extension, loaded by each child) continues
to write its own files (`fleet-citizen.log`, `done-summary.txt`,
`HALT.md`, `shutdown.json`) into the same per-agent dir. Coupling is
via environment variables set by the orchestrator at spawn time:

| Env var | Value |
| --- | --- |
| `PI_FLEET_RUN_ID` | `<runId>` |
| `PI_FLEET_AGENT_ID` | `<agentId>` |
| `PI_FLEET_STATE_DIR` | `<runDir>` |
| `PI_FLEET_AGENT_DIR` | `<agentDir>` |

## Concurrency cap

In-memory semaphore, default 16 (matches codex's `DEFAULT_AGENT_JOB_CONCURRENCY`),
ceiling 64 (codex's `MAX_AGENT_JOB_CONCURRENCY`). Override per-session
with `/subagents cap N` or per-manifest with `"concurrency": N`.

## Safety nets

- **No auto-continue across the rpc bug**: every sub-agent invocation
  is a fresh `pi -p`. There is no long-lived stdin channel that can
  stall.
- **session_shutdown cleanup**: any still-streaming children get
  `SIGTERM` when the parent pi session exits, so subprocesses can't
  outlive the parent.
- **Worktree isolation**: when `worktree_root` is set, sub-agents work
  in separate git worktrees, so they can't trample each other's
  uncommitted changes.
- **fleet-citizen guardrails**: banned-phrase scanner, dangerous-bash
  blocker, `/done` + `/halt` ritual commands are all still active in
  each spawned sub-agent.

## Installation

The extension lives at `~/dev/pi-config/agent/extensions/subagents.ts`
and is symlinked into `~/.pi/agent/extensions/subagents.ts` by the
repo's `install.sh`. Pi auto-discovers it from there. Re-run
`install.sh` (idempotent) after pulling on a new machine.

## What this does NOT replace

The legacy Python `pi-fleet` CLI binary (`~/.pi/bin/pi-fleet`) still
provides:

- `pi-fleet status / watch / tmux` — dashboard against on-disk state
- `pi-fleet replay` — re-render an events.jsonl with timing
- `pi-fleet reap` — collect REPORT.md across a finished run

The `subagents` extension writes state in a fully back-compat layout,
so all of those tools keep working unchanged. The deprecated parts of
`pi-fleet` are the manifest-driven `fire` / `steer` / `followup` /
`escalate` / `model` / `tell` commands — use the new tool surface for
those.

## Provenance

Tool API + concurrency-cap constants adapted from
`codex-rs/core/src/tools/handlers/multi_agents/` and
`codex-rs/core/src/tools/handlers/agent_jobs.rs`. MultiAgentV2 mode text is
adapted from `codex-rs/core/src/context/multi_agent_mode_instructions.rs` and
`codex-rs/protocol/src/config_types.rs`. Topology storage patterned after
`codex-rs/agent-graph-store/`. Subprocess + JSONL-stream implementation is
original (codex's agents are in-process within one Rust binary, which is not yet
possible from a pi extension).
