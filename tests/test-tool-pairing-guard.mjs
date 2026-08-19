#!/usr/bin/env node
// Unit test for tool-pairing-guard.ts. Loads the actual extension and drives
// its repairToolPairing() helper through the __toolPairingGuardInternals
// back-door, asserting orphaned tool_results are dropped and dangling
// tool_uses are backfilled in the (Anthropic-shaped) provider payload.
// Usage: node tests/test-tool-pairing-guard.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Self-respawn under the stub-hook so the extension's @earendil-works/* imports
// resolve under node (mirrors test-context-diet.mjs).
if (!process.env.PI_TOOL_PAIRING_GUARD_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_TOOL_PAIRING_GUARD_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "tool-pairing-guard.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("tool-pairing-guard.ts has no default export");
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
const { repairToolPairing, hasToolBlocks, toolUseIds, rehomeCacheControl } =
	mockPi.__toolPairingGuardInternals;

// ─── Anthropic-shaped payload helpers ───────────────────────────────────────
function userText(t) { return { role: "user", content: [{ type: "text", text: t }] }; }
function asstUse(...ids) {
	return { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "bash", input: {} })) };
}
function userResults(...ids) {
	return { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) };
}

// ─── hasToolBlocks / no-op guarantee ────────────────────────────────────────
console.log("=== no-op when no tool blocks ===");
{
	const msgs = [userText("hi"), { role: "assistant", content: [{ type: "text", text: "hello" }] }];
	ok("hasToolBlocks false for plain text", hasToolBlocks(msgs) === false);
	const r = repairToolPairing(msgs);
	ok("returns input untouched", r.messages === msgs);
	ok("no repairs counted", r.orphanResultsDropped === 0 && r.syntheticResultsAdded === 0);
}

// ─── healthy conversation is left intact ─────────────────────────────────────
console.log("\n=== healthy pairing passes through ===");
{
	const msgs = [userText("do it"), asstUse("a"), userResults("a"), { role: "assistant", content: [{ type: "text", text: "done" }] }];
	const r = repairToolPairing(msgs);
	ok("no orphans dropped", r.orphanResultsDropped === 0, `got ${r.orphanResultsDropped}`);
	ok("no synthetic added", r.syntheticResultsAdded === 0, `got ${r.syntheticResultsAdded}`);
	ok("message count unchanged", r.messages.length === 4);
}

// ─── THE BUG: orphaned tool_result (assistant tool_use was dropped) ─────────
console.log("\n=== orphaned tool_result is dropped ===");
{
	// Simulates core dropping an errored assistant: the tool_use is gone but the
	// tool_result survives. messages.2 references id that messages.1 lacks.
	const msgs = [userText("go"), { role: "assistant", content: [{ type: "text", text: "thinking…" }] }, userResults("toolu_GONE")];
	const r = repairToolPairing(msgs);
	ok("one orphan dropped", r.orphanResultsDropped === 1, `got ${r.orphanResultsDropped}`);
	ok("emptied user message removed", r.messages.length === 2, `got ${r.messages.length}`);
	const hasOrphan = JSON.stringify(r.messages).includes("toolu_GONE");
	ok("no dangling tool_use_id remains", hasOrphan === false);
}

// ─── partial orphan: keep valid result, drop the orphan in same user msg ────
console.log("\n=== mixed valid + orphan results ===");
{
	const msgs = [userText("go"), asstUse("good"), { role: "user", content: [
		{ type: "tool_result", tool_use_id: "good", content: "ok" },
		{ type: "tool_result", tool_use_id: "bad", content: "ok" },
	] }];
	const r = repairToolPairing(msgs);
	ok("one orphan dropped", r.orphanResultsDropped === 1, `got ${r.orphanResultsDropped}`);
	const kept = r.messages[2].content;
	ok("valid result kept", kept.length === 1 && kept[0].tool_use_id === "good");
}

// ─── mirror 400: dangling tool_use gets a synthetic result ──────────────────
console.log("\n=== dangling tool_use backfilled ===");
{
	const msgs = [userText("go"), asstUse("x"), { role: "assistant", content: [{ type: "text", text: "next" }] }];
	const r = repairToolPairing(msgs);
	ok("one synthetic result added", r.syntheticResultsAdded === 1, `got ${r.syntheticResultsAdded}`);
	// A user message with the synthetic result must sit right after the asstUse.
	const after = r.messages[2];
	ok("synthetic user result inserted after assistant", after.role === "user" && after.content[0].tool_use_id === "x");
	ok("synthetic marked is_error", after.content[0].is_error === true);
}

// ─── dangling tool_use with a following user msg → merged in ─────────────────
console.log("\n=== dangling tool_use merged into following user turn ===");
{
	const msgs = [userText("go"), asstUse("x"), userText("more")];
	const r = repairToolPairing(msgs);
	ok("one synthetic result added", r.syntheticResultsAdded === 1, `got ${r.syntheticResultsAdded}`);
	ok("message count unchanged (merged)", r.messages.length === 3, `got ${r.messages.length}`);
	const merged = r.messages[2].content;
	ok("synthetic result prepended into existing user turn", merged.some((b) => b.type === "tool_result" && b.tool_use_id === "x"));
	ok("original user text preserved", merged.some((b) => b.type === "text" && b.text === "more"));
}

// ─── multiple tool calls, only some answered ────────────────────────────────
console.log("\n=== partially answered multi-call turn ===");
{
	const msgs = [userText("go"), asstUse("a", "b", "c"), userResults("a", "c")];
	const r = repairToolPairing(msgs);
	ok("missing 'b' backfilled", r.syntheticResultsAdded === 1, `got ${r.syntheticResultsAdded}`);
	const ids = r.messages[2].content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id).sort();
	ok("all three ids now present", ids.join(",") === "a,b,c", `got ${ids.join(",")}`);
}

// ─── cache_control is re-homed after a repair ───────────────────────────────
console.log("\n=== cache_control re-homed ===");
{
	const msgs = [
		userText("go"),
		{ role: "assistant", content: [{ type: "text", text: "no tools" }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "ok", cache_control: { type: "ephemeral" } }] },
		userText("trailing"),
	];
	const r = repairToolPairing(msgs);
	ok("orphan with cache_control dropped", r.orphanResultsDropped === 1);
	const last = r.messages[r.messages.length - 1];
	const lastBlock = last.content[last.content.length - 1];
	ok("cache_control moved to new last block", lastBlock.cache_control !== undefined);
}

// ─── toolUseIds helper ───────────────────────────────────────────────────────
console.log("\n=== toolUseIds helper ===");
{
	ok("collects ids", [...toolUseIds(asstUse("p", "q"))].sort().join(",") === "p,q");
	ok("empty for user msg", toolUseIds(userText("x")).size === 0);
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
