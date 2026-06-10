# goal-mode

A pi extension that ports OpenAI Codex's `/goal` slash command into pi. A
"goal" is a persistent objective that survives across turns: each time the
agent loop settles, pi automatically re-engages the assistant with the
objective + remaining token budget so it keeps making progress without the
user typing "continue".

The model can mark the goal complete or blocked via the `update_goal` tool, and
a hard token budget protects against runaway cost.

## How it works

`goal-mode` is a thin TypeScript shim composing pi extension primitives — no
patches to pi itself.

| Codex primitive (Rust)                                | pi primitive used                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| Persistent goal in `codex-state` SQLite               | `pi.appendEntry("goal/set" / "goal/status", …)` — branch-aware     |
| `update_goal` tool the model can call                 | `pi.registerTool({ name: "update_goal", … })`                      |
| Per-turn token accounting                             | `pi.on("turn_end")` reads `event.message.usage.{input,output}`     |
| Auto-continuation after the agent loop fully settles  | `pi.on("agent_end")` + guarded `setTimeout` + compaction/busy polling + `pi.sendUserMessage(..., { deliverAs: "followUp" })` |
| Budget-limited steering                               | Once `tokensUsed ≥ tokenBudget`, status flips, wrap-up prompt sent |
| Footer status (`/status`-style)                       | `ctx.ui.setStatus("goal", …)`                                      |
| Resume across sessions                                | `pi.on("session_start" / "session_tree")` reconstructs from branch entries |

State is reconstructed on every event by walking the current branch. Forking
the session inherits the parent branch's goal automatically (just like codex's
thread-id-keyed goals).

## Slash command

```text
/goal                       — show current goal + usage
/goal <objective text>      — set or replace the objective
/goal budget <tokens>       — set/clear the token budget ("none" / "0" / "off" clears)
                              accepts plain ints, "50000", "50k", "1.5m"
/goal pause                 — pause auto-continuation
/goal resume                — re-arm auto-continuation (also re-pushes the
                              continuation prompt if the agent is idle)
/goal blocked [reason]      — mark blocked (rarely needed by humans)
/goal done [summary]        — mark complete
/goal clear                 — clear the goal entirely
```

## Model tool

The extension registers a tool named `update_goal` that the LLM can call:

```ts
update_goal({ status: "complete" | "blocked", summary?: string })
```

The model is instructed (via the continuation prompt) to call this only when:

- **complete** — current evidence proves every requirement is satisfied
- **blocked** — the same blocker has repeated for ≥ 3 consecutive goal turns

## Safety nets

- **Print/RPC mode safe** — auto-continuation only runs when `ctx.hasUI` is true.
- **Consecutive-error pause** — after 2 consecutive agent-end events with
  `stopReason: "error" | "aborted"`, the goal auto-pauses with a warning so a
  bad auth token / rate-limit / network outage doesn't burn the budget.
- **User-input grace window** — incoming interactive/rpc input within 1s of a
  pending auto-continuation cancels it so we never stomp on a typing user.
- **Branch-switch invalidation** — `session_tree` events bump the generation
  counter, so an in-flight continuation timer for the old branch is dropped.
- **Post-run compaction guard** — `session_before_compact` pauses pending
  continuations until shortly after `session_compact`, avoiding races with Pi
  core's post-agent `continue()` path.
- **Hard cap** — 200 auto-continuations per session as a defense-in-depth
  ceiling.

## Installation

Just drop `goal-mode.ts` into `~/.pi/agent/extensions/` (already present if
you're reading this README in-place). pi picks it up via auto-discovery; no
`pi install` step needed.

Re-run `pi` (or `/reload` inside an existing session) to start using `/goal`.

## Provenance

Prompt templates (continuation / budget-limit / objective-updated) are
faithfully adapted from `codex-rs/core/templates/goals/*.md` in OpenAI's Codex
CLI. Behavior mirrors `codex-rs/core/src/goals.rs` and
`codex-rs/app-server/src/request_processors/thread_goal_processor.rs`, ported
to pi's extension contract.
