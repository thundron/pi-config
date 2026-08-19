#!/usr/bin/env node
// Unit tests for context-tools.ts.
// Usage: node tests/test-context-tools.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_CONTEXT_TOOLS_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_CONTEXT_TOOLS_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "context-tools.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("context-tools.ts has no default export");
	process.exit(1);
}

const tools = [];
const mockPi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: (tool) => tools.push(tool),
	sendUserMessage: () => {},
	sendMessage: () => {},
};
mod.default(mockPi);
const { computeTokensLeft, renderContextRemaining } = mockPi.__contextToolsInternals;

console.log("=== computeTokensLeft ===");
ok("unknown when usage missing", computeTokensLeft(undefined) === null);
ok("unknown when tokens null", computeTokensLeft({ tokens: null, contextWindow: 1000 }) === null);
ok("subtracts usage from context window", computeTokensLeft({ tokens: 250, contextWindow: 1000 }) === 750);
ok("clamps below zero", computeTokensLeft({ tokens: 1200, contextWindow: 1000 }) === 0);
ok("floors fractional value defensively", computeTokensLeft({ tokens: 10.7, contextWindow: 100 }) === 89);

console.log("\n=== renderContextRemaining ===");
ok("renders known token budget fragment", renderContextRemaining(42) === "<token_budget>\nYou have 42 tokens left in this context window.\n</token_budget>");
ok("renders unknown token budget fragment", renderContextRemaining(null) === "<token_budget>\nYou have unknown tokens left in this context window.\n</token_budget>");

console.log("\n=== tool registration/execution ===");
ok("registers one tool", tools.length === 1, `got ${tools.length}`);
ok("tool name matches Codex", tools[0]?.name === "get_context_remaining", tools[0]?.name);
{
	const ctx = { getContextUsage: () => ({ tokens: 300, contextWindow: 1000, percent: 30 }) };
	const result = await tools[0].execute("id", {}, new AbortController().signal, () => {}, ctx);
	ok("tool details match Codex schema", result.details?.tokens_left === 700, JSON.stringify(result.details));
	ok("tool content includes token budget fragment", result.content?.[0]?.text?.includes("You have 700 tokens left"));
}
{
	const ctx = { getContextUsage: () => undefined };
	const result = await tools[0].execute("id", {}, new AbortController().signal, () => {}, ctx);
	ok("tool returns null when unavailable", result.details?.tokens_left === null, JSON.stringify(result.details));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
