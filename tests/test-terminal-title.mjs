#!/usr/bin/env node
// Unit tests for terminal-title.ts sanitization/rendering helpers.
// Usage: node tests/test-terminal-title.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_TERMINAL_TITLE_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_TERMINAL_TITLE_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "terminal-title.ts");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

const mod = await import(`${EXT_PATH}?fresh=1`);
if (typeof mod.default !== "function") {
	console.error("terminal-title.ts has no default export");
	process.exit(1);
}

const mockPi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: () => {},
	sendUserMessage: () => {},
	sendMessage: () => {},
	getThinkingLevel: () => "high",
};
mod.default(mockPi);
const {
	renderTitle,
	sanitizeTerminalTitle,
	isDisallowedTerminalTitleChar,
	MAX_TERMINAL_TITLE_CHARS,
} = mockPi.__terminalTitleInternals;

console.log("=== renderTitle ===");
{
	const rendered = renderTitle("{model}/{thinking} · {cwd} · {unknown}", {
		model: "claude",
		thinking: "high",
		cwd: "repo",
	});
	ok("known placeholders replaced, unknown preserved", rendered === "claude/high · repo · {unknown}", rendered);
}

console.log("\n=== sanitizeTerminalTitle ===");
{
	ok("collapses whitespace and strips edges", sanitizeTerminalTitle("  pi\n\t repo   title  ") === "pi repo title");
	ok("strips control characters", sanitizeTerminalTitle("a\u0007b\u001bc") === "abc");
	ok("strips Trojan Source bidi controls", sanitizeTerminalTitle("safe\u202Eevil") === "safeevil");
	ok("strips zero-width formatting", sanitizeTerminalTitle("a\u200Bb\uFEFFc") === "abc");
	ok("all invisible content becomes empty", sanitizeTerminalTitle(" \u200B\u202E\n\t") === "");
}

console.log("\n=== length bound ===");
{
	const long = "x".repeat(MAX_TERMINAL_TITLE_CHARS + 50);
	const sanitized = sanitizeTerminalTitle(long);
	ok("truncates to max title chars", [...sanitized].length === MAX_TERMINAL_TITLE_CHARS, `got ${[...sanitized].length}`);
	const emoji = "😀".repeat(MAX_TERMINAL_TITLE_CHARS + 5);
	const e = sanitizeTerminalTitle(emoji);
	ok("counts Unicode code points, not UTF-16 units", [...e].length === MAX_TERMINAL_TITLE_CHARS, `got ${[...e].length}`);
}

console.log("\n=== disallowed char helper ===");
{
	ok("BEL disallowed", isDisallowedTerminalTitleChar("\u0007") === true);
	ok("RLO disallowed", isDisallowedTerminalTitleChar("\u202E") === true);
	ok("visible letter allowed", isDisallowedTerminalTitleChar("A") === false);
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
