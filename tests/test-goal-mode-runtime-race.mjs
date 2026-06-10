#!/usr/bin/env node
// Regression guard for goal-mode's auto-continuation/runtime race.
//
// The historical failure was:
//   Extension "<runtime>" error: Agent is already processing. Wait for completion before continuing.
//
// Root cause: goal-mode could start its next prompt after `agent_end` while
// Pi core was still in post-run auto-compaction / continuation cleanup. This
// static test keeps the extension wired through the guarded scheduling path.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO_ROOT, "agent/extensions/goal-mode.ts"), "utf8");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

assert(
	src.includes('pi.on("session_before_compact"') && src.includes("markCompactionInFlight"),
	"goal-mode must mark post-agent compaction as in-flight",
);
assert(
	src.includes('pi.on("session_compact"') && src.includes("scheduleCompactionClear"),
	"goal-mode must keep the compaction guard through a post-compaction settle delay",
);
assert(
	src.includes("AUTO_CONTINUE_COMPACTION_SETTLE_MS") && src.includes("compactionSettleTimer"),
	"goal-mode must delay clearing the compaction guard so Pi core can run post-compaction continue() first",
);
assert(
	src.includes("postAgentCompactionInFlight || !ctx.isIdle() || ctx.hasPendingMessages()"),
	"goal-mode auto-continuation must retry while compaction/busy/pending state exists",
);
assert(
	src.includes('pi.sendUserMessage(prompt, { deliverAs: "followUp" });'),
	"goal-mode auto-continuation should use followUp delivery to avoid busy-agent runtime errors",
);
assert(
	!/pi\.sendUserMessage\(prompt\);/.test(src),
	"goal-mode must not send the continuation prompt through an unguarded fire-and-forget call",
);
assert(
	/scheduleContinuation\(CONTINUATION_PROMPT\(live\), pi, ctx\)/.test(src),
	"/goal resume should use the guarded scheduler when it re-engages the agent",
);

console.log("test-goal-mode-runtime-race: OK");
