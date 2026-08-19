#!/usr/bin/env node
// Unit tests for current-time.ts.
// Usage: node tests/test-current-time.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_CURRENT_TIME_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_CURRENT_TIME_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "current-time.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

async function loadWithInterval(interval) {
	if (interval === undefined) delete process.env.PI_CURRENT_TIME_REMINDER_INTERVAL;
	else process.env.PI_CURRENT_TIME_REMINDER_INTERVAL = String(interval);
	const mod = await import(`${EXT_PATH}?fresh=${Date.now()}-${Math.random()}`);
	const tools = [];
	const handlers = new Map();
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
	return { tools, handlers, internals: mockPi.__currentTimeInternals };
}

async function emitContext(handlers, messages = []) {
	let current = messages;
	for (const h of handlers.get("context") ?? []) {
		const r = await h({ messages: current }, {});
		if (r?.messages) current = r.messages;
	}
	return current;
}

console.log("=== helpers ===");
{
	const { internals } = await loadWithInterval(undefined);
	ok("formats UTC time", internals.formatUtcTime(new Date(Date.UTC(2026, 5, 20, 1, 2, 3))) === "2026-06-20 01:02:03 UTC");
	ok("renders Codex reminder text", internals.renderCurrentTimeReminder("2026-06-20 01:02:03 UTC") === "It is 2026-06-20 01:02:03 UTC.");
	ok("disabled by default", internals.parseReminderInterval(undefined) === 0);
	ok("parses positive interval", internals.parseReminderInterval("3") === 3);
	ok("invalid interval disables", internals.parseReminderInterval("nope") === 0);
	ok("first request is due", internals.reminderDue(0, 3) === true);
	ok("middle request not due", internals.reminderDue(2, 3) === false);
	ok("Nth request due", internals.reminderDue(3, 3) === true);
}

console.log("\n=== tool ===");
{
	const { tools } = await loadWithInterval(undefined);
	const tool = tools.find((t) => t.name === "current_time");
	ok("registers current_time", !!tool);
	const r = await tool.execute("id", {}, undefined, undefined, {});
	ok("details current_time matches schema", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(r.details.current_time), JSON.stringify(r.details));
	ok("content uses reminder text", r.content[0].text === `It is ${r.details.current_time}.`);
}

console.log("\n=== reminder disabled ===");
{
	const { handlers } = await loadWithInterval(0);
	const messages = await emitContext(handlers, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	ok("disabled reminder leaves context unchanged", messages.length === 1 && messages[0].content[0].text === "hello");
}

console.log("\n=== reminder cadence ===");
{
	const { handlers } = await loadWithInterval(2);
	let messages = await emitContext(handlers, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	ok("first request injects reminder", messages.length === 2 && messages[0].content[0].text.startsWith("It is "));
	messages = await emitContext(handlers, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	ok("second request waits", messages.length === 1, `len=${messages.length}`);
	messages = await emitContext(handlers, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	ok("third request injects after interval", messages.length === 2 && messages[0].content[0].text.startsWith("It is "));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
