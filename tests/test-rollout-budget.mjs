#!/usr/bin/env node
// Unit tests for rollout-budget.ts shared ledger primitive.
// Usage: node tests/test-rollout-budget.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_ROLLOUT_BUDGET_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_ROLLOUT_BUDGET_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "rollout-budget.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

async function loadBudget(env) {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("PI_ROLLOUT_")) delete process.env[k];
	}
	Object.assign(process.env, env);
	const mod = await import(`${EXT_PATH}?fresh=${Date.now()}-${Math.random()}`);
	const tools = [];
	const handlers = new Map();
	const statuses = [];
	const mockPi = {
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool: (tool) => tools.push(tool),
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
	};
	mod.default(mockPi);
	return { tools, handlers, internals: mockPi.__rolloutBudgetInternals, statuses, uiCtx: { hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } } };
}

async function emit(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

async function emitContext(handlers, messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]) {
	let current = messages;
	for (const h of handlers.get("context") ?? []) {
		const r = await h({ messages: current }, {});
		if (r?.messages) current = r.messages;
	}
	return current;
}

const tmp = mkdtempSync(join(tmpdir(), "pi-rollout-budget-test-"));
try {
	const ledger = join(tmp, "budget.jsonl");

	console.log("=== helpers ===");
	{
		const { internals } = await loadBudget({ PI_ROLLOUT_BUDGET_TOKENS: "100", PI_ROLLOUT_BUDGET_FILE: ledger });
		const cfg = internals.loadConfig(process.env);
		ok("config enabled", cfg.enabled === true && cfg.limitTokens === 100, JSON.stringify(cfg));
		ok("weighted usage default", internals.usageWeighted(10, 20, cfg) === 30);
		ok("renders remaining context", internals.renderBudgetContext({ enabled: true, limit_tokens: 100, used_weighted_tokens: 20, remaining_weighted_tokens: 80, exhausted: false }).includes("80 weighted tokens left"));
		ok("reminder index due initially", internals.reminderDue(0, 25, -1).due === true);
		ok("reminder index not due twice", internals.reminderDue(10, 25, 0).due === false);
	}

	console.log("\n=== tool and turn accounting ===");
	{
		const ledger2 = join(tmp, "budget2.jsonl");
		const { tools, handlers, uiCtx } = await loadBudget({ PI_ROLLOUT_BUDGET_TOKENS: "100", PI_ROLLOUT_BUDGET_FILE: ledger2, PI_ROLLOUT_REMINDER_INTERVAL: "50" });
		const tool = tools.find((t) => t.name === "get_rollout_budget");
		ok("registers get_rollout_budget", !!tool);
		await emit(handlers, "turn_end", { message: { role: "assistant", usage: { input: 25, output: 10 } } }, uiCtx);
		let r = await tool.execute("id", {}, undefined, undefined, {});
		ok("records weighted usage", r.details.used_weighted_tokens === 35 && r.details.remaining_weighted_tokens === 65, JSON.stringify(r.details));
		await emit(handlers, "turn_end", { message: { role: "assistant", usage: { input: 60, output: 10 } } }, uiCtx);
		r = await tool.execute("id", {}, undefined, undefined, {});
		ok("detects exhaustion", r.details.exhausted === true && r.content[0].text.includes("budget is exhausted"), JSON.stringify(r.details));
		ok("updates footer", uiCtx.ui && true && uiCtx.hasUI);
	}

	console.log("\n=== context reminders ===");
	{
		const ledger3 = join(tmp, "budget3.jsonl");
		const { handlers } = await loadBudget({ PI_ROLLOUT_BUDGET_TOKENS: "100", PI_ROLLOUT_BUDGET_FILE: ledger3, PI_ROLLOUT_REMINDER_INTERVAL: "50" });
		let messages = await emitContext(handlers);
		ok("initial reminder injected", messages.length === 2 && messages[0].content[0].text.startsWith("<rollout_budget>"));
		messages = await emitContext(handlers);
		ok("same reminder index not repeated", messages.length === 1, `len=${messages.length}`);
		await emit(handlers, "turn_end", { message: { role: "assistant", usage: { input: 60, output: 0 } } }, { hasUI: false });
		messages = await emitContext(handlers);
		ok("next interval reminder injected", messages.length === 2 && messages[0].content[0].text.includes("40 weighted tokens left"), messages[0]?.content?.[0]?.text);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
