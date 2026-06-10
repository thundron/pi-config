# compaction-diet

Bounded compaction summarization for pi.

## The problem

pi's auto-compaction summarizes the older part of a session by serializing the
**entire to-be-summarized span into a single prompt** and sending it to the
session model (see `core/compaction/compaction.ts` → `generateSummary`). That
span is read straight from the on-disk session — full-fidelity tool output and
all — and there is no upper bound on its size: it's "everything older than the
last ~20k tokens."

[context-diet](./context-diet.README.md) does **not** help here, by design. It
only rewrites the *live* per-turn `context` event; it never touches the on-disk
history, and the compaction summarizer bypasses the `context` hook entirely.
Worse, context-diet shrinks the usage metric the auto-compaction trigger
watches (`estimateContextTokens` keys off the last assistant message's reported
usage), so the session runs longer, the on-disk span grows larger, and when
compaction finally fires the summarization payload can exceed the model's
context window — the request fails with `context_length_exceeded`, taking
compaction down with it.

## What it does

Takes over the `session_before_compact` hook and produces the summary itself,
keeping the summarization input bounded regardless of on-disk size:

1. **Trim.** Compress oversized tool results in the span (the dominant source
   of bloat) using the same head+tail compression context-diet uses. Every
   result is eligible — the whole span is being summarized away, so there's no
   recent-turn window to preserve.
2. **Fit-or-fold.** If the trimmed span fits the model's context window, do a
   single-shot summary via pi's own `generateSummary` (so the structured
   checkpoint format and iterative-update prompt are identical to default
   compaction). If it doesn't fit, fold it through `generateSummary` in bounded
   chunks — a map-reduce where each chunk merges into the running summary via
   the update prompt. No single request ever exceeds the window.
3. **Optionally re-target.** Summarize with a larger-context model instead of
   the saturated session model.

The result is returned as `{ compaction: { summary, firstKeptEntryId,
tokensBefore } }`. On any failure (no usable model, empty summary, provider
error) it returns nothing and pi falls back to its default compaction — it
never makes things worse.

It's safe to run alongside context-diet: context-diet keeps live turns lean,
compaction-diet keeps the periodic summary bounded. They cover the two
different code paths.

## Cadence still matters

This removes the hard `context_length_exceeded` failure, but compacting earlier
is still cheaper than folding a giant span in many chunks. Run `/compact`
proactively, or lower `keepRecentTokens` in `settings.json` so auto-compaction
triggers sooner.

## Slash command

```
/compaction-diet                       show config + last-run stats
/compaction-diet on | off              enable / disable for this session
/compaction-diet mode compress | tear-out
/compaction-diet max <bytes>           trim tool results larger than N bytes
/compaction-diet model <provider/id>   summarize with another model (or "clear")
/compaction-diet thinking <level>      summarizer thinking level
```

A footer (`🗜 <model> 3ch (820kt→9.4kt)`) shows the last run's model, chunk
count, and input→summary token estimate.

## Env-var configuration

All defaults are env-overridable at process start (handy for sub-agents):

| Env var | Default | Meaning |
|---|---|---|
| `PI_COMPACTION_DIET_DISABLE` | `0` | `1` to fully disable |
| `PI_COMPACTION_DIET_MODE` | `compress` | `compress` or `tear-out` |
| `PI_COMPACTION_DIET_MAX_BYTES` | `4096` | Trim tool results larger than this |
| `PI_COMPACTION_DIET_HEAD_BYTES` | `800` | Head kept in compress mode |
| `PI_COMPACTION_DIET_TAIL_BYTES` | `400` | Tail kept in compress mode |
| `PI_COMPACTION_DIET_THINKING` | `low` | Summarizer thinking level (`off`…`xhigh`) |
| `PI_COMPACTION_DIET_USABLE_FRACTION` | `0.85` | Fraction of context window usable for input |
| `PI_COMPACTION_DIET_PROMPT_OVERHEAD` | `1500` | Tokens reserved for prompt scaffolding |
| `PI_COMPACTION_DIET_MIN_CHUNK` | `4000` | Floor for per-chunk token budget |
| `PI_COMPACTION_DIET_MODEL` | (unset) | `provider/id` to summarize with instead of the session model |

### Pointing at a bigger model

```
PI_COMPACTION_DIET_MODEL=google/gemini-2.5-pro pi
```

or at runtime: `/compaction-diet model google/gemini-2.5-pro`. The model must be
configured with auth in pi; if it can't be found or authed, compaction-diet
warns and uses the session model.

## What it does NOT touch

- Non-tool messages (user/assistant text + thinking) — those are "the work."
  Bloat there is handled by chunked folding, not trimming.
- The on-disk session file — trimming happens only on the in-memory copy handed
  to the summarizer. `/resume` and `/tree` still see full history.
- The live per-turn request — that's context-diet's job.

## Verification

- Unit test: `tests/test-compaction-diet.mjs` (loads the extension via dynamic
  import, exercises `trimForSummary` / `makeStub` / `planChunks` /
  `computeBudgets` / `parseModelRef` through the `__compactionDietInternals`
  back-door).
- Typecheck: `tests/test-typecheck.mjs` (`tsc --noEmit` against the installed
  pi `.d.ts`).

## Caveats

- Budget math is token-estimated (chars/4, pi's own heuristic). If a single-shot
  summary still overflows because the estimate was optimistic, the extension
  catches the error and folds instead — so it self-corrects rather than failing.
- Chunked folding is lossier than a single-shot summary: each chunk is
  summarized with only the running summary as prior context, not the full span.
  That's the cost of fitting an over-window span into a finite model.
