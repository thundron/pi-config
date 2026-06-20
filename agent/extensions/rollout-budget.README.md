# rollout-budget

Shared weighted-token rollout budget for pi, inspired by Codex's rollout budget.

## Codex provenance

Current Codex sources inspected:

- `codex-rs/core/src/rollout_budget.rs` — shared budget accounting, weighted token usage, per-thread reminder deliveries.
- `codex-rs/core/src/session/rollout_budget.rs` — records usage and injects reminder context.
- `codex-rs/core/src/context/rollout_budget.rs` — `<rollout_budget>` developer context body.

Codex keeps one in-memory budget object for a root-thread session tree. Pi subagents are separate processes, so this extension implements the missing shared primitive as an append-only JSONL ledger file inherited by child processes through environment variables.

## Configuration

Disabled by default. Enable with:

```sh
PI_ROLLOUT_BUDGET_TOKENS=200000 pi ...
```

Optional settings:

```sh
PI_ROLLOUT_BUDGET_FILE=/path/to/shared.jsonl
PI_ROLLOUT_BUDGET_ID=my-run-id
PI_ROLLOUT_PREFILL_TOKEN_WEIGHT=1
PI_ROLLOUT_SAMPLING_TOKEN_WEIGHT=1
PI_ROLLOUT_REMINDER_INTERVAL=50000
```

When enabled and no file/id is supplied, the parent creates a ledger under
`~/.pi/rollout-budget/<id>.jsonl` and writes `PI_ROLLOUT_BUDGET_FILE` /
`PI_ROLLOUT_BUDGET_TOKENS` into `process.env`, so `subagents.ts` children inherit the same ledger.

## Tool

```ts
get_rollout_budget({})
```

Returns:

```json
{
  "enabled": true,
  "limit_tokens": 200000,
  "used_weighted_tokens": 12345,
  "remaining_weighted_tokens": 187655,
  "exhausted": false,
  "ledger_path": "..."
}
```

## Context reminders

When enabled, the extension injects Codex-style context when a reminder threshold is crossed:

```text
<rollout_budget>
You have N weighted tokens left in the shared session token budget.
</rollout_budget>
```

If exhausted, the reminder asks the model not to start new substantive work and to summarize/stop.

## Limitations

Codex can abort a turn before sampling once the budget is exhausted. Pi extensions cannot currently abort pre-sampling with the same semantics, so this port fails safe by injecting explicit context and exposing `get_rollout_budget`. The accounting itself is shared across parent and subprocess subagents via the ledger.
