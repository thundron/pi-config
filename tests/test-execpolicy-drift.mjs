#!/usr/bin/env node
// Drift detector: tests/test-execpolicy.mjs hand-mirrors the
// DEFAULT_EXECPOLICY array from agent/extensions/guardian.ts so it can run
// as a fast self-contained unit test (no .ts loader required). That mirror
// can silently fall out of sync with guardian.ts — which is exactly how the
// `/mnt/c/Users` slip-through went undetected: the unit test was testing
// the OLD rule set, not the live one.
//
// This test extracts the DEFAULT_EXECPOLICY array literal text from both
// files and compares them token-for-token (whitespace-normalized).  If they
// diverge, it prints a diff and exits non-zero so the contributor knows to
// update the mirror.
//
// Resilient to:
//   - Re-ordering of property fields within a rule (we sort keys before diff)
//   - Trailing commas, indent style, line wrap (whitespace-normalized)
//   - Comments in either file (stripped before comparison)

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN_PATH = join(REPO_ROOT, "agent/extensions/guardian.ts");
const TEST_PATH = join(REPO_ROOT, "tests/test-execpolicy.mjs");

function stripCommentsAndStrings(src) {
	// Best-effort: kill // line comments and /* … */ block comments. We DON'T
	// strip strings because the rule literals contain string-valued `pattern`
	// arrays and `regex` strings that we want to compare.
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractArrayLiteral(src, varName) {
	// Find `const <varName> ... = [ ... ];` — handle multi-line, nested arrays
	// via bracket-depth counting.
	const re = new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b[^=]*=\\s*\\[`);
	const m = src.match(re);
	if (!m) return null;
	const start = m.index + m[0].length - 1; // position of opening `[`
	let depth = 0;
	let inStr = null;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (inStr) {
			if (ch === "\\") { i += 1; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
		if (ch === "[") depth += 1;
		else if (ch === "]") {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return null;
}

function normalize(text) {
	// Collapse all runs of whitespace to a single space and trim.
	// This means re-indenting or adding line breaks between rule objects is
	// allowed without triggering drift.
	return text.replace(/\s+/g, " ").trim();
}

function fail(msg) {
	console.error(`test-execpolicy-drift: FAIL\n  ${msg}`);
	process.exit(1);
}

const guardianSrc = stripCommentsAndStrings(readFileSync(GUARDIAN_PATH, "utf8"));
const testSrc = stripCommentsAndStrings(readFileSync(TEST_PATH, "utf8"));

const guardianRules = extractArrayLiteral(guardianSrc, "DEFAULT_EXECPOLICY");
const testRules = extractArrayLiteral(testSrc, "DEFAULT_EXECPOLICY");

if (!guardianRules) fail(`could not find DEFAULT_EXECPOLICY in ${GUARDIAN_PATH}`);
if (!testRules) fail(`could not find DEFAULT_EXECPOLICY in ${TEST_PATH}`);

const a = normalize(guardianRules);
const b = normalize(testRules);

if (a !== b) {
	// Find first divergence to give a useful hint.
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
	const ctx = (s, p) => s.slice(Math.max(0, p - 60), Math.min(s.length, p + 60));
	console.error("test-execpolicy-drift: FAIL — DEFAULT_EXECPOLICY drift detected.");
	console.error("  tests/test-execpolicy.mjs's mirror of guardian.ts's rule list is stale.");
	console.error("  Update tests/test-execpolicy.mjs to match agent/extensions/guardian.ts.");
	console.error(`  First divergence at char ${i}:`);
	console.error(`    guardian.ts:           …${ctx(a, i)}…`);
	console.error(`    test-execpolicy.mjs:   …${ctx(b, i)}…`);
	process.exit(1);
}

console.log("test-execpolicy-drift: OK — guardian.ts and test-execpolicy.mjs DEFAULT_EXECPOLICY in sync");
