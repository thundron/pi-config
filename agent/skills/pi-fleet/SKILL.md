---
name: pi-fleet
description: "Dispatch and steer parallel pi agents via the pi-fleet orchestrator. Use when you need ≥2 independent dev/sub-arch agents working in their own worktrees against the same parent SHA. Replaces inline `pi -p` + heredoc dispatch with long-lived `pi --mode rpc` agents that are steerable mid-flight via JSON-RPC, observable via a live dashboard + merged trace + tmux multi-pane, and auto-guarded by the fleet-citizen extension (banned-phrase scanner with steer-count escalation, git push block, /done + /halt ritual commands). Supports fleet-wide concurrency caps, runaway-cost protection, fire-time agent filtering, and replay of finished runs."
license: MIT
---

# pi-fleet — Skill for architects

This skill teaches you when and how to spawn multi-agent dispatches via **`pi-fleet`** instead of inline `pi -p` + heredoc orchestration. The killer wins:

- **Long-lived agents** in `pi --mode rpc` mode — not one-shot `pi -p` batch invocations
- **Mid-flight steering** via `pi-fleet steer <run> <agent> '<msg>'` — agent picks up the message at the next LLM call without restart or context loss
- **Live dashboard** showing per-agent status, tokens, cost, context %, current tool, last commit
- **Auto-guard** via `fleet-citizen` extension: banned-phrase scanner with auto-steer rewrite, `git push` / main-tree-edit block, `/done` + `/halt` slash commands
- **Auto-compact** when context exceeds 85 %
- **Final REPORT.md** on `pi-fleet reap`

If your dispatch fits the "≥2 independent scopes, same parent SHA, different worktrees" shape, use pi-fleet.

---

## When to use pi-fleet vs single-agent vs inline

| Scenario | Use |
|---|---|
| One scope, one agent, just dispatch and wait | `pi -p` one-shot is still fine |
| ≥2 independent scopes (per-family parity probes, per-primitive lowering, etc.) | **pi-fleet** |
| Sub-arch RO (read-only architectural ruling) | `pi -p --tools read,grep,find,ls` one-shot |
| Merge agent (append-only conflict resolution) | `pi -p` single is fine |
| Interactive REPL with one agent | `pi` plain (interactive mode) |
| Want to course-correct an agent mid-flight | **pi-fleet** — `pi -p` cannot be steered |
| Want live token/cost dashboard | **pi-fleet** |
| Want auto banned-phrase guard | **pi-fleet** (extension installs auto) |
| Need fleet-wide cost ceiling | **none** — removed v0.9.1; track via dashboard, abort runaways manually |
| Need to spread spawn burst across API rate limit | **pi-fleet** `--stagger SEC` |
| Need to forensically review what happened | **pi-fleet replay** / **pi-fleet trace** |

---

## Anatomy of a pi-fleet dispatch

```
project/
├── fleet/                                # convention: keep manifests in repo
│   └── phase7.fleet.json                 # manifest
└── fleet/briefs/
    ├── common-preamble.md                # shared §0/§1/§2/§3 boilerplate
    ├── P73-llama.md                      # one body per agent
    ├── P74a-qwen.md
    └── ...
```

**Manifest** (`phase7.fleet.json`):

```json
{
  "name": "phase-7-multi-family-parity",
  "parent_sha": "<git-sha-the-fleet-targets>",
  "concurrency": 3,
  "common": {
    "preamble": "briefs/common-preamble.md",
    "worktree_root": ".claude/worktrees",
    "author_name": "Lorenzo Alberto Maria Ambrosi",
    "author_email": "la@thundron.dev",
    "banned_phrases": [
      "pre-existing",
      "out of scope",
      "deferred to follow-up",
      "leave as TODO",
      "mechanical follow-up",
      "outside the load budget",
      "Co-Authored-By",
      "cosmetic"
    ],
    "auto_compact_threshold": 0.85,
    "auto_escalate_idle_seconds": 600
  },
  "agents": [
    {
      "id": "P73",
      "model": "claude-sonnet-4-6",
      "thinking": "high",
      "brief": "briefs/P73-llama.md"
    },
    {
      "id": "P74a",
      "model": "claude-sonnet-4-6",
      "thinking": "high",
      "brief": "briefs/P74a-qwen.md"
    },
    {
      "id": "P712",
      "model": "claude-opus-4-7",
      "thinking": "high",
      "brief": "briefs/P712-synthetic.md"
    }
  ]
}
```

**Brief body** (`briefs/P73-llama.md`) — agent-specific, no preamble (preamble is auto-prepended):

```markdown
# Dispatch — TBD#Phase-7.3: Llama-family per-model parity campaign

Read `.claude/architectural-analysis/Phase7-ratification.md` §F "Phase 7.3".

Scope:
- Mistral-7B-Instruct-v0.3 (Q4_K_M)
- Granite-3-2B-Instruct (Q4_K_M)
- Llama-3.1-8B-Instruct (Q4_K_M) if checkpoint reachable

Each probe ~80 LOC mirroring `e2e_llama_3_2_1b_parity_smoke.cpp`...

When complete: `/done <summary>` (NOT `git commit` directly — the /done command
runs the audit + summary ritual). HALT via `/halt <reason>` if blocked.
```

---

## Verbatim launch + monitor recipes

### Fire and forget (returns run-id immediately, architect's shell is free)

```bash
pi-fleet plan fleet/phase7.fleet.json                                    # validate first
RUN=$(pi-fleet fire fleet/phase7.fleet.json)                             # default
RUN=$(pi-fleet fire fleet/phase7.fleet.json --concurrency 2)             # override cap
RUN=$(pi-fleet fire fleet/phase7.fleet.json --only P73,P75)              # subset only
RUN=$(pi-fleet fire fleet/phase7.fleet.json --concurrency 1 --only P73,P74a)   # both
```

`fire` returns the run-id on stdout and prints help text to stderr, so `RUN=$(...)` captures cleanly. Excluded agents (via `--only`) are NOT prepared and don't appear in the state dir.

## THE AUTONOMOUS LOOP (this is what you reach for)

```bash
RUN=$(pi-fleet fire fleet/phase7.fleet.json --quiet --stagger 1.0)
pi-fleet wait    "$RUN" --timeout 1800 --stale-timeout 600 --fail-fast
pi-fleet audit   "$RUN"                       # commit-body banned-phrase sweep
pi-fleet merge   "$RUN" --rebase-each \
                        --verify-each "$REGRESSION_PROBES" \
                        --cmake-strategy=append \
                        --cleanup-each
# architect resumes here with everything verified + clean trunk
```

Four commands. No polling. No sleep workarounds. No manual conflict cascade. No CMakeLists.txt merge disaster.

### Critical safety flags (USE THESE)

The v0.3.0 release had a $24 silent-hang failure mode — pi blocked in `read()` on the SSE socket, no events for 30+ minutes, no automatic recovery. v0.3.1+ closes this. The defaults give you protection automatically, BUT the architect-side flags (`--stale-timeout --fail-fast`) are still recommended because:

- `--stale-timeout 600` — architect-side hang detection. Combined with `--fail-fast` (`--exit-on-first-error --abort-others`), the architect's tool-call returns within 10 min of any agent going silent, with siblings aborted.
- `--stagger 1.0` — 1s between supervisor spawns. Reduces API connection burst that contributed to the 0.3.0 hang.
- `--timeout 1800` — hard ceiling on the wait itself (30 min). Returns exit 124 if exceeded; architect can call wait again to resume.

Automatic defaults (no manifest config needed):
- `stall_timeout_seconds=900` — supervisor aborts an agent stuck in `streaming` with no events for 15 min
- `max_wall_clock_seconds=7200` — supervisor aborts any agent that's been running for 2 hours total

Override defaults per-manifest:
```json
"common": {
  "stall_timeout_seconds": 1200,   // 20 min instead of 15
  "max_wall_clock_seconds": 14400  // 4 hr for long-running prefill etc.
}
```

If an agent silently hangs, use:
```bash
pi-fleet diagnose "$RUN"            # per-agent liveness + idle time + strace sample
pi-fleet kill     "$RUN"            # graceful shutdown (race-free; one cycle is enough)
```

## Dependency graph (`depends_on`)

Declare prereqs in the manifest. Supervisors wait for deps to reach `done` before acquiring concurrency slots. Failed deps cascade to `skipped` status automatically:

```json
{
  "agents": [
    { "id": "P77-harness", "model": "...", "brief": "P77.md" },
    { "id": "P78", "model": "...", "brief": "P78.md", "depends_on": ["P77-harness"] },
    { "id": "P79", "model": "...", "brief": "P79.md", "depends_on": ["P77-harness"] }
  ]
}
```

Dashboard shows `⦿ blocked` (waiting on deps) vs `⏸ queued` (waiting on concurrency slot) — distinct semantics, distinct glyphs.

## Variable interpolation (`vars` + auto-injected)

```json
{
  "vars": { "PHASE": "7", "PARENT_SHA": "f1165371..." },
  "common": { "preamble": "briefs/preamble.md" },
  ...
}
```

Then in `briefs/preamble.md`:
```markdown
You are agent ${agent_id} (worktree ${worktree_path}) in phase ${PHASE}.
Parent SHA: ${PARENT_SHA}. Run id: ${run_id}.
```

Auto-injected vars: `${parent_sha}` (from manifest), `${agent_id}`, `${worktree_path}`, `${run_id}`, `${run_dir}`. Uses `Template.safe_substitute` so unknown `${...}` placeholders are left literal rather than erroring.

## `pi-fleet wait` (the gate primitive)

```bash
pi-fleet wait "$RUN"                              # default: wait for all, exit 0 if all done
pi-fleet wait "$RUN" --timeout 1800               # 30-min budget; exit 124 on timeout
pi-fleet wait "$RUN" --exit-on-first-error        # bail on first failure (siblings keep running)
pi-fleet wait "$RUN" --fail-fast                  # = --exit-on-first-error --abort-others
pi-fleet wait "$RUN" --json                       # machine-readable summary on exit
pi-fleet wait "$RUN" --quiet                      # no progress line
```

Observational by default (matches shell `wait`). Use `--abort-others` opt-in to send aborts to remaining agents on early exit.

Exit codes: 0 all done | 1 any non-done terminal | 124 timeout | 130 SIGINT.

If the architect's tool-call needs to chunk: call `pi-fleet wait --timeout 1800`, on 124 just call again. Composable across as many tool-call boundaries as needed.

## `pi-fleet audit` (the commit sweep)

```bash
pi-fleet audit "$RUN"               # table of violations + amend suggestions
pi-fleet audit "$RUN" --json        # JSON for tooling
pi-fleet audit "$RUN" --verbose     # include offending commit subject
```

Walks `git log parent_sha..HEAD` per agent. Detects banned phrases (from manifest), AI-attribution trailers, missing author identity, overly-long subjects. Exits 1 if any violation. The live streaming scanner in fleet-citizen catches many but not all; this is the belt-and-suspenders sweep.

## `pi-fleet merge` (the killer)

```bash
# Conservative (refuses non-done agents):
pi-fleet merge "$RUN"

# Standard production loop:
pi-fleet merge "$RUN" --rebase-each --verify-each "$PROBES" --cmake-strategy=append --cleanup-each

# After resolving a conflict the architect handled manually:
pi-fleet merge "$RUN"     # automatically resumes from architect-state.json
```

Walks agents in topo (`depends_on`) order. Per agent:
1. Refuses if not in `{done}` (use `--include-skipped` / `--include-failed` to override)
2. (`--rebase-each`) Rebases agent branch onto target before merging — eliminates most sibling-conflict surface (e.g., the abi.h field-deletion cascade)
3. (`--verify-each '<cmd>'`) Runs verification probes in agent worktree before merge; refuses on non-zero exit
4. Merges (`git merge --no-ff`). On conflict: writes `architect-state.json`, prints clear next-steps, halts. Re-running resumes.
5. (`--cmake-strategy=append`) Writes `merge=union` rules to `.gitattributes` for `CMakeLists.txt` / `*.cmake` so additive `add_executable(...)` blocks concatenate cleanly instead of conflicting.
6. (`--cleanup-each`) `git worktree remove` after successful merge.

Persists merge progress in `<run>/architect-state.json` so a partial merge can be resumed seamlessly.

## `pi-fleet recover` (partial-fleet salvage)

When a fleet finishes with mixed results — some agents `done`, some `error`/`aborted`/`skipped` — the standard pattern is:

```bash
# 1. Merge what succeeded
pi-fleet audit "$RUN"
pi-fleet merge "$RUN" --rebase-each --verify-each "$PROBES" \
                     --cmake-strategy=append --cleanup-each --include-failed
#   With --include-failed: agents with no commits silently skip, agents with
#   partial commits get a chance to merge with a WARNING.

# 2. Re-fire just the losers, with reduced concurrency to dodge the failure cause.
pi-fleet recover "$RUN" \
        --only P74b,P77,P78 \
        --concurrency 1 \
        --stagger 5 \
        --stall-timeout 1200

# 3. Wait + audit + merge again. The originally-`done` agents (and the
#    second-merge-attempt's now-merged ones) are preserved untouched.
pi-fleet wait    "$RUN" --timeout 1800 --stale-timeout 1200
pi-fleet audit   "$RUN"
pi-fleet merge   "$RUN" --rebase-each --verify-each "$PROBES" \
                        --cmake-strategy=append --cleanup-each --include-failed
```

`recover` archives each non-done agent's prior artifacts to `_archived-HHMMSS/`, reseeds a fresh `state.json`, recreates the FIFO, clears the `.killed` sentinel, and spawns a detached supervisor. The `done` agents are preserved untouched — their commits stay ready for a future merge invocation.

**Lowering concurrency in recovery is almost always correct.** The reason the original agents failed was usually API saturation at the original concurrency; recovering at the same concurrency tends to reproduce the failure. Default heuristic: drop by 50%, or to 1 if the originals were Opus-tier.

## `pi-fleet diagnose` (proactive stuck-agent detection)

Use when `pi-fleet wait` times out and you need to decide "wait longer" vs "kill + recover":

```bash
pi-fleet diagnose "$RUN"
```

Per-agent table: status / idle time / CPU % / pid / diagnosis. Diagnosis is one of `healthy` / `suspicious (idle 120-600s)` / `STALLED (idle > 600s)` / `PROCESS DEAD (state says streaming but pi is gone)`. For stalled agents, runs a 2s `strace -p` sample showing recent syscalls — helps confirm "blocked on `read()` from API socket" vs "actively working".

No state changes — read-only inspection.

## Smart `merge --include-failed` (no-commits silent-skip)

When merging a partial-success fleet, you almost always want `--include-failed`:

```bash
pi-fleet merge "$RUN" --include-failed ...
```

Semantics:
- Agents in `done` status: merge normally
- Agents in `error` / `aborted` / `exited` status WITH commits: attempt merge with a WARNING (rare; an agent that committed THEN stalled)
- Agents in `error` / `aborted` / `exited` status WITHOUT commits: silently skip (the common case after a stall — the architect already knows)
- Agents in `skipped` (dep-failed): silently skip (or refuse without `--include-skipped`)

The summary line reflects what happened: `"merge summary: 3 merged, 4 silently skipped (no commits)"`.

## Custom gates with `status --json`

If the built-in wait semantics don't fit your needs, write your own gate in 3 lines:

```bash
# Wait until every agent has reached terminal state
while ! pi-fleet status "$RUN" --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["summary"]["all_terminal"] else 1)'; do
  sleep 30
done

# Or filter to a custom condition (using jq if installed):
pi-fleet status "$RUN" --json | jq '.summary.by_status'
pi-fleet status "$RUN" --json | jq '.agents | map(select(.status == "error"))'
```

Full JSON shape: `{run_id, started_at, now, agents: [...full state.json contents...], summary: {total_agents, by_status, all_terminal, any_failure, all_success, total_cost_usd, total_tokens}}`.

### Concurrency: limit how many agents run in parallel

Manifest `"concurrency": N` caps to N agents in flight; extras wait in the queue and pick up slots as agents finish (or are aborted/error out). Slot accounting is `flock`-serialized inside the state dir, so simultaneous supervisor wake-ups don't race past the threshold. Dead supervisors auto-release their slot (verified via `os.kill(pid, 0)` liveness probe).

Use `"concurrency": 0` (or omit the field) for unlimited parallelism. `--concurrency N` at fire-time overrides the manifest.

### Cost: tracked, not capped (v0.9.1)

There is no cost cap.  `--max-cost` and `cost_ceiling_usd` were removed in v0.9.1 after a real run where the fleet-wide cap killed two healthy agents the moment one runaway pushed the total over $40 — wasting more work than it saved.  Each agent's running cost is tracked in `state.json` and shown in the dashboard `COST $` column; if you want to bound spend, watch the dashboard and `pi-fleet abort <run> <id>` the runaway individually.

### API rate-limit smoothing: `--stagger SECONDS`

```bash
pi-fleet fire fleet.json --stagger 0.5            # 0.5s between supervisor spawns
```

Useful when firing 10+ agents simultaneously would burst your API connection pool or trigger 429 rate-limiting. Each `--stagger` interval is just `sleep` between `setsid` invocations.

### Unified event stream: `pi-fleet trace`

```bash
pi-fleet trace "$RUN"                                 # all events, all agents, time-sorted
pi-fleet trace "$RUN" --follow                        # tail live as new events arrive
pi-fleet trace "$RUN" --types tool_execution_start,tool_execution_end
pi-fleet trace "$RUN" --grep 'cmake|ninja'            # regex filter on event summaries
pi-fleet trace "$RUN" --from 2026-05-20T02:30:00      # only events after this time
pi-fleet trace "$RUN" --from 1779234600               # also accepts unix epoch
```

Merges every agent's `events.jsonl`, sorts by the `_pi_fleet_t` wall-clock timestamp stamped by the supervisor, color-codes by agent, prints one line per event. Indispensable for understanding "what was happening across the fleet at moment T" — e.g., "did agent A's tool result land before agent B's compaction kicked in".

Follow mode uses a `--buffer-window` (default 0.5 s) reorder buffer so cross-agent ordering remains stable even when events arrive slightly out-of-order across the file watchers.

### Live dashboard in one terminal

```bash
pi-fleet watch "$RUN"            # refreshing dashboard (clear + redraw every 2s)
pi-fleet status "$RUN"           # one-shot (no refresh)
NO_COLOR=1 pi-fleet status       # plain output (good for piping / dumb terminals)
```

Dashboard cells: ID | MODEL | STATUS (color-coded) | ELAPSED | TOKENS | COST | CTX% | MSG | TOOL | LAST. Cost auto-formats: `<$0.0001` for sub-millicent runs, 4-decimal under $0.01, 3-decimal under $10, 2-decimal above.

### tmux session: status + N tail panes + control shell

```bash
pi-fleet tmux "$RUN"            # opens an attached tmux session
pi-fleet tmux "$RUN" close      # tear down the session
pi-fleet attach "$RUN"          # alias for the same
```

Layout: `main-horizontal` with `pi-fleet watch` on top (fixed `main-pane-height` rows) and one `pi-fleet tail` pane per agent below, plus a final “control pane” that drops you into a bash with `$PI_FLEET_RUN` exported (so you can run `pi-fleet steer $PI_FLEET_RUN <id> '...'` with one keystroke).

`remain-on-exit on` is set, so panes stay visible (with their final output) even after their commands exit. Re-open `pi-fleet tmux` on a finished run to inspect frozen panes.

Environment tunables:
- `PI_FLEET_TMUX_STATUS_HEIGHT` (default 14)
- `PI_FLEET_TMUX_CONTROL_PANE` (default 1, set 0 to disable)
- `PI_FLEET_TMUX_WIDTH` (default 220) — virtual canvas width when launched detached

Refreshes every 2s. Shows per agent: ID / model / status / elapsed / tokens / cost $ / ctx % / msg count / current tool / last commit. Exits cleanly when all agents finalize.

### Follow events for one agent (pretty-printed)

```bash
pi-fleet tail "$RUN" P75
```

Streams `text_delta` chunks, tool calls, compactions, retries, queue updates with ANSI colors.

### Steer mid-flight

```bash
pi-fleet steer "$RUN" P75 "Skip Phi-3-small/medium if checkpoints absent. Commit when Phi-3.5-mini + PhiMoE done."
```

Delivered to P75 **after the current tool call completes, before its next LLM call**. No restart. No context loss. Agent picks up where it was.

### Bulk steer to all agents

```bash
pi-fleet steer "$RUN" all "Stop after current turn and run /done."
```

### Escalate thinking on one agent

```bash
pi-fleet escalate "$RUN" P75 xhigh
```

### Swap model (e.g., haiku → opus mid-task)

```bash
pi-fleet model "$RUN" P75 claude-opus-4-7
```

### Force a context compaction

```bash
pi-fleet compact "$RUN" P75
```

### Abort one agent gracefully

```bash
pi-fleet abort "$RUN" P75
```

### Replay a finished agent's events.jsonl with timing reproduced

```bash
pi-fleet replay "$RUN" P75                              # default 4× speed
pi-fleet replay "$RUN" P75 --speed 1                    # real-time
pi-fleet replay "$RUN" P75 --speed 0                    # full speed, no delays
pi-fleet replay "$RUN" P75 --skip-to tool_execution     # jump past initial chatter
pi-fleet replay "$RUN" P75 --output P75-replay.txt      # archive (ANSI stripped)
pi-fleet replay "$RUN" P75 --output P75-replay.ansi --keep-color   # keep colors
```

Supervisor stamps `_pi_fleet_t` (Unix epoch wall-clock) onto every event before writing to `events.jsonl`, so replay reproduces the actual timing of an agent's session. Long idle gaps are capped at `--max-gap` seconds (default 5) so a 30-min agent doesn't replay for 30 min at 1×.

### Retry a single failed/aborted agent without re-firing the whole fleet

```bash
pi-fleet rerun "$RUN" P75
```

Archives the prior `events.jsonl` / `result.md` / `state.json` to `_archived-<HHMMSS>/` inside the agent dir, then spawns a fresh supervisor against the same frozen brief. The agent.json (model / worktree / banned phrases) is reused as-is; only the runtime artifacts are reset.

Useful when:
- An agent hit a transient API error and aborted
- You sent a steering message but the agent already gave up
- You want to re-run with a different `set_model` or `set_thinking_level` (pre-edit `agent.json`)

### Reap when done (writes REPORT.md, prints summary table)

```bash
pi-fleet reap "$RUN"
cat ~/.pi/fleet/runs/$RUN/REPORT.md
```

### Force-kill with grace period

```bash
pi-fleet kill "$RUN"                # SIGTERM all agents, escalate SIGKILL after 5s
pi-fleet kill "$RUN" --grace 10     # custom grace period
```

Use when `pi-fleet abort` (which graceful-aborts the LLM call) hasn't worked because the agent is stuck in a tool subprocess. `kill` escalates progressively: SIGTERM → wait `--grace` seconds → SIGKILL for surviving processes.

### Smoke test (no LLM, no money spent)

```bash
pi-fleet test
```

Runs 53 assertions against synthesized event files. Catches regressions in plan/prepare/render/replay/trace/reap/cli-dispatch. Useful before/after any pi-fleet config change.

---

## Brief-authoring discipline (carries forward from AGENTS.md)

Every brief body MUST open with §0 / §1 / §2 / §3 sections per `AGENTS.md`. The preamble file holds the boilerplate (pre-flight checks, author identity, banned-trailer rule, Phase context); the body holds the per-agent §0 / §1 / §2 / §3 + scope.

Briefs missing §1 (memory anchors) / §2 (premise grep-and-RECONCILE) / §3 (5-Q result) get **bounced** — the manifest contract is the same as ad-hoc dispatch.

The `fleet-citizen` extension auto-injects a system-prompt addendum naming the run-id, agent-id, worktree, banned phrases, and a reminder about the HALT-on-workaround pattern. Agents are aware they're in a fleet.

---

## What `fleet-citizen` does inside each agent (so you can rely on it)

1. **Footer status** `fleet P75@20260520-013145…` — visible in interactive mode footer; in RPC mode reported via the extension UI protocol.
2. **System-prompt addendum** — agent knows its run-id, agent-id, banned phrases, worktree.
3. **Banned-phrase scanner** on streaming `text_delta`. On hit: auto-`steer` with a rewrite prompt. Debounced to 10s. Logged to `<state>/agents/<id>/fleet-citizen.log`.
4. **Tool-call guardrails** — refuses `git push`, `git checkout meta-kernel-ir-compositor`, `--ignore-other-worktrees`, force-branch, `rm -rf /`, and edits to the main tree from a dispatched agent.
5. **`/done <summary>`** — gathers branch/head/dirty/diffstat, writes `done-summary.txt`, sends a `nextTurn` custom message so the assistant sees the audit in its context for the wrap-up turn.
6. **`/halt <reason>`** — writes `HALT.md` in the agent's state dir, sends a `nextTurn` message; agent does NOT commit and surfaces to architect.
7. **`/fleet`** — prints current identity + git state (notify).
8. **`turn_end` hook** — writes `fleet-citizen-state.json` per turn with branch/head/dirty.
9. **Shutdown hook** — writes `shutdown.json` on session_shutdown.

If you load the extension outside a fleet (no env vars set), all features degrade gracefully — banned-phrase scanner only fires if `PI_FLEET_BANNED_PHRASES` is non-empty, footer stays empty, /done still works for the local worktree.

---

## The state directory

```
~/.pi/fleet/runs/<run-id>/
├── manifest.json                        # frozen copy
├── run.json                             # run metadata
├── REPORT.md                            # written by `reap`
└── agents/<agent-id>/
    ├── agent.json                       # frozen agent config
    ├── brief.md                         # preamble + body, frozen
    ├── stdin.fifo                       # write RPC commands here
    ├── pi.pid                           # pi process pid
    ├── supervisor.pid                   # python supervisor pid
    ├── state.json                       # live dashboard data
    ├── events.jsonl                     # every event from pi stdout (forensic)
    ├── stderr.log                       # pi stderr
    ├── supervisor.log                   # supervisor diagnostic log
    ├── fleet-citizen.log                # extension diagnostic log
    ├── command.txt                      # exact pi invocation
    ├── result.md                        # final assistant text (on agent_end)
    ├── done-summary.txt                 # from /done command (if invoked)
    ├── HALT.md                          # from /halt command (if invoked)
    └── shutdown.json                    # on session_shutdown
```

This dir is the source of truth for what the agent did. Inspect any file with `cat` / `less` / your editor.

---

## Common diagnostics

```bash
pi-fleet doctor                          # check prerequisites
pi-fleet ls                              # list all runs with status
pi-fleet status "$RUN"                   # one-shot table
pi-fleet status                          # latest run
tail -F ~/.pi/fleet/runs/$RUN/agents/P75/events.jsonl   # raw JSONL events
tail -F ~/.pi/fleet/runs/$RUN/agents/P75/supervisor.log # supervisor diag
```

If an agent seems stuck:

1. `pi-fleet status` — check `STATUS`, `CTX %`, last `TOKENS` change
2. `pi-fleet tail "$RUN" <id>` — see what events are arriving
3. `cat ~/.pi/fleet/runs/$RUN/agents/<id>/state.json` — last cached state
4. `pi-fleet steer "$RUN" <id> "Take a step back, summarize what you've tried, then proceed."` — sometimes the cheapest unstuck
5. `pi-fleet escalate "$RUN" <id> xhigh` — bump thinking
6. `pi-fleet abort "$RUN" <id>` — graceful exit, files preserved in state dir

---

## Banned (don't do these — they're still banned via pi-fleet)

- `pi -p ... 2>&1 > $LOG &` for multi-agent dispatch (use `pi-fleet fire`)
- Heredoc `cat > /tmp/Pxx_brief.md <<EOF` patterns (briefs live in repo as `.md` files)
- Committing without `/done` (lose the audit summary)
- Force-pushing from inside an agent's worktree
- Touching `meta-kernel-ir-compositor` directly from dev agent (still HALT-able by fleet-citizen guardrails)

## Diagnostics quick reference

```bash
pi-fleet doctor                              # check prerequisites + PATH
pi-fleet doctor --smoke-test                 # also runs no-LLM round-trip test
pi-fleet ls                                  # list all runs
pi-fleet status                              # latest run's dashboard
pi-fleet status "$RUN"                       # specific run
pi-fleet trace "$RUN" --follow               # live merged event stream
tail -F ~/.pi/fleet/runs/$RUN/agents/P75/events.jsonl      # raw jsonl
tail -F ~/.pi/fleet/runs/$RUN/agents/P75/supervisor.log    # supervisor diag
tail -F ~/.pi/fleet/runs/$RUN/agents/P75/fleet-citizen.log # extension diag
cat   ~/.pi/fleet/runs/$RUN/agents/P75/state.json          # last cached state
cat   ~/.pi/fleet/runs/$RUN/agents/P75/result.md           # final assistant message
```

For full troubleshooting see `~/.pi/share/pi-fleet/README.md` § Troubleshooting.

---

## Quick recipe — convert the Phase 7 dispatch we ran inline into a fleet

The Phase 7 dispatch (P73 + P74a + P75 + P76 + P712 across 5 worktrees) becomes:

```bash
mkdir -p fleet/briefs
# Move the common-preamble body into fleet/briefs/common-preamble.md
# Move each /tmp/Pxx_brief.md body into fleet/briefs/Pxx-<family>.md
cat > fleet/phase7.fleet.json <<'EOF'
{
  "name": "phase-7-multi-family-parity",
  "parent_sha": "f1165371294db469414b6bc976173634bdd5b429",
  "common": {
    "preamble": "briefs/common-preamble.md",
    "worktree_root": ".claude/worktrees",
    "author_name": "Lorenzo Alberto Maria Ambrosi",
    "author_email": "la@thundron.dev",
    "banned_phrases": ["pre-existing", "out of scope", "deferred to follow-up", "Co-Authored-By"]
  },
  "agents": [
    { "id": "P73",  "model": "claude-sonnet-4-6", "thinking": "high", "brief": "briefs/P73-llama.md" },
    { "id": "P74a", "model": "claude-sonnet-4-6", "thinking": "high", "brief": "briefs/P74a-qwen.md" },
    { "id": "P75",  "model": "claude-sonnet-4-6", "thinking": "high", "brief": "briefs/P75-phi.md" },
    { "id": "P76",  "model": "claude-sonnet-4-6", "thinking": "high", "brief": "briefs/P76-gemma.md" },
    { "id": "P712", "model": "claude-opus-4-7",   "thinking": "high", "brief": "briefs/P712-synthetic.md" }
  ]
}
EOF

pi-fleet plan fleet/phase7.fleet.json     # validate, prints resolved table
RUN=$(pi-fleet fire fleet/phase7.fleet.json | head -1)
pi-fleet watch "$RUN"                     # live dashboard
# (in another terminal as needed)
pi-fleet steer "$RUN" P75 "skip variants without checkpoints, /done after Phi-3.5-mini + PhiMoE"
# when done:
pi-fleet reap "$RUN"
```

Architect's terminal is free between `fire` and `reap` — no `wait` blocking on the slowest agent.
