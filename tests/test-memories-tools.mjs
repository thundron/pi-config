#!/usr/bin/env node
// Unit tests for memories.ts model tools.
// Usage: node tests/test-memories-tools.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_MEMORIES_TOOLS_TEST_BOOTSTRAPPED) {
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
			{ stdio: "inherit", env: { ...process.env, PI_MEMORIES_TOOLS_TEST_BOOTSTRAPPED: "1" } },
		);
		process.exit(r.status ?? 1);
	}
}

const tmp = mkdtempSync(join(tmpdir(), "pi-memories-test-"));
process.env.PI_MEMORIES_DIR = tmp;

const EXT_PATH = resolve(__dirname, "..", "agent", "extensions", "memories.ts");
const memoryFile = join(tmp, "MEMORY.md");
writeFileSync(memoryFile, `# Pi memory

Persistent cross-session memory registry.

## preferences

- [2026-01-01T00:00:00Z] Prefer small commits.
- [2026-01-02T00:00:00Z] Never push without consent.

## project

- [2026-01-03T00:00:00Z] pi-config tracks Codex ports.
`);

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

try {
	const mod = await import(`${EXT_PATH}?fresh=${Date.now()}`);
	if (typeof mod.default !== "function") {
		console.error("memories.ts has no default export");
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
	const tool = (name) => tools.find((t) => t.name === name);

	console.log("=== registration ===");
	for (const name of ["memory_list", "memory_read", "memory_search", "memory_recall", "memory_save"]) {
		ok(`registers ${name}`, !!tool(name));
	}

	console.log("\n=== memory_list ===");
	{
		const r = await tool("memory_list").execute("id", {}, undefined, undefined, {});
		ok("lists preferences", r.details.sections.some((s) => s.category === "preferences" && s.entries === 2), JSON.stringify(r.details));
		ok("lists project", r.content[0].text.includes("project"), r.content[0].text);
	}

	console.log("\n=== memory_read ===");
	{
		const r = await tool("memory_read").execute("id", { line_offset: 5, max_lines: 3 }, undefined, undefined, {});
		ok("returns line-numbered range", r.content[0].text.includes("5: ## preferences") && r.details.lines.length === 3, r.content[0].text);
		ok("reports truncation", r.details.truncated === true, JSON.stringify(r.details));
	}

	console.log("\n=== memory_search ===");
	{
		const r = await tool("memory_search").execute("id", { queries: ["consent", "codex"], context_lines: 1, max_results: 10 }, undefined, undefined, {});
		ok("finds both query families", r.details.matches.length === 2, JSON.stringify(r.details));
		ok("includes context line numbers", r.content[0].text.includes("Never push without consent") && r.content[0].text.includes("pi-config tracks Codex ports"), r.content[0].text);
	}

	console.log("\n=== compatibility tools still work ===");
	{
		const recall = await tool("memory_recall").execute("id", { query: "small commits" }, undefined, undefined, {});
		ok("memory_recall still returns matching section", recall.details.found === true && recall.content[0].text.includes("preferences"));
		const ctx = { sessionManager: { getSessionId: () => "session-abcdef" } };
		const save = await tool("memory_save").execute("id", { category: "facts", text: "A durable fact." }, undefined, undefined, ctx);
		ok("memory_save still appends", save.details.ok === true, JSON.stringify(save.details));
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
