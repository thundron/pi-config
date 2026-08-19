#!/usr/bin/env node
// Unit test for compaction-diet.ts. Loads the actual extension, then exercises
// its trimForSummary() / makeStub() / planChunks() / computeBudgets() /
// parseModelRef() helpers through the __compactionDietInternals back-door the
// extension installs on the pi mock for testing.
// Usage: node tests/test-compaction-diet.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Self-respawn under the stub-hook so compaction-diet.ts's imports of
// @earendil-works/* (nested deps in pi-coding-agent) resolve under node.
if (!process.env.PI_COMPACTION_DIET_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_COMPACTION_DIET_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "compaction-diet.ts");

let pass = 0,
	fail = 0;
function ok(label, cond, hint = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.log(`  ✗ ${label}  ${hint}`);
	}
}

// Reset env influence so we test documented defaults.
for (const k of [
	"PI_COMPACTION_DIET_DISABLE",
	"PI_COMPACTION_DIET_MODE",
	"PI_COMPACTION_DIET_MAX_BYTES",
	"PI_COMPACTION_DIET_HEAD_BYTES",
	"PI_COMPACTION_DIET_TAIL_BYTES",
	"PI_COMPACTION_DIET_THINKING",
	"PI_COMPACTION_DIET_USABLE_FRACTION",
	"PI_COMPACTION_DIET_PROMPT_OVERHEAD",
	"PI_COMPACTION_DIET_MIN_CHUNK",
	"PI_COMPACTION_DIET_MODEL",
]) delete process.env[k];

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("compaction-diet.ts has no default export");
	process.exit(1);
}

const mockPi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: () => {},
	sendUserMessage: () => {},
	sendMessage: () => {},
};
mod.default(mockPi);

const { trimForSummary, makeStub, computeBudgets, planChunks, parseModelRef, tokensOf, byteLen, cfg } =
	mockPi.__compactionDietInternals;

function userMsg(t) {
	return { role: "user", content: [{ type: "text", text: t }], timestamp: 0 };
}
function asstMsg(t) {
	return {
		role: "assistant",
		content: [{ type: "text", text: t }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "x",
		usage: {},
		stopReason: "stop",
		timestamp: 0,
	};
}
function toolMsg(name, text, isError = false) {
	return { role: "toolResult", toolCallId: `t-${name}`, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

// ─── byteLen ───────────────────────────────────────────────────────────────

console.log("=== byteLen ===");
ok("ASCII", byteLen("hello") === 5);
ok("UTF-8 latin-1", byteLen("héllo") === 6);
ok("UTF-8 CJK", byteLen("中") === 3);
ok("UTF-8 emoji", byteLen("🗜") === 4);

// ─── makeStub ────────────────────────────────────────────────────────────

console.log("\n=== makeStub ===");
const big = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
const compressed = makeStub("bash", byteLen(big), "compress", big, cfg);
ok("compress keeps head", compressed.startsWith("A".repeat(cfg.headBytes)));
ok("compress keeps tail", compressed.endsWith("Z".repeat(cfg.tailBytes)));
ok("compress shorter than original", byteLen(compressed) < byteLen(big));
ok("compress has the marker", compressed.includes("compaction-diet trimmed"));

const torn = makeStub("bash", byteLen(big), "tear-out", big, cfg);
ok("tear-out is short", byteLen(torn) < 200);
ok("tear-out names the tool", torn.includes("bash"));
ok("tear-out names byte savings", torn.includes("B reclaimed"));

const tiny = "small output";
ok("compress passthrough when below head+tail", makeStub("bash", byteLen(tiny), "compress", tiny, cfg) === tiny);

// ─── trimForSummary ──────────────────────────────────────────────────────

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
	toolMsg("grep", "ok\n"), // small, untouched
];
const r = trimForSummary(span, cfg);
ok("two oversized tool results trimmed", r.trimmed === 2, `got ${r.trimmed}`);
ok("bytes saved > 30 KB", r.bytesSaved > 30000, `saved=${r.bytesSaved}`);
ok("small result preserved verbatim", r.msgs[6].content[0].text === "ok\n");
ok("non-tool messages untouched", r.msgs[0] === span[0] && r.msgs[1] === span[1]);
ok("original array not mutated", span[2].content[0].text.length === 20000);

// errors are trimmed too when oversized (whole span is being summarized away)
console.log("\n=== trimForSummary (oversized errors) ===");
const errSpan = [userMsg("u"), asstMsg("a"), toolMsg("bash", "E".repeat(20000), true)];
const rErr = trimForSummary(errSpan, cfg);
ok("oversized error result is trimmed", rErr.trimmed === 1, `got ${rErr.trimmed}`);
const smallErrSpan = [userMsg("u"), asstMsg("a"), toolMsg("bash", "boom\n", true)];
ok("small error result preserved", trimForSummary(smallErrSpan, cfg).trimmed === 0);

// tear-out mode
console.log("\n=== trimForSummary (tear-out) ===");
cfg.mode = "tear-out";
const rt = trimForSummary(span, cfg);
ok("tear-out trims oversized results", rt.trimmed === 2);
ok("tear-out replaced content with stub", rt.msgs[2].content[0].text.includes("torn out"));
cfg.mode = "compress";

// ─── computeBudgets ──────────────────────────────────────────────────────

console.log("\n=== computeBudgets ===");
const bigModel = { contextWindow: 400000, maxTokens: 64000 };
const b = computeBudgets(bigModel, 16384, cfg);
ok("single budget positive and large", b.single > 300000, `single=${b.single}`);
ok("chunk budget < single budget", b.chunk < b.single, `chunk=${b.chunk} single=${b.single}`);
ok("chunk leaves room for running summary", b.single - b.chunk >= Math.floor(0.8 * 16384) - 1, `gap=${b.single - b.chunk}`);

const smallModel = { contextWindow: 8000, maxTokens: 4000 };
const bs = computeBudgets(smallModel, 16384, cfg);
ok("tiny window floors at minChunkTokens", bs.chunk === cfg.minChunkTokens && bs.single === cfg.minChunkTokens, `single=${bs.single} chunk=${bs.chunk}`);

const noMax = computeBudgets({ contextWindow: 200000, maxTokens: 0 }, 16384, cfg);
ok("missing maxTokens still yields finite budgets", Number.isFinite(noMax.single) && Number.isFinite(noMax.chunk));

// ─── planChunks ──────────────────────────────────────────────────────────

console.log("\n=== planChunks ===");
const many = [];
for (let i = 0; i < 10; i++) many.push(userMsg("w".repeat(4000))); // ~1k tokens each
const oneChunk = planChunks(many, 100000);
ok("everything fits in one chunk under a big budget", oneChunk.length === 1);
const split = planChunks(many, 2500); // ~2 messages per chunk
ok("splits into multiple chunks under a small budget", split.length > 1, `chunks=${split.length}`);
ok("chunks cover every message", split.reduce((n, c) => n + c.length, 0) === many.length);
ok("each chunk preserves message order", split[0][0] === many[0]);
const lone = planChunks([userMsg("z".repeat(80000))], 1000); // single message over budget
ok("an over-budget single message still becomes one chunk", lone.length === 1 && lone[0].length === 1);

// ─── parseModelRef ───────────────────────────────────────────────────────

console.log("\n=== parseModelRef ===");
ok("valid provider/id", JSON.stringify(parseModelRef("google/gemini-2.5-pro")) === JSON.stringify({ provider: "google", id: "gemini-2.5-pro" }));
ok("id with slashes keeps remainder", parseModelRef("openai/gpt-5/mini").id === "gpt-5/mini");
ok("missing slash → null", parseModelRef("gemini") === null);
ok("leading slash → null", parseModelRef("/id") === null);
ok("trailing slash → null", parseModelRef("provider/") === null);

// ─── tokensOf ────────────────────────────────────────────────────────────

console.log("\n=== tokensOf ===");
ok("tokensOf is positive for non-empty span", tokensOf(span) > 0);
ok("tokensOf grows with content", tokensOf([userMsg("a".repeat(8000))]) > tokensOf([userMsg("a")]));

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
