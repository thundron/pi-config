#!/usr/bin/env node
// Regression coverage for introspection command ownership and tool inventory.
// Usage: node tests/test-introspection.mjs (or bun run tests/test-introspection.mjs)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (typeof globalThis.Bun === "undefined" && !process.env.PI_INTROSPECTION_TEST_BOOTSTRAPPED) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, PI_INTROSPECTION_TEST_BOOTSTRAPPED: "1" },
	});
	process.exit(result.status ?? 1);
}

const { default: introspection } = await import("../agent/extensions/introspection.ts");
const commands = new Map();
const inventory = [
	{ name: "read", description: "Read files" },
	{ name: "memory_search", description: "Search memories", sourceInfo: { path: "/extensions/memories.ts" } },
];
introspection({
	on() {},
	registerCommand(name, command) { commands.set(name, command); },
	getAllTools() { return inventory; },
	getActiveTools() { return ["read"]; },
});

assert.deepEqual([...commands.keys()].sort(), ["debug-config", "hooks", "tools"]);
assert.equal(commands.has("mcp"), false, "leave /mcp available for pi's built-in extension");

const notifications = [];
const ctx = { ui: { notify(text, type) { notifications.push({ text, type }); } } };
await commands.get("tools").handler("", ctx);
assert.equal(notifications[0].type, "info");
assert.match(notifications[0].text, /Tools registered \(2 total, 1 active\)/);
assert.match(notifications[0].text, /\[built-in\]/);
assert.match(notifications[0].text, /\[memories\.ts\]/);
assert.match(notifications[0].text, /● read/);
assert.match(notifications[0].text, /○ memory_search/);

await commands.get("tools").handler(" MEMORY ", ctx);
assert.match(notifications[1].text, /Tools matching "memory" \(1\/2\)/);
assert.match(notifications[1].text, /memory_search/);
assert.doesNotMatch(notifications[1].text, /● read/);
console.log("introspection: command ownership and tool inventory passed");
