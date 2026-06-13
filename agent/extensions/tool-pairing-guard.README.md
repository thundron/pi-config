# tool-pairing-guard

Guarantees the Anthropic request never contains an orphaned `tool_result`
(or a dangling `tool_use`), eliminating this 400:

```
Error: 400 invalid_request_error — messages.N.content.M: unexpected
`tool_use_id` found in `tool_result` blocks: <id>. Each `tool_result` block
must have a corresponding `tool_use` block in the previous message.
```

## Why the error happens

It is **not** caused by `context-diet` / `compaction-diet` — those preserve
message structure 1:1. It originates in pi-core's provider layer
(`pi-ai/providers/transform-messages.js` → `anthropic.js`), which reshapes the
on-disk history right before the API call:

1. `transformMessages`' second pass **drops any assistant message whose
   `stopReason` is `"error"` or `"aborted"`** (an incomplete turn). That deletes
   the assistant's `tool_use` blocks.
2. `convertMessages` drops an assistant message that becomes empty after
   block-filtering (`if (blocks.length === 0) continue`).

In both cases the `toolResult` messages that followed are **kept**.
`transformMessages` only synthesizes results for orphaned tool *calls*; it never
removes orphaned tool *results*. So the final payload has a `tool_result`
pointing at a deleted `tool_use` → Anthropic 400.

This is amplified by long autonomous runs: `goal-mode` auto-continues across
rate-limit/error turns (it explicitly counts `stopReason === "error"/"aborted"`),
which is exactly the errored-assistant-with-dispatched-tools state core drops.
That's why it looked like "the diet extensions broke things."

## What it does

Hooks `before_provider_request` — the last interception point, operating on the
fully-built Anthropic payload (after `transformMessages` + `convertMessages`):

- **Drops** `tool_result` blocks whose `tool_use_id` has no matching `tool_use`
  in the immediately-preceding message. A user message emptied this way is
  removed entirely.
- **Backfills** a synthetic error `tool_result` for any `tool_use` left
  unanswered in the next message (mirror-image 400), so repairs can never leave
  a dangling call.
- **Re-homes** `cache_control` onto the new last block when the block that
  carried it is removed.

If the payload isn't Anthropic-shaped (no `tool_use`/`tool_result` blocks), it's
a no-op, so it's safe across providers.

## Controls

- Disable entirely: `PI_TOOL_PAIRING_GUARD_DISABLE=1`
- Runtime: `/tool-pairing-guard on|off|show`

The footer stays invisible until it actually repairs something, then shows
`🔗 <orphans> orphan / <n> synth`.
