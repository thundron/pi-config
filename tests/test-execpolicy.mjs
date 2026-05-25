#!/usr/bin/env node
/**
 * Self-contained unit test for guardian.ts's execpolicy evaluator.
 *
 * Mirrors the JS-equivalent of guardian.ts's tokenize / matchPrefix /
 * evaluateExecPolicy / DEFAULT_EXECPOLICY. If guardian.ts changes its
 * tokenizer or rule list, this test file needs to be updated alongside.
 */

// ─── Mirror of guardian.ts's helpers ───────────────────────────────────────

function tokenizeSegment(seg) {
	const out = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < seg.length) {
		const ch = seg[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else cur += ch;
		} else if (inDouble) {
			if (ch === '"') inDouble = false;
			else if (ch === "\\" && i + 1 < seg.length) {
				cur += seg[i + 1];
				i += 1;
			} else cur += ch;
		} else if (ch === "'") inSingle = true;
		else if (ch === '"') inDouble = true;
		else if (/\s/.test(ch)) {
			if (cur.length > 0) {
				out.push(cur);
				cur = "";
			}
		} else cur += ch;
		i += 1;
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

function tokenize(command) {
	const segments = command.split(/\s*(?:;|\&\&|\|\||\|)\s*/);
	return segments.map((seg) => tokenizeSegment(seg)).filter((s) => s.length > 0);
}

function matchPrefix(tokens, pattern) {
	if (tokens.length < pattern.length) return false;
	for (let i = 0; i < pattern.length; i++) {
		const pt = pattern[i];
		const tok = tokens[i];
		if (Array.isArray(pt)) {
			if (!pt.includes(tok)) return false;
		} else if (pt !== tok) {
			return false;
		}
	}
	return true;
}

function evaluateExecPolicy(rules, command) {
	const segments = tokenize(command);
	for (const seg of segments) {
		for (const rule of rules) {
			if (!matchPrefix(seg, rule.pattern)) continue;
			// Prefix is REQUIRED. If the rule also has a regex, the regex is
			// authoritative: BOTH must match. This lets rules like ['grep'] use
			// the prefix as a cheap pre-filter and the regex to narrow to the
			// dangerous form (grep -r ... /).
			if (rule.regex) {
				try {
					if (!new RegExp(rule.regex).test(command)) continue;
				} catch {
					continue; // malformed regex — skip
				}
			}
			if (rule.decision === "forbidden") return rule;
		}
	}
	return undefined;
}

// Mirror of DEFAULT_EXECPOLICY from guardian.ts
const DEFAULT_EXECPOLICY = [
	{
		pattern: ["git", "push"],
		decision: "forbidden",
		justification: "git push is banned in dispatched dev agent context",
	},
	{
		pattern: ["git", ["reset", "checkout"], "--ignore-other-worktrees"],
		decision: "forbidden",
		justification: "--ignore-other-worktrees is banned (breaks worktree isolation)",
	},
	{
		pattern: ["git", ["branch", "update-ref"]],
		decision: "forbidden",
		justification: "force-branch / update-ref are banned",
		regex: "\\bgit\\s+(?:branch|update-ref)\\s+-(?:f|B)\\b",
	},
	{
		pattern: ["rm", "-rf", "/"],
		decision: "forbidden",
		justification: "rm -rf / is catastrophic",
		regex: "\\brm\\s+-rf\\s+/(?:\\s|$)",
	},
	{
		pattern: ["find", "/"],
		decision: "forbidden",
		justification:
			"find / scans the entire filesystem (~30+ min on WSL with /mnt/* FUSE mounts). Re-issue with an explicit scope: 'find . -name X' or 'find <specific-dir> -name X'.",
		regex: "\\bfind\\s+/(?!\\S)",
	},
	{
		pattern: ["find", "/mnt"],
		decision: "forbidden",
		justification:
			"find /mnt walks WSL DrvFs FUSE mounts (extremely slow, often >5 min). Scope to a specific subdirectory.",
	},
	{
		pattern: ["grep"],
		decision: "forbidden",
		justification:
			"grep -r / scans the entire filesystem. Scope to a specific directory: 'grep -r pattern ./src'.",
		regex:
			"\\bgrep\\s+(?:[^|;&\\n]*\\s+)?-\\S*[rR]\\S*\\s+(?:[^|;&\\n]*\\s+)?/(?!\\S)",
	},
	{
		pattern: ["rg"],
		decision: "forbidden",
		justification:
			"rg from / scans the entire filesystem. Scope it: 'rg pattern ./src' or just 'rg pattern' (rg defaults to cwd).",
		regex: "\\brg\\s+(?:[^|;&\\n]*\\s+)?/(?!\\S)",
	},
	{
		pattern: ["rg", "/mnt"],
		decision: "forbidden",
		justification: "rg on /mnt walks WSL FUSE mounts. Scope it.",
	},
	{
		pattern: [["du", "tree"]],
		decision: "forbidden",
		justification:
			"du / and tree / scan the entire filesystem. Scope to a specific directory.",
		regex: "\\b(?:du|tree)\\s+(?:-\\S+\\s+)*/(?!\\S)",
	},
];

// ─── Test cases ────────────────────────────────────────────────────────────

const outsideCases = [
	["find / -name foo", true, "find / -name foo should be blocked"],
	["find / -maxdepth 1", true, "find / -maxdepth 1 should be blocked"],
	["find . -name foo", false, "find . -name foo should be allowed"],
	["find /tmp -name x", false, "find /tmp -name x should be allowed"],
	["find /mnt -name x", true, "find /mnt should be blocked"],
	["rm -rf /", true, "rm -rf / should be blocked"],
	["rm -rf ./build", false, "rm -rf ./build should be allowed"],
	["grep -r foo /", true, "grep -r foo / should be blocked"],
	["grep -r foo ./src", false, "grep -r foo ./src should be allowed"],
	["rg foo /", true, "rg foo / should be blocked"],
	["rg foo", false, "rg foo (defaults to cwd) should be allowed"],
	["du / -sh", true, "du / -sh should be blocked"],
	["du -sh ./build", false, "du -sh ./build should be allowed"],
	["tree /", true, "tree / should be blocked"],
	// Chained commands: forbidden segment anywhere blocks
	["echo hi && rm -rf /", true, "chained rm -rf / via && should be blocked"],
	["cd foo; find /", true, "chained find / via ; should be blocked"],
	// Outside sub-agent, git push is gated out (apply filter below)
	["git push origin main", false, "git push outside sub-agent should be allowed"],
];

const insideCases = [
	["git push origin main", true, "git push inside sub-agent should be blocked"],
	[
		"git reset --ignore-other-worktrees foo",
		true,
		"--ignore-other-worktrees should be blocked",
	],
	["git status", false, "git status should always be allowed"],
];

function isOutsideSubagentApplicable(r) {
	const j = r.justification ?? "";
	return (
		!j.includes("dispatched dev agent") &&
		!j.includes("sub-agent") &&
		!j.includes("worktree isolation")
	);
}

let pass = 0,
	fail = 0;

console.log("=== outside a sub-agent (gated filter) ===");
const outsideRules = DEFAULT_EXECPOLICY.filter(isOutsideSubagentApplicable);
for (const [cmd, expectedBlocked, msg] of outsideCases) {
	const hit = evaluateExecPolicy(outsideRules, cmd);
	const actuallyBlocked = hit !== undefined;
	if (actuallyBlocked === expectedBlocked) {
		pass++;
		console.log(`  ✓ ${msg}`);
	} else {
		fail++;
		console.log(
			`  ✗ ${msg}  cmd='${cmd}'  expected=${expectedBlocked}  got=${actuallyBlocked}  hit=${hit?.justification?.slice(0, 60) ?? "(none)"}`,
		);
	}
}

console.log("\n=== inside a sub-agent (full ruleset) ===");
for (const [cmd, expectedBlocked, msg] of insideCases) {
	const hit = evaluateExecPolicy(DEFAULT_EXECPOLICY, cmd);
	const actuallyBlocked = hit !== undefined;
	if (actuallyBlocked === expectedBlocked) {
		pass++;
		console.log(`  ✓ ${msg}`);
	} else {
		fail++;
		console.log(
			`  ✗ ${msg}  cmd='${cmd}'  expected=${expectedBlocked}  got=${actuallyBlocked}  hit=${hit?.justification?.slice(0, 60) ?? "(none)"}`,
		);
	}
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
