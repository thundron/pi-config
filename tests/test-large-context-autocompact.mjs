#!/usr/bin/env node
// Unit tests for large-context-autocompact.ts.
// Usage: bun run tests/test-large-context-autocompact.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_TEST_BOOTSTRAPPED) {
	const isBun = typeof globalThis.Bun !== "undefined" || /bun/i.test(process.execPath);
	if (!isBun) {
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
			{ stdio: "inherit", env: { ...process.env, PI_LARGE_CONTEXT_AUTOCOMPACT_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "large-context-autocompact.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

async function loadExt() {
	process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_MIN_CONTEXT = "1000";
	process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_FRACTION = "0.5";
	process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DELAY_MS = "1";
	delete process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_DISABLE;
	delete process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DISABLE;
	const mod = await import(`${EXT_PATH}?fresh=${Date.now()}-${Math.random()}`);
	const handlers = new Map();
	const sent = [];
	const mockPi = {
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: (message) => sent.push(message),
		sendMessage: () => {},
	};
	mod.default(mockPi);
	return { handlers, sent, internals: mockPi.__largeContextAutocompactInternals };
}

function makeCtx({ tokens = 600, pending = false, idle = true } = {}) {
	const notifications = [];
	let compactCalls = 0;
	const ctx = {
		hasUI: true,
		ui: { setStatus: () => {}, notify: (message, type) => notifications.push({ message, type }) },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 1000, percent: tokens / 10 }),
		compact: (opts) => {
			compactCalls += 1;
			opts?.onComplete?.({});
		},
		get compactCalls() { return compactCalls; },
		notifications,
	};
	return ctx;
}

async function emit(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) ?? []) {
		const r = await h(payload, ctx);
		if (r) return r;
	}
	return undefined;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

console.log("=== shouldCompact ===");
{
	const { internals } = await loadExt();
	ok("compacts above threshold", internals.shouldCompact(makeCtx({ tokens: 600 })).compact === true);
	ok("does not compact below threshold", internals.shouldCompact(makeCtx({ tokens: 400 })).compact === false);
	ok("does not compact with pending messages", internals.shouldCompact(makeCtx({ tokens: 600, pending: true })).reason === "pending-messages");
	ok("post-turn instructions mention next prompt", internals.compactInstructions("post-turn").includes("next user prompt"));
}

console.log("\n=== post-turn compaction ===");
{
	const { handlers } = await loadExt();
	const ctx = makeCtx({ tokens: 700 });
	await emit(handlers, "agent_end", { messages: [] }, ctx);
	await sleep(15);
	ok("agent_end schedules compaction", ctx.compactCalls === 1, `calls=${ctx.compactCalls}`);
	ok("notifies post-turn compaction", ctx.notifications.some((n) => n.message.includes("post-turn auto-compaction")), JSON.stringify(ctx.notifications));
}

console.log("\n=== pre-input path still replays prompt ===");
{
	const { handlers, sent } = await loadExt();
	const ctx = makeCtx({ tokens: 700 });
	const result = await emit(handlers, "input", { source: "interactive", text: "please continue" }, ctx);
	ok("input handled for compaction", result?.action === "handled", JSON.stringify(result));
	ok("pre-input compaction called", ctx.compactCalls === 1, `calls=${ctx.compactCalls}`);
	ok("prompt replayed after compact", sent[0] === "please continue", JSON.stringify(sent));
}

console.log("\n=== extension replay bypass ===");
{
	const { handlers } = await loadExt();
	const ctx = makeCtx({ tokens: 700 });
	const result = await emit(handlers, "input", { source: "extension", text: "replay" }, ctx);
	ok("extension replay continues", result?.action === "continue", JSON.stringify(result));
	ok("no compact for replay", ctx.compactCalls === 0, `calls=${ctx.compactCalls}`);
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
