# compaction

Unified compaction management for pi — one extension, one switch, two halves.

This replaces the former `large-context-autocompact` + `compaction-diet` pair,
which were two separate extensions with independent on/off switches. Disabling
one left the other running (the trigger fired at 50% even after the summarizer
was toggled "off"), which was confusing. They are now a single extension behind
a single master switch. Re-run `install.sh` to install the replacement and remove
retired symlinks owned by this checkout. Real files or links from other checkouts
are preserved with a warning; disable or remove those manually. The old
`PI_COMPACTION_DIET_*` and `PI_LARGE_CONTEXT_AUTOCOMPACT_*` environment variables
are replaced by the `PI_COMPACTION_*` configuration below.

## The two halves

Compaction is really two decisions that hand off to each other:

1. **TRIGGER — *when* to compact.** Pi core only compacts near
   `contextWindow - reserveTokens` (~984k on a 1M-token model). For large-context
   models that waits far too long. The trigger proactively compacts at a
   configurable fraction of the window (default **50%**), either right after a
   turn settles (**post-turn**, preferred) or just before the next prompt
   (**pre-input** fallback, which replays the prompt after compacting). It also
   supplies `customInstructions` describing what to preserve.

2. **DIET — *how* to summarize.** Pi's default compaction serializes the entire
   to-be-summarized span into ONE prompt sent to the session model; in a long
   session that payload can exceed the window and fail with
   `context_length_exceeded`. The diet half handles `session_before_compact`:
   it trims oversized tool results, then produces a bounded single-shot or
   chunked-fold summary that respects the summarization model's window, honoring
   the trigger's `customInstructions`.

The trigger decides to compact → pi fires `session_before_compact` with the
trigger's instructions → the diet consumes them and produces a bounded summary.

## Slash command

```
/compaction                       show config + current usage + last-run stats
/compaction on | off              master enable / disable (both halves)
/compaction trigger on | off      proactive early-compaction only
/compaction diet on | off         bounded summarizer only
/compaction fraction <0.1-0.95>   trigger threshold (e.g. 0.5 = 50%)
/compaction mode compress|tear-out
/compaction max <bytes>           trim tool results larger than N bytes
/compaction model <provider/id|clear>   summarize with a different model
/compaction thinking <off|minimal|low|medium|high|xhigh>
```

Footer states: `📦 compaction @50%` (armed), `📦 @50% <model> Nch (in→out)`
(after a diet run), `⊘ compaction off` (master disabled).

The trigger publishes compaction intent before calling pi, so goal-mode holds
auto-continuations even during the setup window before compaction events arrive.
Intent is released on completion, failure, or a synchronous throw.

## Configuration (env overrides)

```sh
PI_COMPACTION_DISABLE=1               # master off (both halves)

# trigger
PI_COMPACTION_TRIGGER_DISABLE=1       # disable proactive trigger only
PI_COMPACTION_FRACTION=0.5            # compact at 50% of window
PI_COMPACTION_MIN_CONTEXT=1000000     # only trigger for models >= this window
PI_COMPACTION_POST_TURN_DISABLE=1     # disable post-turn; keep pre-input fallback
PI_COMPACTION_POST_TURN_DELAY_MS=250

# diet
PI_COMPACTION_DIET_DISABLE=1          # disable bounded summarizer only
PI_COMPACTION_MODE=compress           # compress | tear-out
PI_COMPACTION_MAX_BYTES=4096          # trim tool results larger than this
PI_COMPACTION_HEAD_BYTES=800
PI_COMPACTION_TAIL_BYTES=400
PI_COMPACTION_THINKING=low
PI_COMPACTION_USABLE_FRACTION=0.85    # fraction of summary model window used for input
PI_COMPACTION_PROMPT_OVERHEAD=1500
PI_COMPACTION_MIN_CHUNK=4000
PI_COMPACTION_MODEL=google/gemini-2.5-pro   # summarize with a different model
```

## Notes

- Post-turn compaction is skipped when pi is busy, when a compaction is already
  in-flight, or when there are queued/pending messages.
- A prompt replayed by the pre-input path uses `event.source === "extension"`,
  so it bypasses the trigger and cannot recurse.
- The diet never touches on-disk history; full tool output is preserved. On any
  failure (bad model, empty summary, exception) it returns nothing and pi falls
  back to its default compaction — it self-corrects rather than failing.
- Chunked folding is lossier than a single-shot summary: each chunk is
  summarized with only the running summary as prior context. That's the cost of
  fitting an over-window span into a finite model.
- Token budgets are estimates, and chunks do not split individual messages.
  An oversized non-tool message or a very small summary-model window can still
  exceed the model limit; in that case pi's default compaction is the fallback.
