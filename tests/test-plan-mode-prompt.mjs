#!/usr/bin/env node
// Verifies the embedded PLAN_MODE_PROMPT tracks Codex HEAD's plan.md template.
// Usage: node tests/test-plan-mode-prompt.mjs

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

function unescapeTemplateLiteral(raw) {
	return raw
		.replace(/\\\$/g, "$")
		.replace(/\\`/g, "`")
		.replace(/\\\\/g, "\\");
}

const ts = readFileSync(resolve(REPO, "agent/extensions/plan-mode.ts"), "utf8");
const startMarker = "const PLAN_MODE_PROMPT = `";
const start = ts.indexOf(startMarker);
if (start === -1) {
	console.error("PLAN_MODE_PROMPT not found");
	process.exit(1);
}
const bodyStart = start + startMarker.length;
const bodyEnd = ts.indexOf("`;", bodyStart);
if (bodyEnd === -1) {
	console.error("PLAN_MODE_PROMPT terminator not found");
	process.exit(1);
}
const embedded = unescapeTemplateLiteral(ts.slice(bodyStart, bodyEnd));

// Parity against upstream Codex needs a local codex checkout next to this repo
// (or PI_CODEX_SRC=...). Without it, the upstream half of the comparison simply
// isn't available — skip rather than fail, so a fresh machine's suite is green.
const codexRoot = process.env.PI_CODEX_SRC ?? resolve(REPO, "../codex");
const codexTemplate = resolve(codexRoot, "codex-rs/collaboration-mode-templates/templates/plan.md");
if (!existsSync(codexTemplate)) {
	console.log(`test-plan-mode-prompt: no codex checkout at ${codexRoot} — skipping parity check.`);
	console.log("  (set PI_CODEX_SRC=/path/to/codex to enable it)");
	process.exit(0);
}
const codex = readFileSync(codexTemplate, "utf8").replace(/\n$/, "");

console.log("=== plan prompt parity ===");
ok("embedded prompt matches Codex plan.md", embedded === codex, `embedded=${embedded.length} codex=${codex.length}`);
ok("includes Plan Mode vs update_plan section", embedded.includes("## Plan Mode vs update_plan tool"));
ok("includes Asking questions section", embedded.includes("## Asking questions"));

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
