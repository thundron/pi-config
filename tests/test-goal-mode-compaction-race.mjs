#!/usr/bin/env node
// Behavioral regression test for the goal-mode ↔ compaction race.
//
// The bug: after a post-turn compaction the goal simply stopped. The user had
// to run /goal pause + /goal resume to get it moving again.
//
// Mechanism (pi 0.84.x):
//   1. `large-context-autocompact` starts a post-turn compaction via
//      `ctx.compact()` shortly after `agent_end`.
//   2. `AgentSession.compact()` installs `_compactionAbortController` BEFORE it
//      emits `session_before_compact` (an `abort()` await, an auth await and a
//      whole-branch `prepareCompaction()` sit in between). From that instant
//      `AgentSession.prompt()` throws "Cannot submit a prompt while compaction
//      is in progress".
//   3. goal-mode's continuation timer fired inside that unannounced window and
//      called `pi.sendUserMessage(...)`, whose rejection the pi runtime
//      swallows into an `Extension "<runtime>" error` toast — no throw, no
//      callback, no retry. The continuation was simply lost.
//
// This test drives goal-mode with a mock pi where sendUserMessage silently
// drops the prompt while "compaction" is running, and asserts the goal loop
// recovers on its own.
//
// Usage: node tests/test-goal-mode-compaction-race.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fast timings so the whole test runs in ~1s instead of ~30s.
const FAST_TIMINGS = {
	PI_GOAL_CONTINUE_DELAY_MS: "60",
	PI_GOAL_BUSY_RETRY_MS: "40",
	PI_GOAL_VERIFY_MS: "60",
	PI_GOAL_INPUT_GRACE_MS: "1",
	PI_GOAL_COMPACTION_SETTLE_MS: "40",
	PI_GOAL_DELIVERY_WINDOW_MS: "5000",
};

if (!process.env.PI_GOAL_RACE_TEST_BOOTSTRAPPED) {
	{
		const hook = resolve(__dirname, "lib", "stub-hook-register.mjs");
		const r = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings=DeprecationWarning",
				"--import",
				hook,
				fileURLToPath(import.meta.url),
			],
			{
				stdio: "inherit",
				env: { ...process.env, ...FAST_TIMINGS, PI_GOAL_RACE_TEST_BOOTSTRAPPED: "1" },
			},
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "goal-mode.ts");
const AUTOCOMPACT_PATH = resolve(__dirname, "..", "agent", "extensions", "large-context-autocompact.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Mock pi session ────────────────────────────────────────────────────────

function makeSession({ compactionRefusesPrompts = false } = {}) {
	const branch = [
		{ type: "custom", customType: "goal/set", data: { objective: "keep going", t: 1 } },
		{ type: "custom", customType: "goal/status", data: { status: "active", t: 2 } },
	];
	const handlers = new Map();
	const sent = [];
	const notifications = [];
	const session = {
		branch,
		sent,
		notifications,
		compacting: false,
		idle: true,
		emit: async (event, payload) => {
			for (const h of handlers.get(event) ?? []) await h(payload, session.ctx);
		},
	};

	session.pi = {
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: () => {},
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
		// Mirrors pi's runtime action: fire-and-forget, rejection swallowed.
		sendUserMessage: (text) => {
			if (compactionRefusesPrompts && session.compacting) return; // dropped, exactly like pi
			sent.push(text);
			branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
		},
	};

	session.ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: { setStatus: () => {}, notify: (message, type) => notifications.push({ message, type }) },
		isIdle: () => session.idle,
		hasPendingMessages: () => false,
	};
	return session;
}

const goalMode = await import(`${EXT_PATH}?fresh=1`);

// ─── 1. baseline: a settled run schedules a continuation ────────────────────

console.log("=== baseline continuation ===");
{
	const s = makeSession();
	goalMode.default(s.pi);
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await sleep(250);
	ok("continuation delivered", s.sent.length === 1, `sent=${s.sent.length}`);
	ok("prompt is the continuation template",
		String(s.sent[0]).includes("Continue working toward the active thread goal"));
}

// ─── 2. the regression: prompt refused during an unannounced compaction ─────

console.log("\n=== continuation refused mid-compaction is re-delivered ===");
{
	const s = makeSession({ compactionRefusesPrompts: true });
	goalMode.default(s.pi);

	// Compaction begins in pi core (prompts already fatal), but no extension
	// event has announced it yet — exactly the window that broke the goal loop.
	s.compacting = true;
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });

	await sleep(250);
	ok("nothing delivered while compaction refuses prompts", s.sent.length === 0, `sent=${s.sent.length}`);

	// Compaction finishes.
	s.compacting = false;
	await sleep(300);
	ok("continuation re-delivered after compaction", s.sent.length === 1, `sent=${s.sent.length}`);
	ok("no duplicate continuations", s.sent.length <= 1, `sent=${s.sent.length}`);
}

// ─── 3. announced compaction (session_before_compact) still holds ───────────

console.log("\n=== session_before_compact holds continuation ===");
{
	const s = makeSession();
	goalMode.default(s.pi);
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await s.emit("session_before_compact", { preparation: {} });
	await sleep(200);
	ok("held while compaction in flight", s.sent.length === 0, `sent=${s.sent.length}`);
	await s.emit("session_compact", { compactionEntry: {} });
	await sleep(300);
	ok("released after session_compact", s.sent.length === 1, `sent=${s.sent.length}`);
}

// ─── 4. cross-extension compaction intent guard ─────────────────────────────

console.log("\n=== compaction intent published by large-context-autocompact ===");
{
	const autocompact = await import(`${AUTOCOMPACT_PATH}?fresh=1`);
	const captured = {};
	const acPi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: () => {},
	};
	autocompact.default(acPi);
	const internals = acPi.__largeContextAutocompactInternals;
	ok("autocompact exposes startCompaction", typeof internals?.startCompaction === "function");

	const s = makeSession();
	goalMode.default(s.pi);
	const goalInternals = s.pi.__goalModeInternals;
	ok("goal-mode exposes compactionIntentActive", typeof goalInternals?.compactionIntentActive === "function");
	ok("intent starts clear", goalInternals.compactionIntentActive() === false);

	// large-context-autocompact starts a compaction; capture pi's callbacks.
	internals.startCompaction(
		{ hasUI: false, compact: (opts) => { captured.opts = opts; }, ui: { notify: () => {} } },
		"post-turn",
	);
	ok("intent published before ctx.compact() resolves", goalInternals.compactionIntentActive() === true);

	// goal-mode must hold its continuation while the intent is up, even though
	// no session_before_compact has been emitted.
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await sleep(200);
	ok("continuation held on intent alone", s.sent.length === 0, `sent=${s.sent.length}`);

	captured.opts.onComplete?.();
	ok("intent cleared on completion", goalInternals.compactionIntentActive() === false);
	await sleep(300);
	ok("continuation delivered once intent clears", s.sent.length === 1, `sent=${s.sent.length}`);
}

// ─── 5. agent_settled is the preferred anchor ───────────────────────────────

console.log("\n=== agent_settled anchoring ===");
{
	const s = makeSession();
	goalMode.default(s.pi);
	// Pi emits agent_end then agent_settled: exactly one continuation total.
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await s.emit("agent_settled", {});
	await sleep(300);
	ok("single continuation across agent_end + agent_settled", s.sent.length === 1, `sent=${s.sent.length}`);
	ok("agent_settled observed", s.pi.__goalModeInternals.state().sawAgentSettled === true);
}

// ─── 6. error accounting is not double-counted across both anchors ──────────

console.log("\n=== consecutive-error accounting ===");
{
	const s = makeSession();
	goalMode.default(s.pi);
	// One errored run must not trip the 2-consecutive-errors auto-pause just
	// because both agent_end and agent_settled saw the same messages.
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	await s.emit("agent_settled", {});
	await sleep(200);
	const pausedEntries = s.branch.filter(
		(e) => e.customType === "goal/status" && e.data?.status === "paused",
	);
	ok("single errored run does not auto-pause", pausedEntries.length === 0, JSON.stringify(pausedEntries));

	// Two distinct errored runs still do.
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	await s.emit("agent_settled", {});
	await sleep(200);
	ok("two errored runs auto-pause",
		s.branch.some((e) => e.customType === "goal/status" && e.data?.status === "paused"),
		JSON.stringify(s.branch.filter((e) => e.type === "custom")));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
