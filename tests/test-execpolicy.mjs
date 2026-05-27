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
	// IMPORTANT: matchPrefix uses EXACT token equality. Patterns like
	// ["find", "/mnt"] only match `find /mnt` (with `/mnt` as exact arg) and
	// miss `find /mnt/c/Users`. All filesystem-scan rules below therefore use
	// a `[<tool>]` prefix and rely on a regex to catch any absolute path that
	// isn't /tmp[/...]. Shared lookahead: `/(?!tmp\b|tmp/)`.
	{
		pattern: ["rm"],
		decision: "forbidden",
		justification:
			"rm -r/-rf on absolute system paths is too dangerous without explicit user confirmation. " +
			"If you really need to wipe an absolute path, cd there first and use a relative target, " +
			"or run it via /bash with the user's explicit ok. /tmp[/...] is allowed.",
		regex:
			"\\brm\\b(?:[^|;&\\n]*?\\s)-\\S*[rR]\\S*\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},
	{
		pattern: ["find"],
		decision: "forbidden",
		justification:
			"find on absolute system paths walks the entire filesystem (or WSL DrvFs FUSE mounts on /mnt, often >5 min). " +
			"Allowed: relative paths (`.`, `./src`, `ggml/src/...`) and /tmp[/...]. " +
			"If you need a specific dir, cd into it first or pass a relative path.",
		regex: "\\bfind\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},
	{
		pattern: ["rg"],
		decision: "forbidden",
		justification:
			"rg on absolute system paths walks the entire filesystem (or WSL DrvFs on /mnt). " +
			"Use a relative scope: 'rg pattern ./src' or just 'rg pattern' (rg defaults to cwd). /tmp[/...] is allowed.",
		regex: "\\brg\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},
	{
		pattern: ["grep"],
		decision: "forbidden",
		justification:
			"grep -r on absolute system paths scans the entire filesystem. " +
			"Scope it: 'grep -r pattern ./src'. /tmp[/...] is allowed.",
		regex:
			"\\bgrep\\b(?:[^|;&\\n]*?\\s)-\\S*[rR]\\S*\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},
	{
		pattern: [["du", "tree"]],
		decision: "forbidden",
		justification:
			"du/tree on absolute system paths scans the entire filesystem. /tmp[/...] is allowed.",
		regex: "\\b(?:du|tree)\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},
];

// ─── Test cases ────────────────────────────────────────────────────────────

const outsideCases = [
	// ─── find ───────────────────────────────────────────────────────────────────
	["find / -name foo", true, "find /"],
	["find / -maxdepth 1", true, "find / with flags"],
	["find . -name foo", false, "find . (relative)"],
	["find ./src -name x", false, "find ./src (relative)"],
	["find ggml/src/ggml-compositor -name '*.cpp'", false, "find relative subdir"],
	["find /tmp -name x", false, "find /tmp"],
	["find /tmp/foo -name x", false, "find /tmp/foo"],
	["find /mnt -name x", true, "find /mnt (bare)"],
	// ←— the actual commands that slipped through into the user's session
	["find /mnt/c/Users -name '*.gguf' 2>/dev/null | head -20", true, "find /mnt/c/Users (WSL drive subpath)"],
	["find /mnt/c/Users/thund -name '*qwen3*0.8*.gguf'", true, "find /mnt/c subpath with glob"],
	["find -L /mnt/c/Users -name x", true, "find with flag then /mnt subpath"],
	["find /home/thund/cache -name x", true, "find /home subpath"],
	["find /var/log -name x", true, "find /var subpath"],
	["find /etc -name x", true, "find /etc"],
	["find /Users/x -name foo", true, "find /Users (macOS)"],
	["find /usr/lib -name foo", true, "find /usr subpath"],
	// ─── rg ───────────────────────────────────────────────────────────────────────
	["rg foo /", true, "rg foo /"],
	["rg foo /mnt/c/Users", true, "rg /mnt subpath"],
	["rg foo /home/x", true, "rg /home subpath"],
	["rg foo /var/log/syslog", true, "rg /var subpath"],
	["rg foo", false, "rg foo (cwd default)"],
	["rg foo ./src", false, "rg foo ./src"],
	["rg foo /tmp", false, "rg /tmp"],
	["rg foo /tmp/build", false, "rg /tmp/build"],
	// ─── grep -r ────────────────────────────────────────────────────────────────
	["grep -r foo /", true, "grep -r foo /"],
	["grep -r foo /mnt/c", true, "grep -r /mnt subpath"],
	["grep -r foo /home/x", true, "grep -r /home subpath"],
	["grep -rn foo /var/log", true, "grep -rn /var subpath (-rn combined flag)"],
	["grep -r foo ./src", false, "grep -r foo ./src"],
	["grep -r foo /tmp/build", false, "grep -r /tmp/build"],
	["grep foo file.txt", false, "grep (non-r) untouched"],
	// ─── du / tree ──────────────────────────────────────────────────────────────
	["du / -sh", true, "du /"],
	["du -sh ./build", false, "du -sh ./build"],
	["du -sh /home/x", true, "du /home subpath"],
	["du -sh /tmp/foo", false, "du /tmp/foo"],
	["tree /", true, "tree /"],
	["tree /mnt/c", true, "tree /mnt subpath"],
	["tree ./src", false, "tree ./src"],
	// ─── rm -rf ────────────────────────────────────────────────────────────────
	["rm -rf /", true, "rm -rf /"],
	["rm -rf /home/x", true, "rm -rf /home subpath (used to slip through)"],
	["rm -rf /var/cache/foo", true, "rm -rf /var subpath (used to slip through)"],
	["rm -rf /mnt/c/Users/x", true, "rm -rf /mnt subpath"],
	["rm -rf ./build", false, "rm -rf ./build (relative)"],
	["rm -rf /tmp/foo", false, "rm -rf /tmp/foo (allow-listed)"],
	["rm -fr /etc", true, "rm -fr /etc (flag order)"],
	["rm -r /usr/local", true, "rm -r /usr (just -r, no f)"],
	["rm file.txt", false, "plain rm (no -r) untouched"],
	// ─── chains ────────────────────────────────────────────────────────────────
	["echo hi && rm -rf /", true, "chained rm -rf / via &&"],
	["cd foo; find /", true, "chained find / via ;"],
	["cd foo; find /mnt/c/Users", true, "chained find /mnt subpath via ;"],
	["echo go | rg foo /home", true, "chained rg /home via |"],
	// ─── negative-case sanity ────────────────────────────────────────────────────
	["echo /etc/passwd", false, "echo with /etc literal (no find/rg/grep)"],
	["cat /etc/passwd", false, "cat with /etc (read, not scan)"],
	["git push origin main", false, "git push outside sub-agent"],
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
