#!/usr/bin/env node
// Validate bundled pi agent-role JSON files.
// Usage: node tests/test-agent-roles.mjs

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = resolve(__dirname, "..", "agent", "roles");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

console.log("=== agent roles ===");
const files = readdirSync(ROLES_DIR).filter((f) => f.endsWith(".json")).sort();
ok("expected role set present", ["awaiter.json", "explorer.json", "worker.json"].every((f) => files.includes(f)), files.join(","));
for (const file of files) {
	const data = JSON.parse(readFileSync(resolve(ROLES_DIR, file), "utf8"));
	ok(`${file} has developer_instructions`, typeof data.developer_instructions === "string" && data.developer_instructions.length > 80);
	ok(`${file} has source/provenance`, typeof data._source === "string" && data._source.includes("codex"));
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
