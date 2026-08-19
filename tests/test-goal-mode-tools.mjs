#!/usr/bin/env node
// Unit tests for goal-mode model tools.
// Usage: node tests/test-goal-mode-tools.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_GOAL_MODE_TOOLS_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_GOAL_MODE_TOOLS_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "goal-mode.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("goal-mode.ts has no default export");
	process.exit(1);
}

const tools = [];
const appended = [];
const handlers = new Map();
const sentUserMessages = [];
const mockPi = {
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerCommand: () => {},
	registerTool: (tool) => tools.push(tool),
	sendUserMessage: (message) => sentUserMessages.push(message),
	sendMessage: () => {},
	appendEntry: (customType, data) => appended.push({ customType, data }),
};
mod.default(mockPi);

const getGoal = tools.find((t) => t.name === "get_goal");
const updateGoal = tools.find((t) => t.name === "update_goal");

function ctxFor(branch) {
	return {
		hasUI: false,
		sessionManager: { getBranch: () => branch },
		ui: { setStatus: () => {}, notify: () => {} },
	};
}

console.log("=== registration ===");
ok("registers get_goal", !!getGoal);
ok("registers update_goal", !!updateGoal);

console.log("\n=== get_goal no active goal ===");
{
	const r = await getGoal.execute("id", {}, new AbortController().signal, () => {}, ctxFor([]));
	ok("details goal is null", r.details?.goal === null, JSON.stringify(r.details));
	ok("content says no active goal", r.content?.[0]?.text?.includes("No active goal"));
}

console.log("\n=== get_goal active goal ===");
{
	const branch = [
		{ type: "custom", customType: "goal/set", data: { objective: "ship phase two", tokenBudget: 1000, t: 100 } },
		{ type: "message", message: { role: "assistant", usage: { input: 123, output: 77 } } },
		{ type: "custom", customType: "goal/status", data: { status: "paused", summary: "manual", t: 200 } },
	];
	const r = await getGoal.execute("id", {}, new AbortController().signal, () => {}, ctxFor(branch));
	const g = r.details?.goal;
	ok("returns objective", g?.objective === "ship phase two", JSON.stringify(g));
	ok("returns latest status", g?.status === "paused", JSON.stringify(g));
	ok("sums assistant usage", g?.tokensUsed === 200, JSON.stringify(g));
	ok("includes rendered dump", r.content?.[0]?.text?.includes("ship phase two"));
}

console.log("\n=== update_goal still appends status ===");
{
	const branch = [{ type: "custom", customType: "goal/set", data: { objective: "x", t: 1 } }];
	const r = await updateGoal.execute("id", { status: "complete", summary: "done" }, new AbortController().signal, () => {}, ctxFor(branch));
	ok("update succeeds", r.details?.ok === true, JSON.stringify(r.details));
	ok("status append recorded", appended.some((e) => e.customType === "goal/status" && e.data.status === "complete" && e.data.summary === "done"), JSON.stringify(appended));
}

console.log("\n=== plan mode suppresses auto-continuation ===");
{
	const notifications = [];
	const branch = [
		{ type: "custom", customType: "goal/set", data: { objective: "keep going", t: 1 } },
		{ type: "custom_message", customType: "plan/on", details: { previousTools: ["read"], t: 2 } },
	];
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: { setStatus: () => {}, notify: (message, type) => notifications.push({ message, type }) },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	const before = sentUserMessages.length;
	for (const h of handlers.get("agent_end") ?? []) {
		await h({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	}
	ok("no follow-up queued", sentUserMessages.length === before, `before=${before} after=${sentUserMessages.length}`);
	ok("notifies about plan-mode suppression", notifications.some((n) => n.message.includes("plan mode") && n.type === "info"), JSON.stringify(notifications));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
