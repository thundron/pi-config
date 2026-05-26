# context-diet

Continuous, non-destructive tool-result compression for pi.

## What it does

Hooks pi's `context` event (fires before every LLM call) and rewrites the
messages array in-flight so tool-result content older than the last few turns
— or any single result larger than a byte threshold — gets either
**compressed** (head + middle-trim marker + tail) or **torn out** (single-line
stub). The session file on disk is **never modified**: `/resume`, `/fork`,
`/diff`-via-session-replay, and the compaction summarizer all see the
original, full-fidelity tool output.

Only the bytes that travel to the LLM provider on the next request are
shrunk. This stacks on top of pi's built-in `/compact`: compact summarizes
the entire branch periodically; context-diet trims the *live* per-turn
working set continuously.

## Why

Tool outputs (bash, read, find, grep) are the single largest source of token
bloat in a long agentic session. A `read` of a 200 KB file or a `find /` that
prints 4 MB of paths will sit in every subsequent LLM request — every turn,
every continuation — until the next `/compact`. context-diet replaces that
with a short stub the moment the next user message arrives, so the LLM keeps
seeing the *recent* tool-result wave at full fidelity but doesn't pay for
ancient ones.

## How it decides what to trim

A `ToolResultMessage` is rewritten when **either**:

1. It sits before the **recent-turn cutoff** (default: keep the last 3
   user-message-bounded turns verbatim), OR
2. Its content exceeds **`maxResultBytes`** (default: 8 KB) regardless of
   position — so a single giant tool output gets compressed even in the
   most recent turn.

Errors (`isError: true`) are preserved verbatim by default — they're small,
load-bearing, and the model often needs them to course-correct.

## Modes

- `compress` (default): keep the first `headBytes` (default 512) and last
  `tailBytes` (default 256) of the original, with a `[... context-diet
  trimmed NB; was XB; full content preserved on disk ...]` marker in between.
  The model still sees enough teaser to know what the tool did.
- `tear-out`: replace the entire content with `[tool <name> result torn out
  by context-diet — NB reclaimed; full content preserved on disk]`. Maximum
  savings; the model only sees that *something happened*.

## Slash command

```
/context-diet                          show current config + savings stats
/context-diet on  | off                enable / disable for this session
/context-diet mode compress | tear-out
/context-diet keep <N>                 keep last N turns verbatim
/context-diet max <bytes>              compress any single result > N bytes
/context-diet head <bytes>             bytes from start kept in compress mode
/context-diet tail <bytes>             bytes from end kept in compress mode
/context-diet errors preserve | trim   preserve isError=true results verbatim
/context-diet reset                    zero the savings stats
```

A footer status (`📉 -45.2KB (12 trims)`) shows running savings.

## Env-var configuration

All defaults are env-overridable at process start (handy for sub-agents):

| Env var | Default | Meaning |
|---|---|---|
| `PI_CONTEXT_DIET_DISABLE` | `0` | `1` to fully disable |
| `PI_CONTEXT_DIET_MODE` | `compress` | `compress` or `tear-out` |
| `PI_CONTEXT_DIET_KEEP_TURNS` | `3` | Verbatim recent-turn window |
| `PI_CONTEXT_DIET_MAX_BYTES` | `8192` | Always-trim threshold |
| `PI_CONTEXT_DIET_HEAD_BYTES` | `512` | Head retained in compress mode |
| `PI_CONTEXT_DIET_TAIL_BYTES` | `256` | Tail retained in compress mode |
| `PI_CONTEXT_DIET_KEEP_ERRORS` | `1` | `0` to also compress errors |

## What it does NOT touch

- Assistant message text + thinking content (small relative to tool output).
- The `ToolCall` blocks inside assistant messages (the *call*, not its
  result, is small — preserving the call is what keeps the LLM's pairing
  logic happy when it sees the trimmed result).
- User messages (those are the user's own words).
- System prompt / developer instructions (pi handles those separately).
- The on-disk session file (rewrite is per-LLM-call only).

## Verification

- Unit test: `tests/test-context-diet.mjs` (loads the extension via dynamic
  import, exercises every threshold + mode).
- Integration: harness scenarios cover every `/context-diet` subcommand.

## Caveats

- If the LLM relies on exact tool-output bytes from many turns ago (e.g. "in
  step 3 the find command printed file X.ts at byte offset 12345"),
  tear-out mode will lose that. Use `/context-diet off` for those flows or
  stay in compress mode (head + tail usually preserves enough).
- Compression here is byte-based, not token-based. The savings are
  approximately proportional to the savings the provider tokenizer will see,
  but not exactly. The footer is a coarse indicator.
