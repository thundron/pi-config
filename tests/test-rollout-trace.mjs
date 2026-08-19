#!/usr/bin/env node
// Unit tests for codex-cli-extras /rollout trace helper.
// Usage: node tests/test-rollout-trace.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_ROLLOUT_TRACE_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_ROLLOUT_TRACE_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "codex-cli-extras.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "pi-rollout-trace-test-"));
try {
	const memoryDir = join(tmp, "memories");
	const budgetFile = join(tmp, "budget.jsonl");
	process.env.PI_MEMORIES_DIR = memoryDir;
	process.env.PI_ROLLOUT_BUDGET_FILE = budgetFile;
	writeFileSync(budgetFile, "");

	const commands = new Map();
	const mockPi = {
		on: () => {},
		registerTool: () => {},
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: () => {},
		sendMessage: () => {},
	};
	const mod = await import(`${EXT_PATH}?fresh=${Date.now()}`);
	mod.default(mockPi);

	const notifications = [];
	const ctx = {
		cwd: "/repo",
		sessionManager: {
			getSessionFile: () => "/sessions/current.jsonl",
			getSessionId: () => "sid-123",
			getSessionName: () => "demo",
		},
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};

	console.log("=== helper ===");
	const text = mockPi.__codexCliExtrasInternals.buildRolloutTraceSnapshot(ctx);
	ok("includes privacy warning", text.includes("Privacy:"));
	ok("includes rollout path", text.includes("/sessions/current.jsonl"));
	ok("includes budget ledger", text.includes(budgetFile));
	ok("includes related diagnostics", text.includes("/debug-config") && text.includes("/subagents"));

	console.log("\n=== command ===");
	const rollout = commands.get("rollout");
	ok("registers /rollout", !!rollout);
	await rollout.handler("trace", ctx);
	ok("/rollout trace notifies snapshot", notifications.some((n) => n.type === "info" && n.message.includes("Rollout trace snapshot")), JSON.stringify(notifications));
	await rollout.handler("", ctx);
	ok("/rollout default still prints rollout", notifications.some((n) => n.message === "Rollout: /sessions/current.jsonl"), JSON.stringify(notifications));
	const comps = rollout.getArgumentCompletions("tr") ?? [];
	ok("completion includes trace", comps.some((c) => c.value === "trace"), JSON.stringify(comps));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
