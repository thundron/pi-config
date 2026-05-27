#!/usr/bin/env node
/**
 * Integration test for guardian.ts's tool_call execpolicy enforcement.
 *
 * Loads the actual extension via dynamic import (so we exercise the real
 * registered handler, not a duplicated copy of the rule list) and feeds
 * it synthetic BashToolCallEvent objects. Asserts that:
 *   - Forbidden commands return { block: true, reason: ... }
 *   - Allowed commands return undefined (= pass through)
 *   - Outside-subagent context relaxes the sub-agent-only rules
 *     (e.g. `git push` is allowed outside a sub-agent)
 *   - Chained commands (`a && b`) check every segment
 *
 * Complements `test-execpolicy.mjs` (which tests the rule list in
 * isolation via a duplicated tokenizer copy). This file tests the
 * actual extension's tool_call hook end-to-end.
 *
 * Runs cross-platform (macOS / Linux / WSL) — no shell-out, just JS.
 *
 * Usage:  bun run tests/test-guardian-toolcall.mjs
 *    or:  node --experimental-strip-types tests/test-guardian-toolcall.mjs
 *         (bun is preferred since pi itself uses bun for .ts extensions)
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Self-respawn under the stub-hook so guardian.ts's imports of
// @earendil-works/pi-coding-agent (which lives in pi-coding-agent's nested
// node_modules) resolve to no-op stubs under stand-alone node. Bun follows
// nested deps natively and skips this branch.
const __dirname0 = dirname(fileURLToPath(import.meta.url));
if (!process.env.PI_GUARDIAN_TEST_BOOTSTRAPPED) {
	const isBun = typeof globalThis.Bun !== "undefined" || /bun/i.test(process.execPath);
	if (!isBun) {
		const hook = resolve(__dirname0, "lib", "stub-hook-register.mjs");
		const r = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings=DeprecationWarning",
				"--import",
				hook,
				fileURLToPath(import.meta.url),
			],
			{ stdio: "inherit", env: { ...process.env, PI_GUARDIAN_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

// Locate the guardian.ts file relative to this test file's location so
// the test works from any CWD (including a fresh `git clone`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARDIAN_PATH = resolve(__dirname, "..", "agent", "extensions", "guardian.ts");

// Belt-and-braces: clean env so this test isn't influenced by a parent
// pi session's state. The guardian itself uses globalThis now, but env
// vars still influence IN_SUBAGENT detection.
for (const key of [
	"PI_GUARDIAN_LOADED",
	"PI_GUARDIAN_RUN_ID",
	"PI_GUARDIAN_AGENT_ID",
	"PI_GUARDIAN_AGENT_DIR",
	"PI_GUARDIAN_RUN_DIR",
	"PI_FLEET_RUN_ID",
	"PI_FLEET_AGENT_ID",
	"PI_FLEET_AGENT_DIR",
	"PI_FLEET_STATE_DIR",
]) {
	delete process.env[key];
}
delete globalThis.__pi_guardian_loaded__;

const handlers = {};
const mockPi = {
	on: (ev, cb) => {
		handlers[ev] = cb;
	},
	registerCommand: () => {},
	registerTool: () => {},
	sendUserMessage: () => {},
	sendMessage: () => {},
};

const mod = await import(GUARDIAN_PATH);
if (typeof mod.default !== "function") {
	console.error(`guardian.ts has no default export (got ${typeof mod.default})`);
	process.exit(1);
}
mod.default(mockPi);

if (!handlers.tool_call) {
	console.error("guardian.ts did not register a tool_call handler");
	process.exit(1);
}

async function tryCmd(label, command, expectBlocked) {
	const event = {
		toolName: "bash",
		toolCallId: "t1",
		input: { command },
	};
	const result = await handlers.tool_call(event, {});
	const blocked = Boolean(result && result.block === true);
	const ok = blocked === expectBlocked;
	const reason = blocked && result.reason ? result.reason.slice(0, 60) : "";
	console.log(
		`  ${ok ? "✓" : "✗"} ${label}  expected=${expectBlocked} got=${blocked}${reason ? "  [" + reason + "]" : ""}`,
	);
	return ok;
}

let pass = 0;
let fail = 0;

console.log("=== outside-subagent context (no PI_GUARDIAN_RUN_ID/AGENT_ID) ===");
const outsideCases = [
	["forbid find /", "find / -name x", true],
	["allow find .", "find . -name x", false],
	["forbid rm -rf /", "rm -rf /", true],
	["allow rm -rf ./tmp", "rm -rf ./tmp", false],
	["forbid grep -r foo /", "grep -r foo /", true],
	["allow grep -r foo ./src", "grep -r foo ./src", false],
	["forbid rg foo /", "rg foo /", true],
	["allow rg foo (default cwd)", "rg foo", false],
	["forbid du /", "du / -sh", true],
	["allow du ./build", "du ./build -sh", false],
	["forbid tree /", "tree /", true],
	["forbid chained && rm -rf /", "echo hi && rm -rf /", true],
	["forbid chained ; find /", "cd foo; find /", true],
	// sub-agent-only rules are gated OFF outside a sub-agent
	["allow git push outside subagent", "git push origin main", false],
	["allow git status", "git status", false],
	["allow echo hi", "echo hi", false],
	["forbid find /mnt (WSL guard)", "find /mnt -name x", true],
	// ←— actual commands that escaped guardian into a real session before the
	// matcher-bug fix. Keep these as regression tests.
	[
		"forbid find /mnt/c/Users (WSL subpath — actual escape)",
		"find /mnt/c/Users -name '*.gguf' 2>/dev/null | head -20",
		true,
	],
	[
		"forbid find /mnt/c/Users/thund (multi-name find — actual escape)",
		"find /mnt/c/Users/thund -name '*qwen3*0.8*.gguf' -o -name '*Qwen3*0.8*.gguf' -o -name '*qwen35*.gguf' 2>/dev/null | head -10",
		true,
	],
	["forbid find /home subpath", "find /home/thund/cache -name x", true],
	["forbid find /var/log", "find /var/log -name x", true],
	["forbid find /etc", "find /etc -name foo", true],
	["forbid rg /mnt subpath", "rg foo /mnt/c/Users", true],
	["forbid rg /home subpath", "rg foo /home/x", true],
	["forbid grep -r /home", "grep -rn foo /home/x", true],
	["forbid rm -rf /home subpath", "rm -rf /home/x", true],
	["forbid rm -rf /var/cache subpath", "rm -rf /var/cache/foo", true],
	["forbid du /home subpath", "du -sh /home/x", true],
	["allow rm -rf /tmp/foo", "rm -rf /tmp/foo", false],
	["allow find /tmp/build", "find /tmp/build -name x", false],
	["allow git branch (no -f)", "git branch", false],
	["forbid git branch -f", "git branch -f main HEAD", true],
];
for (const [label, cmd, expected] of outsideCases) {
	if (await tryCmd(label, cmd, expected)) pass++;
	else fail++;
}

console.log(`\n=== inside-subagent context: simulate the gated rules turning ON ===`);
// IN_SUBAGENT is captured at module load — set env then cache-bust the import.
process.env.PI_GUARDIAN_RUN_ID = "test-run";
process.env.PI_GUARDIAN_AGENT_ID = "test-agent";
process.env.PI_GUARDIAN_AGENT_DIR = join(tmpdir(), "pi-guardian-toolcall-test");
delete globalThis.__pi_guardian_loaded__;
const handlers2 = {};
const mockPi2 = {
	on: (ev, cb) => {
		handlers2[ev] = cb;
	},
	registerCommand: () => {},
	registerTool: () => {},
	sendUserMessage: () => {},
	sendMessage: () => {},
};
const modIn = await import(`${GUARDIAN_PATH}?subagent=1`);
modIn.default(mockPi2);

async function tryCmdIn(label, command, expectBlocked) {
	const event = {
		toolName: "bash",
		toolCallId: "t2",
		input: { command },
	};
	const result = await handlers2.tool_call(event, {});
	const blocked = Boolean(result && result.block === true);
	const ok = blocked === expectBlocked;
	const reason = blocked && result.reason ? result.reason.slice(0, 60) : "";
	console.log(
		`  ${ok ? "✓" : "✗"} ${label}  expected=${expectBlocked} got=${blocked}${reason ? "  [" + reason + "]" : ""}`,
	);
	return ok;
}

const insideCases = [
	["forbid git push inside subagent", "git push origin main", true],
	["forbid --ignore-other-worktrees", "git reset --ignore-other-worktrees foo", true],
	["allow git status inside subagent", "git status", false],
	// global rules still apply
	["forbid rm -rf / inside subagent", "rm -rf /", true],
];
for (const [label, cmd, expected] of insideCases) {
	if (await tryCmdIn(label, cmd, expected)) pass++;
	else fail++;
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
