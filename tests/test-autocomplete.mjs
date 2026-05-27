#!/usr/bin/env node
// Runtime contract test for extension slash-command autocomplete.
//
// The label bug (TUI crash on `item.label.endsWith("/")` because
// `getArgumentCompletions` returned items without `label`) escaped because:
//   1. extension .ts files are loaded by bun's loader without type-checking
//   2. our harness exercises `/cmd <args>` but not the autocomplete path
//      (RPC mode has no `get_argument_completions` endpoint)
//
// This test fills the gap: it loads each extension with a stub ExtensionAPI
// that captures every registerCommand, then for every command exposing
// `getArgumentCompletions` it exercises a battery of prefixes and asserts
// every returned item conforms to pi-tui's `AutocompleteItem`:
//
//   { value: string; label: string; description?: string }
//
// Skips with exit 0 if neither `bun` nor `tsx`/equivalent .ts loader is
// available (pi extensions are .ts, plain `node` can't import them).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(REPO_ROOT, "agent/extensions");

function which(cmd) {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

// Need a TS-capable loader. Prefer bun (pi itself uses it).
const bun = which("bun");
const nodeWithStripTypes = (() => {
	// Node 22+ has --experimental-strip-types; node 23+ has it on by default for .ts
	const r = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "''"], { encoding: "utf8" });
	return r.status === 0;
})();

if (!bun && !nodeWithStripTypes) {
	console.error("test-autocomplete: need bun or node with --experimental-strip-types — skipping.");
	process.exit(0);
}

// ─── Stub ExtensionAPI ─────────────────────────────────────────────────────
//
// The runner script (below) builds a stub `pi` ExtensionAPI that captures
// every registerCommand. Most other extension primitives (registerTool, on,
// setStatus, etc.) become no-op stubs. Then for every captured command with
// `getArgumentCompletions`, we exercise a battery of prefixes.

// Extensions import from @earendil-works/pi-coding-agent and friends, which
// live in pi-coding-agent's NESTED node_modules. Under stand-alone node those
// imports fail; tests/lib/stub-hook.mjs intercepts them and returns harmless
// Proxy stubs so the autocomplete callback (pure logic) can run.

const runnerJs = `
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = process.argv[2];
const PREFIXES = ["", "a", "p", "x", "show", "off", "on", "  ", "with space"];

const errors = [];
const okCount = { ext: 0, cmd: 0, items: 0 };

function makeStubApi() {
	const commands = [];
	const noop = () => {};
	const noopReturn = (v) => () => v;
	const stubUI = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: {},
		getAllThemes: () => ({}),
		getTheme: () => undefined,
		setTheme: () => ({}),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};
	const api = {
		registerCommand: (name, opts) => { commands.push({ name, ...opts }); },
		registerTool: noop,
		on: noop,
		off: noop,
		setKeybinding: noop,
		removeKeybinding: noop,
		getAllKeybindings: () => [],
		ui: stubUI,
		hasUI: false,
		// minor surface
		setActiveTools: noop,
		refreshTools: noop,
		getCommands: () => [],
		setModel: noop,
		getThinkingLevel: () => "off",
		setThinkingLevel: noop,
		setLabel: noop,
		log: { info: noop, warn: noop, error: noop, debug: noop },
		cwd: process.cwd(),
		__commands: commands,
	};
	return api;
}

function checkItem(item, where) {
	if (!item || typeof item !== "object") {
		errors.push(\`\${where}: item is not an object (\${typeof item})\`);
		return;
	}
	if (typeof item.value !== "string") {
		errors.push(\`\${where}: item.value missing or not a string (got \${typeof item.value})\`);
	}
	if (typeof item.label !== "string") {
		errors.push(\`\${where}: item.label missing or not a string (got \${typeof item.label}) — would crash pi-tui's applyCompletion\`);
	}
	if (item.description !== undefined && typeof item.description !== "string") {
		errors.push(\`\${where}: item.description present but not a string\`);
	}
	okCount.items += 1;
}

async function runExt(file) {
	const url = pathToFileURL(file).href;
	let mod;
	try { mod = await import(url); }
	catch (e) {
		errors.push(\`\${file}: failed to import — \${e?.message || e}\`);
		return;
	}
	const reg = mod.default || mod.register;
	if (typeof reg !== "function") {
		// not every .ts is an extension (e.g. helper modules) — skip silently
		return;
	}
	const api = makeStubApi();
	try { await reg(api); }
	catch (e) {
		errors.push(\`\${file}: register() threw — \${e?.message || e}\`);
		return;
	}
	okCount.ext += 1;
	for (const cmd of api.__commands) {
		if (typeof cmd.getArgumentCompletions !== "function") continue;
		okCount.cmd += 1;
		for (const p of PREFIXES) {
			let items;
			try { items = await cmd.getArgumentCompletions(p); }
			catch (e) {
				errors.push(\`\${file} /\${cmd.name} prefix=\${JSON.stringify(p)}: threw — \${e?.message || e}\`);
				continue;
			}
			if (items === null || items === undefined) continue;
			if (!Array.isArray(items)) {
				errors.push(\`\${file} /\${cmd.name} prefix=\${JSON.stringify(p)}: did not return array or null (\${typeof items})\`);
				continue;
			}
			for (let i = 0; i < items.length; i++) {
				checkItem(items[i], \`\${file} /\${cmd.name} prefix=\${JSON.stringify(p)} item[\${i}]\`);
			}
		}
	}
}

const files = readdirSync(EXT_DIR)
	.filter((f) => f.endsWith(".ts"))
	.map((f) => join(EXT_DIR, f));

for (const f of files) await runExt(f);

if (errors.length) {
	for (const e of errors) console.error("  " + e);
	console.error(\`test-autocomplete: \${errors.length} contract violation(s)\`);
	process.exit(1);
}
console.log(\`test-autocomplete: OK — \${okCount.ext} extensions, \${okCount.cmd} commands with getArgumentCompletions, \${okCount.items} items validated\`);
`;

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const work = mkdtempSync(join(tmpdir(), "pi-ac-"));
const runnerPath = join(work, "runner.mjs");
writeFileSync(runnerPath, runnerJs);

try {
	let cmd, args;
	if (bun) {
		// bun follows nested node_modules natively — no stub hook needed.
		cmd = bun;
		args = ["run", runnerPath, EXT_DIR];
	} else {
		cmd = process.execPath;
		const hookRegister = resolve(REPO_ROOT, "tests/lib/stub-hook-register.mjs");
		args = [
			"--experimental-strip-types",
			"--no-warnings=DeprecationWarning",
			"--import",
			hookRegister,
			runnerPath,
			EXT_DIR,
		];
	}
	const r = spawnSync(cmd, args, { stdio: "inherit" });
	process.exit(r.status ?? 1);
} finally {
	try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
