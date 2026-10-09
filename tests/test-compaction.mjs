#!/usr/bin/env node
// Unit tests for compaction.ts (the unified trigger + diet extension).
// Exercises the diet helpers (trimForSummary / makeStub / computeBudgets /
// planChunks / parseModelRef / tokensOf) and the trigger behavior
// (shouldCompact / post-turn / pre-input replay) through the
// __compactionInternals back-door the extension installs on the pi mock.
// Usage: node tests/test-compaction.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Self-respawn under the stub-hook so compaction.ts's import of
// @earendil-works/pi-coding-agent (nested deps) resolves under node.
if (!process.env.PI_COMPACTION_TEST_BOOTSTRAPPED) {
	const hook = resolve(__dirname, "lib", "stub-hook-register.mjs");
	const r = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings=DeprecationWarning", "--import", hook, fileURLToPath(import.meta.url)],
		{ stdio: "inherit", env: { ...process.env, PI_COMPACTION_TEST_BOOTSTRAPPED: "1" } },
	);
	process.exit(r.status ?? 1);
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "compaction.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

function userMsg(t) {
	return { role: "user", content: [{ type: "text", text: t }], timestamp: 0 };
}
function asstMsg(t) {
	return { role: "assistant", content: [{ type: "text", text: t }], api: "anthropic-messages", provider: "anthropic", timestamp: 0 };
}
function toolMsg(name, text, isError = false) {
	return { role: "toolResult", toolCallId: `t-${name}`, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

// ════════════════════════════════════════════════════════════════════════════
// DIET helpers — single shared import with default config.
// ════════════════════════════════════════════════════════════════════════════

for (const k of Object.keys(process.env)) {
	if (k.startsWith("PI_COMPACTION_")) delete process.env[k];
}
const dietMod = await import(`${EXT_PATH}?diet=1`);
if (typeof dietMod.default !== "function") {
	console.error("compaction.ts has no default export");
	process.exit(1);
}
const dietPi = { on: () => {}, registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {}, sendMessage: () => {} };
dietMod.default(dietPi);
const { trimForSummary, makeStub, computeBudgets, planChunks, parseModelRef, tokensOf, byteLen, normalizeHeaders, cfg } = dietPi.__compactionInternals;

console.log("=== provider headers ===");
ok("undefined headers remain undefined", normalizeHeaders(undefined) === undefined);
ok("null headers are omitted and strings retained", JSON.stringify(normalizeHeaders({ drop: null, keep: "value", empty: "" })) === JSON.stringify({ keep: "value", empty: "" }));

console.log("=== byteLen ===");
ok("ASCII", byteLen("hello") === 5);
ok("UTF-8 latin-1", byteLen("héllo") === 6);
ok("UTF-8 CJK", byteLen("中") === 3);
ok("UTF-8 emoji", byteLen("📦") === 4);

console.log("\n=== makeStub ===");
const big = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
const compressed = makeStub("bash", byteLen(big), "compress", big, cfg);
ok("compress keeps head", compressed.startsWith("A".repeat(cfg.headBytes)));
ok("compress keeps tail", compressed.endsWith("Z".repeat(cfg.tailBytes)));
ok("compress shorter than original", byteLen(compressed) < byteLen(big));
ok("compress has the marker", compressed.includes("compaction trimmed"));

const torn = makeStub("bash", byteLen(big), "tear-out", big, cfg);
ok("tear-out is short", byteLen(torn) < 200);
ok("tear-out names the tool", torn.includes("bash"));
ok("tear-out names byte savings", torn.includes("B reclaimed"));

const tiny = "small output";
ok("compress passthrough when below head+tail", makeStub("bash", byteLen(tiny), "compress", tiny, cfg) === tiny);

console.log("\n=== trimForSummary ===");
cfg.mode = "compress";
cfg.maxResultBytes = 4096;
const span = [
	userMsg("u1"),
	asstMsg("a1"),
	toolMsg("bash", "x".repeat(20000)),
	userMsg("u2"),
	asstMsg("a2"),
	toolMsg("read", "y".repeat(20000)),
	toolMsg("grep", "ok\n"),
];
const r = trimForSummary(span, cfg);
ok("two oversized tool results trimmed", r.trimmed === 2, `got ${r.trimmed}`);
ok("bytes saved > 30 KB", r.bytesSaved > 30000, `saved=${r.bytesSaved}`);
ok("small result preserved verbatim", r.msgs[6].content[0].text === "ok\n");
ok("non-tool messages untouched", r.msgs[0] === span[0] && r.msgs[1] === span[1]);
ok("original array not mutated", span[2].content[0].text.length === 20000);

console.log("\n=== trimForSummary (oversized errors) ===");
const errSpan = [userMsg("u"), asstMsg("a"), toolMsg("bash", "E".repeat(20000), true)];
ok("oversized error result is trimmed", trimForSummary(errSpan, cfg).trimmed === 1);
const smallErrSpan = [userMsg("u"), asstMsg("a"), toolMsg("bash", "boom\n", true)];
ok("small error result preserved", trimForSummary(smallErrSpan, cfg).trimmed === 0);

console.log("\n=== trimForSummary (tear-out) ===");
cfg.mode = "tear-out";
const rt = trimForSummary(span, cfg);
ok("tear-out trims oversized results", rt.trimmed === 2);
ok("tear-out replaced content with stub", rt.msgs[2].content[0].text.includes("torn out"));
cfg.mode = "compress";

console.log("\n=== computeBudgets ===");
const b = computeBudgets({ contextWindow: 400000, maxTokens: 64000 }, 16384, cfg);
ok("single budget positive and large", b.single > 300000, `single=${b.single}`);
ok("chunk budget < single budget", b.chunk < b.single, `chunk=${b.chunk} single=${b.single}`);
ok("chunk leaves room for running summary", b.single - b.chunk >= Math.floor(0.8 * 16384) - 1, `gap=${b.single - b.chunk}`);
const bs = computeBudgets({ contextWindow: 8000, maxTokens: 4000 }, 16384, cfg);
ok("tiny window floors at minChunkTokens", bs.chunk === cfg.minChunkTokens && bs.single === cfg.minChunkTokens, `single=${bs.single} chunk=${bs.chunk}`);
const noMax = computeBudgets({ contextWindow: 200000, maxTokens: 0 }, 16384, cfg);
ok("missing maxTokens still yields finite budgets", Number.isFinite(noMax.single) && Number.isFinite(noMax.chunk));

console.log("\n=== planChunks ===");
const many = [];
for (let i = 0; i < 10; i++) many.push(userMsg("w".repeat(4000)));
ok("everything fits in one chunk under a big budget", planChunks(many, 100000).length === 1);
const split = planChunks(many, 2500);
ok("splits into multiple chunks under a small budget", split.length > 1, `chunks=${split.length}`);
ok("chunks cover every message", split.reduce((n, c) => n + c.length, 0) === many.length);
ok("each chunk preserves message order", split[0][0] === many[0]);
const lone = planChunks([userMsg("z".repeat(80000))], 1000);
ok("an over-budget single message still becomes one chunk", lone.length === 1 && lone[0].length === 1);

console.log("\n=== parseModelRef ===");
ok("valid provider/id", JSON.stringify(parseModelRef("google/gemini-2.5-pro")) === JSON.stringify({ provider: "google", id: "gemini-2.5-pro" }));
ok("id with slashes keeps remainder", parseModelRef("openai/gpt-5/mini").id === "gpt-5/mini");
ok("missing slash → null", parseModelRef("gemini") === null);
ok("leading slash → null", parseModelRef("/id") === null);
ok("trailing slash → null", parseModelRef("provider/") === null);

console.log("\n=== tokensOf ===");
ok("tokensOf is positive for non-empty span", tokensOf(span) > 0);
ok("tokensOf grows with content", tokensOf([userMsg("a".repeat(8000))]) > tokensOf([userMsg("a")]));

// ════════════════════════════════════════════════════════════════════════════
// TRIGGER behavior — fresh import per case so module state is isolated.
// ════════════════════════════════════════════════════════════════════════════

async function loadTrigger() {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("PI_COMPACTION_") && k !== "PI_COMPACTION_TEST_BOOTSTRAPPED") delete process.env[k];
	}
	process.env.PI_COMPACTION_MIN_CONTEXT = "1000";
	process.env.PI_COMPACTION_FRACTION = "0.5";
	process.env.PI_COMPACTION_POST_TURN_DELAY_MS = "1";
	const mod = await import(`${EXT_PATH}?trigger=${Date.now()}-${Math.random()}`);
	const handlers = new Map();
	const sent = [];
	const commands = new Map();
	const mockPi = {
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: () => {},
		sendUserMessage: (message) => sent.push(message),
		sendMessage: () => {},
	};
	mod.default(mockPi);
	return { handlers, sent, commands, internals: mockPi.__compactionInternals };
}

function makeCtx({ tokens = 600, pending = false, idle = true } = {}) {
	const notifications = [];
	let compactCalls = 0;
	return {
		hasUI: true,
		ui: { setStatus: () => {}, notify: (message, type) => notifications.push({ message, type }) },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 1000, percent: tokens / 10 }),
		compact: (opts) => { compactCalls += 1; opts?.onComplete?.({}); },
		get compactCalls() { return compactCalls; },
		notifications,
	};
}

async function emit(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) ?? []) {
		const res = await h(payload, ctx);
		if (res) return res;
	}
	return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n=== shouldCompact ===");
{
	const { internals } = await loadTrigger();
	ok("compacts above threshold", internals.shouldCompact(makeCtx({ tokens: 600 })).compact === true);
	ok("does not compact below threshold", internals.shouldCompact(makeCtx({ tokens: 400 })).compact === false);
	ok("does not compact with pending messages", internals.shouldCompact(makeCtx({ tokens: 600, pending: true })).reason === "pending-messages");
	ok("post-turn instructions mention next prompt", internals.compactInstructions("post-turn").includes("next user prompt"));
}

console.log("\n=== master switch gates the trigger ===");
{
	const { internals } = await loadTrigger();
	internals.cfg.enabled = false;
	ok("disabled master → shouldCompact false", internals.shouldCompact(makeCtx({ tokens: 900 })).compact === false);
	ok("reason is disabled", internals.shouldCompact(makeCtx({ tokens: 900 })).reason === "disabled");
	internals.cfg.enabled = true;
	internals.cfg.triggerEnabled = false;
	ok("trigger sub-toggle off → shouldCompact false", internals.shouldCompact(makeCtx({ tokens: 900 })).compact === false);
}

console.log("\n=== post-turn compaction ===");
{
	const { handlers } = await loadTrigger();
	const ctx = makeCtx({ tokens: 700 });
	await emit(handlers, "agent_end", { messages: [] }, ctx);
	await sleep(15);
	ok("agent_end schedules compaction", ctx.compactCalls === 1, `calls=${ctx.compactCalls}`);
	ok("notifies post-turn compaction", ctx.notifications.some((n) => n.message.includes("Post-turn auto-compaction")), JSON.stringify(ctx.notifications));
}

console.log("\n=== pre-input path still replays prompt ===");
{
	const { handlers, sent } = await loadTrigger();
	const ctx = makeCtx({ tokens: 700 });
	const result = await emit(handlers, "input", { source: "interactive", text: "please continue" }, ctx);
	ok("input handled for compaction", result?.action === "handled", JSON.stringify(result));
	ok("pre-input compaction called", ctx.compactCalls === 1, `calls=${ctx.compactCalls}`);
	ok("prompt replayed after compact", sent[0] === "please continue", JSON.stringify(sent));
}

console.log("\n=== extension replay bypass ===");
{
	const { handlers } = await loadTrigger();
	const ctx = makeCtx({ tokens: 700 });
	const result = await emit(handlers, "input", { source: "extension", text: "replay" }, ctx);
	ok("extension replay continues", result?.action === "continue", JSON.stringify(result));
	ok("no compact for replay", ctx.compactCalls === 0, `calls=${ctx.compactCalls}`);
}

console.log("\n=== compaction intent lifecycle ===");
{
	const { internals } = await loadTrigger();
	const { startCompaction, compactionIntentRegistry, shouldCompact } = internals;
	const ctx = makeCtx();
	let captured;
	ctx.compact = (options) => {
		ok("intent exists inside ctx.compact", compactionIntentRegistry().count === 1);
		captured = options;
	};
	startCompaction(ctx, "post-turn");
	ok("in-flight compaction blocks another trigger", !shouldCompact(ctx).compact);
	captured.onComplete();
	ok("completion releases intent", compactionIntentRegistry().count === 0 && shouldCompact(ctx).compact);
	captured.onComplete();
	ok("intent release is idempotent", compactionIntentRegistry().count === 0);
	let errorReceived;
	startCompaction(ctx, "pre-input", undefined, (error) => { errorReceived = error; });
	const error = new Error("compaction failed");
	captured.onError(error);
	ok("failure releases intent and forwards error", compactionIntentRegistry().count === 0 && shouldCompact(ctx).compact && errorReceived === error);
	ctx.compact = () => { throw error; };
	let thrown;
	try { startCompaction(ctx, "pre-input"); } catch (err) { thrown = err; }
	ok("synchronous throw releases intent and resets in-flight state", thrown === error && compactionIntentRegistry().count === 0 && shouldCompact(ctx).compact);
}

console.log("\n=== unified command and pending trigger cancellation ===");
{
	const { handlers, commands, internals } = await loadTrigger();
	ok("registers only the unified command", commands.size === 1 && commands.has("compaction"));
	const ctx = makeCtx();
	const command = commands.get("compaction");
	await emit(handlers, "agent_end", {}, ctx);
	await command.handler("off", ctx);
	await sleep(15);
	ok("master off cancels scheduled post-turn compaction", ctx.compactCalls === 0);
	ok("master off gates pre-input", (await emit(handlers, "input", { source: "interactive", text: "continue" }, ctx))?.action === "continue");
	await command.handler("diet off", ctx);
	await command.handler("on", ctx);
	ok("master on preserves per-half settings", internals.cfg.enabled && !internals.cfg.dietEnabled && internals.cfg.triggerEnabled);
	await command.handler("fraction 0.75", ctx);
	ok("fraction command updates trigger threshold", internals.cfg.fraction === 0.75 && !internals.shouldCompact(ctx).compact);
	await command.handler("fraction 1", ctx);
	ok("invalid fraction leaves config unchanged", internals.cfg.fraction === 0.75);
}

console.log("\n=== summarization dispatch and safe fallback ===");
{
	const { handlers, internals } = await loadTrigger();
	const ctx = makeCtx();
	const event = {
		preparation: {
			messagesToSummarize: [userMsg("preserve my goal")],
			turnPrefixMessages: [],
			settings: { reserveTokens: 16384 },
			firstKeptEntryId: "kept-entry",
			tokensBefore: 600,
		},
		customInstructions: "preserve goals",
	}; // Deliberately omit signal, as some pi runtimes do.
	internals.cfg.enabled = false;
	ok("master off bypasses summarization", await emit(handlers, "session_before_compact", event, ctx) === undefined);
	internals.cfg.enabled = true;
	internals.cfg.dietEnabled = false;
	ok("diet off bypasses summarization", await emit(handlers, "session_before_compact", event, ctx) === undefined);
	internals.cfg.dietEnabled = true;
	ok("missing model falls back to core", await emit(handlers, "session_before_compact", event, ctx) === undefined);
	ctx.model = { provider: "test", id: "test-model", contextWindow: 128000, maxTokens: 4000 };
	ctx.modelRegistry = { getApiKeyAndHeaders: async () => { throw new Error("auth unavailable"); } };
	ok("auth exception falls back instead of escaping", await emit(handlers, "session_before_compact", event, ctx) === undefined);
	ok("auth failure updates fallback stats", internals.stats.lastFallback);
	ok("auth failure reports the cause", ctx.notifications.some((n) => n.message.includes("auth unavailable")));
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "missing credentials" });
	ok("missing credentials falls back to core", await emit(handlers, "session_before_compact", event, ctx) === undefined);

	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: { remove: null, keep: "value" } });
	const result = await emit(handlers, "session_before_compact", event, ctx);
	ok("summarization accepts missing abort signal", result?.compaction?.summary === "STUB SUMMARY");
	ok("preserves compaction entry metadata", result?.compaction?.firstKeptEntryId === "kept-entry" && result?.compaction?.tokensBefore === 600);
	ok("successful summary clears fallback stats", internals.stats.runs === 1 && !internals.stats.lastFallback);
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
