# large-context-autocompact

Proactive auto-compaction policy for very large-context models.

Pi core normally compacts near `contextWindow - reserveTokens` (for a 1M-token model, often around ~984k tokens). This extension adds an earlier large-context threshold (default 50%) so compaction happens before the context gets unwieldy.

## Behavior

The extension checks two moments:

1. **Post-turn** — after the agent loop settles, if context usage is at/above the configured fraction and no messages are pending, it starts compaction immediately. This avoids the annoying pattern where a session grows to 80%+ and only compacts after the next user prompt.
2. **Pre-input fallback** — if a user prompt arrives while usage is over threshold and post-turn compaction has not already run, the extension compacts first and replays that prompt after compaction.

The post-turn path is the preferred path; the pre-input path is a safety net.

## Configuration

```sh
PI_LARGE_CONTEXT_AUTOCOMPACT_DISABLE=1            # disable extension
PI_LARGE_CONTEXT_AUTOCOMPACT_MIN_CONTEXT=1000000 # only apply to models at/above this context window
PI_LARGE_CONTEXT_AUTOCOMPACT_FRACTION=0.5        # compact at 50% of context window
PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DISABLE=1 # disable post-turn compaction; keep pre-input fallback
PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DELAY_MS=250
```

## Notes

- Post-turn compaction is skipped when pi is busy, when a compaction is already in-flight, or when there are queued/pending messages.
- A prompt replayed by this extension uses `event.source === "extension"`, so it bypasses the pre-input compaction hook and cannot recurse.
- The summary instructions explicitly preserve goals, decisions, edits, commands, test results, blockers, and the end-of-turn state.
