#!/usr/bin/env node
// Unit test for context-diet.ts. Loads the actual extension, then exercises
// its rewriteContext() / makeStub() / recentMessageCutoff() / byteLen()
// helpers through the __contextDietInternals back-door the extension installs
// on the pi mock for testing.
// Usage: bun run tests/test-context-diet.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "context-diet.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

// Reset any env-var influence so we test the documented defaults.
for (const k of [
	"PI_CONTEXT_DIET_DISABLE",
	"PI_CONTEXT_DIET_MODE",
	"PI_CONTEXT_DIET_KEEP_TURNS",
	"PI_CONTEXT_DIET_MAX_BYTES",
	"PI_CONTEXT_DIET_HEAD_BYTES",
	"PI_CONTEXT_DIET_TAIL_BYTES",
	"PI_CONTEXT_DIET_KEEP_ERRORS",
]) delete process.env[k];

// Cache-bust so DEFAULT_CONFIG is recomputed from the (clean) env above.
const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("context-diet.ts has no default export");
	process.exit(1);
}

const internals = {};
const mockPi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: () => {},
	sendUserMessage: () => {},
	sendMessage: () => {},
};
mod.default(mockPi);
// The extension stashes its internals on the mock for tests.
const {
	rewriteContext,
	makeStub,
	recentMessageCutoff,
	byteLen,
	messageByteLen,
	cfg,
} = (mockPi).__contextDietInternals;

// ─── byteLen ───────────────────────────────────────────────────────────────

console.log("=== byteLen ===");
ok("ASCII string length",       byteLen("hello") === 5);
ok("UTF-8 latin-1 string",       byteLen("héllo") === 6); // é = 2 bytes
ok("UTF-8 3-byte char (CJK)",    byteLen("中") === 3);
ok("UTF-8 4-byte char (emoji)",  byteLen("📉") === 4);
ok("empty",                      byteLen("") === 0);

// ─── recentMessageCutoff ───────────────────────────────────────────────────

console.log("\n=== recentMessageCutoff ===");
function userMsg(t) { return { role: "user", content: [{ type: "text", text: t }], timestamp: 0 }; }
function asstMsg(t) { return { role: "assistant", content: [{ type: "text", text: t }], api: "anthropic-messages", provider: "anthropic", model: "x", usage: {}, stopReason: "stop", timestamp: 0 }; }
function toolMsg(name, text, isError = false) {
	return { role: "toolResult", toolCallId: `t-${name}`, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

const branch = [
	userMsg("u1"), asstMsg("a1"), toolMsg("bash","x".repeat(20000)),
	userMsg("u2"), asstMsg("a2"), toolMsg("read","y".repeat(20000)),
	userMsg("u3"), asstMsg("a3"), toolMsg("find","z".repeat(20000)),
	userMsg("u4"), asstMsg("a4"),
];
ok("keep 0 → cutoff at end (everything is eligible to trim)",
   recentMessageCutoff(branch, 0) === branch.length);
ok("keep 1 → cutoff is index of u4",
   recentMessageCutoff(branch, 1) === branch.findIndex((m,i) => i >= 9 && m.role === "user"));
ok("keep 3 → cutoff is index of u2",
   recentMessageCutoff(branch, 3) === branch.findIndex((m,i) => i >= 3 && m.role === "user"));
ok("keep 99 (more than exist) → cutoff 0",
   recentMessageCutoff(branch, 99) === 0);

// ─── makeStub ──────────────────────────────────────────────────────────────

console.log("\n=== makeStub ===");
const big = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
const compressed = makeStub("bash", byteLen(big), "compress", big, cfg);
ok("compress keeps head", compressed.startsWith("A".repeat(cfg.headBytes)));
ok("compress keeps tail", compressed.endsWith("Z".repeat(cfg.tailBytes)));
ok("compress is shorter than original", byteLen(compressed) < byteLen(big));
ok("compress contains the trim marker", compressed.includes("context-diet trimmed"));

const torn = makeStub("bash", byteLen(big), "tear-out", big, cfg);
ok("tear-out stub is short", byteLen(torn) < 200);
ok("tear-out names the tool",  torn.includes("bash"));
ok("tear-out names byte savings", torn.includes("B reclaimed"));

const tiny = "small output";
const noop = makeStub("bash", byteLen(tiny), "compress", tiny, cfg);
ok("compress passthrough when smaller than head+tail+overhead", noop === tiny);

// ─── rewriteContext: old tool results compressed, recent ones kept ─────────

console.log("\n=== rewriteContext (recent-turn cutoff) ===");
// Build a branch with SMALL tool results in the recent window and LARGE ones
// earlier so the cutoff and size-threshold rules can be exercised separately.
const mixedBranch = [
	userMsg("u1"), asstMsg("a1"), toolMsg("bash", "x".repeat(20000)),
	userMsg("u2"), asstMsg("a2"), toolMsg("read", "y".repeat(20000)),
	userMsg("u3"), asstMsg("a3"), toolMsg("find", "ok\n"),                    // recent + small
	userMsg("u4"), asstMsg("a4"), toolMsg("grep", "5 matches\n"),               // recent + small
];
cfg.keepRecentTurns = 2;
cfg.maxResultBytes = 8192;
cfg.mode = "compress";
const { trimmed, bytesSaved } = rewriteContext(mixedBranch, cfg);
ok("old large results trimmed, recent small results preserved", trimmed === 2, `got trimmed=${trimmed}`);
ok("bytes saved > 30 KB",                                       bytesSaved > 30000, `saved=${bytesSaved}`);
// keepRecentTurns=99 → cutoff at index 0 → no cutoff trimming; large ones still trim by size.
cfg.keepRecentTurns = 99;
const r2 = rewriteContext(mixedBranch, cfg);
ok("size threshold still trims oversized results when nothing is past the cutoff", r2.trimmed === 2, `got trimmed=${r2.trimmed}`);

// ─── rewriteContext: preserve errors ───────────────────────────────────────

console.log("\n=== rewriteContext (preserveErrors) ===");
cfg.keepRecentTurns = 0;
cfg.maxResultBytes = 8192;
cfg.preserveErrors = true;
const errBranch = [
	userMsg("u"), asstMsg("a"), toolMsg("bash", "X".repeat(20000), /*isError*/ true),
];
const rErr = rewriteContext(errBranch, cfg);
ok("error result NOT trimmed when preserveErrors=true", rErr.trimmed === 0);

cfg.preserveErrors = false;
const rErr2 = rewriteContext(errBranch, cfg);
ok("error result trimmed when preserveErrors=false", rErr2.trimmed === 1);

// ─── tear-out mode strips content entirely ─────────────────────────────────

console.log("\n=== rewriteContext (tear-out mode) ===");
cfg.mode = "tear-out";
cfg.keepRecentTurns = 0;
cfg.maxResultBytes = 8192;
cfg.preserveErrors = true;
const teared = rewriteContext(branch, cfg);
ok("tear-out trims all eligible tool results", teared.trimmed === 3);
const trText = teared.msgs.find((m, i) => m.role === "toolResult").content[0].text;
ok("tear-out replaced content with a tear-out stub", trText.includes("torn out"));
ok("tear-out savings > compress savings (rough)", teared.bytesSaved > 50000);

// ─── small tool results are left alone in compress mode ───────────────────

console.log("\n=== rewriteContext (small results pass through) ===");
cfg.mode = "compress";
cfg.keepRecentTurns = 0;
cfg.maxResultBytes = 8192;
const smallBranch = [
	userMsg("u"), asstMsg("a"), toolMsg("bash", "ok\n"),
];
const rSmall = rewriteContext(smallBranch, cfg);
ok("small result not trimmed in compress mode", rSmall.trimmed === 0, `got trimmed=${rSmall.trimmed}`);

// ─── disabled config short-circuits (rewriteContext doesn't check; caller does) ───

console.log("\n=== messageByteLen ===");
const um = userMsg("hello world");
ok("user message byte length",        messageByteLen(um) === 11);
const tm = toolMsg("bash", "x".repeat(100));
ok("toolResult byte length",          messageByteLen(tm) === 100);
const am = asstMsg("hi");
ok("assistant message byte length",   messageByteLen(am) === 2);

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
