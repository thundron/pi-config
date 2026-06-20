#!/usr/bin/env node
// Unit tests for plan-mode.ts collaboration-mode controls.
// Usage: bun run tests/test-collaboration-mode.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_COLLABORATION_MODE_TEST_BOOTSTRAPPED) {
	const isBun = typeof globalThis.Bun !== "undefined" || /bun/i.test(process.execPath);
	if (!isBun) {
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
			{ stdio: "inherit", env: { ...process.env, PI_COLLABORATION_MODE_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "plan-mode.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const commands = new Map();
const handlers = new Map();
const sentMessages = [];
let activeTools = ["read", "bash", "edit", "write"];
const mockPi = {
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerCommand: (name, command) => commands.set(name, command),
	registerTool: () => {},
	sendMessage: (message) => sentMessages.push(message),
	sendUserMessage: () => {},
	getActiveTools: () => [...activeTools],
	setActiveTools: (tools) => { activeTools = [...tools]; },
};

const mod = await import(`${EXT_PATH}?fresh=1`);
mod.default(mockPi);

function ctxFor(branch = []) {
	const notifications = [];
	return {
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: {
			setStatus: () => {},
			notify: (message, type) => notifications.push({ message, type }),
		},
		notifications,
	};
}

async function contextText(ctx, messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]) {
	let current = messages;
	for (const h of handlers.get("context") ?? []) {
		const r = await h({ messages: current }, ctx);
		if (r?.messages) current = r.messages;
	}
	return current[0]?.content?.[0]?.text ?? "";
}

async function emit(event, payload, ctx) {
	for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

console.log("=== registration ===");
ok("registers /plan", commands.has("plan"));
ok("registers /execute", commands.has("execute"));
ok("registers /mode", commands.has("mode"));
ok("registers context hook", (handlers.get("context") ?? []).length > 0);

console.log("\n=== no mode by default ===");
{
	const text = await contextText(ctxFor([]));
	ok("default context passes through", text === "hello", JSON.stringify(text));
}

console.log("\n=== /mode execute ===");
{
	const ctx = ctxFor([]);
	await commands.get("mode").handler("execute", ctx);
	const text = await contextText(ctx);
	ok("execute mode persisted", sentMessages.some((m) => m.customType === "collaboration/mode" && m.details?.mode === "execute"), JSON.stringify(sentMessages));
	ok("execute context uses marker", text.startsWith("<collaboration_mode>") && text.includes("# Collaboration Style: Execute"), text.slice(0, 120));
	ok("execute notify", ctx.notifications.some((n) => n.message.includes("execute") && n.type === "info"), JSON.stringify(ctx.notifications));
}

console.log("\n=== /mode pair ===");
{
	const ctx = ctxFor([]);
	await commands.get("mode").handler("pair", ctx);
	const text = await contextText(ctx);
	ok("pair context injected", text.includes("# Collaboration Style: Pair Programming"), text.slice(0, 160));
}

console.log("\n=== /mode plan and /execute ===");
{
	const ctx = ctxFor([]);
	activeTools = ["read", "bash", "edit", "write"];
	await commands.get("mode").handler("plan", ctx);
	ok("plan restricts tools", activeTools.join(",") === "read,bash,grep,find,ls", activeTools.join(","));
	let text = await contextText(ctx);
	ok("plan context wrapped in collaboration marker", text.startsWith("<collaboration_mode>") && text.includes("# Plan Mode (Conversational)"), text.slice(0, 120));
	await commands.get("execute").handler("", ctx);
	ok("execute restores previous tools", activeTools.join(",") === "read,bash,edit,write", activeTools.join(","));
	text = await contextText(ctx);
	ok("/execute switches to execute mode", text.includes("# Collaboration Style: Execute"), text.slice(0, 120));
}

console.log("\n=== session reconstruction ===");
{
	const branch = [{ type: "custom_message", customType: "collaboration/mode", details: { mode: "pair", t: 1 } }];
	const ctx = ctxFor(branch);
	await emit("session_start", {}, ctx);
	const text = await contextText(ctx);
	ok("session_start restores mode", text.includes("# Collaboration Style: Pair Programming"));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
