#!/usr/bin/env node
// Verifies the embedded PLAN_MODE_PROMPT tracks Codex HEAD's plan.md template.
// Usage: bun run tests/test-plan-mode-prompt.mjs

import { readFileSync } from "node:fs";
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
const codex = readFileSync(resolve(REPO, "../codex/codex-rs/collaboration-mode-templates/templates/plan.md"), "utf8").replace(/\n$/, "");

console.log("=== plan prompt parity ===");
ok("embedded prompt matches Codex plan.md", embedded === codex, `embedded=${embedded.length} codex=${codex.length}`);
ok("includes Plan Mode vs update_plan section", embedded.includes("## Plan Mode vs update_plan tool"));
ok("includes Asking questions section", embedded.includes("## Asking questions"));

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
