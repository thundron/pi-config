#!/usr/bin/env node
// Unit tests for subagents MultiAgentV2 mode controls/context injection.
// Usage: node tests/test-subagents-mode.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_SUBAGENTS_MODE_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_SUBAGENTS_MODE_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "subagents.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("subagents.ts has no default export");
	process.exit(1);
}

const commands = new Map();
const handlers = new Map();
const messages = [];
const tools = [];
const mockPi = {
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerCommand: (name, command) => commands.set(name, command),
	registerTool: (tool) => tools.push(tool),
	sendMessage: (message) => messages.push(message),
	sendUserMessage: () => {},
};
mod.default(mockPi);

function ctxFor(branch = []) {
	const notifications = [];
	return {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => branch,
			getSessionName: () => "test-session",
			getSessionId: () => "session-id",
		},
		ui: { setStatus: () => {}, notify: (message, type) => notifications.push({ message, type }) },
		notifications,
	};
}

async function emit(event, payload, ctx) {
	for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

async function contextText(ctx, messagesIn = []) {
	let messagesOut = messagesIn;
	for (const h of handlers.get("context") ?? []) {
		const result = await h({ messages: messagesOut }, ctx);
		if (result?.messages) messagesOut = result.messages;
	}
	return messagesOut[0]?.content?.[0]?.text ?? "";
}

console.log("=== registration ===");
ok("registers /subagents", commands.has("subagents"));
ok("registers context hook", (handlers.get("context") ?? []).length > 0);
ok("registers subagent_spawn", tools.some((t) => t.name === "subagent_spawn"));

console.log("\n=== default explicit mode ===");
{
	const ctx = ctxFor([]);
	await emit("session_start", {}, ctx);
	const text = await contextText(ctx);
	ok("injects multi_agent_mode marker", text.startsWith("<multi_agent_mode>"));
	ok("default tells model not to spawn unless explicit", text.includes("Do not spawn sub-agents unless the user explicitly asks"));
}

console.log("\n=== /subagents mode proactive ===");
{
	const ctx = ctxFor([]);
	await commands.get("subagents").handler("mode proactive", ctx);
	ok("persists proactive mode entry", messages.some((m) => m.customType === "subagents/mode" && m.details?.mode === "proactive"), JSON.stringify(messages));
	const text = await contextText(ctx);
	ok("injects proactive guidance", text.includes("Proactive multi-agent delegation is active"));
	ok("notifies user", ctx.notifications.some((n) => n.message.includes("proactive") && n.type === "info"), JSON.stringify(ctx.notifications));
}

console.log("\n=== persisted mode reconstructed on session_start ===");
{
	const branch = [{ type: "custom_message", customType: "subagents/mode", details: { mode: "proactive", t: 1 } }];
	const ctx = ctxFor(branch);
	await emit("session_start", {}, ctx);
	const text = await contextText(ctx);
	ok("session_start restores proactive mode", text.includes("Proactive multi-agent delegation is active"));
}

console.log("\n=== invalid mode help ===");
{
	const ctx = ctxFor([]);
	await commands.get("subagents").handler("mode banana", ctx);
	ok("invalid mode warns", ctx.notifications.some((n) => n.type === "warning" && n.message.includes("Usage: /subagents mode")), JSON.stringify(ctx.notifications));
}

console.log("\n=== spawn alias normalization ===");
{
	const spawn = tools.find((t) => t.name === "subagent_spawn");
	const normalized = spawn.prepareArguments({
		message: "investigate the parser",
		task_name: "parser-agent",
		agent_type: "explorer",
		reasoning_effort: "high",
		provider: "anthropic",
	});
	ok("message maps to instruction", normalized.instruction === "investigate the parser", JSON.stringify(normalized));
	ok("task_name maps to id", normalized.id === "parser-agent", JSON.stringify(normalized));
	ok("agent_type maps to role", normalized.role === "explorer", JSON.stringify(normalized));
	ok("reasoning_effort maps to thinking", normalized.thinking === "high", JSON.stringify(normalized));
	ok("aliases removed before validation", !("message" in normalized) && !("task_name" in normalized) && !("agent_type" in normalized) && !("reasoning_effort" in normalized), JSON.stringify(normalized));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
