/**
 * guardian — pi extension loaded inside every sub-agent child to enforce
 * identity, role, execution policy, and ritual workflow.
 *
 * Renamed from `fleet-citizen.ts` and restructured into codex-shaped sections
 * so the boundaries match codex's runtime concepts:
 *
 *   1. identity      — who am I (run + agent ids, worktree)
 *   2. agent-role    — codex `core/src/agent/role.rs` analog: load
 *                      developer-instructions from `~/.pi/agent/roles/<role>.json`
 *                      and inject into context on every LLM call
 *   3. execpolicy    — codex `execpolicy/` analog: prefix-rule-based bash
 *                      command blocker loaded from `~/.pi/agent/execpolicy.json`,
 *                      merged with built-in defaults
 *   4. banned-phrases — Lorenzo-specific assistant-text scanner (no codex
 *                      equivalent; auto-steers on hit, aborts after 3 hits)
 *   5. rituals       — `/done`, `/halt`, `/guardian` (workflow commands)
 *
 * Loaded automatically inside each pi sub-agent spawned by subagents.ts (and
 * by the legacy pi-fleet Python CLI). Loaded outside a sub-agent it
 * degrades gracefully: no env vars → no identity → no role-injection →
 * built-in execpolicy still active (so the bash guardrails protect every pi
 * session, not just sub-agents).
 *
 * Env vars (set by the parent — subagents.ts or pi-fleet supervisor):
 *   PI_GUARDIAN_RUN_ID    run-id this child belongs to  (alias: PI_FLEET_RUN_ID)
 *   PI_GUARDIAN_AGENT_ID  child label                   (alias: PI_FLEET_AGENT_ID)
 *   PI_GUARDIAN_RUN_DIR   run dir on disk               (alias: PI_FLEET_STATE_DIR)
 *   PI_GUARDIAN_AGENT_DIR child dir on disk             (alias: PI_FLEET_AGENT_DIR)
 *   PI_GUARDIAN_ROLE      name of role under ~/.pi/agent/roles/<name>.json
 *   PI_GUARDIAN_BANNED_PHRASES  JSON array              (alias: PI_FLEET_BANNED_PHRASES)
 *   PI_GUARDIAN_EXECPOLICY      JSON path override (default ~/.pi/agent/execpolicy.json)
 *
 * Legacy env vars are honored for back-compat with pi-fleet's Python
 * supervisor; the `PI_GUARDIAN_*` vars take precedence when both are set.
 *
 * Back-compat symlink: `fleet-citizen.ts` still exists in this repo as a
 * one-line stub re-exporting this extension, so pi-fleet's hardcoded
 * `~/.pi/agent/extensions/fleet-citizen.ts` path keeps working.
 *
 * Author: pi self-replication exercise (originally Lorenzo Alberto Maria
 * Ambrosi as fleet-citizen.ts; restructured against codex shapes).
 * License: MIT
 */

import { exec, execSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

// ─── identity ──────────────────────────────────────────────────────────────

/**
 * Read a guardian env var with legacy PI_FLEET_* fallback. The PI_GUARDIAN_*
 * name wins when both are set, so pi-fleet can keep emitting PI_FLEET_* and
 * new subagents.ts spawners can emit PI_GUARDIAN_* without conflict.
 */
function envVar(modern: string, legacy?: string): string {
	const v = process.env[modern];
	if (v) return v;
	if (legacy) {
		const l = process.env[legacy];
		if (l) return l;
	}
	return "";
}

const RUN_ID = envVar("PI_GUARDIAN_RUN_ID", "PI_FLEET_RUN_ID");
const AGENT_ID = envVar("PI_GUARDIAN_AGENT_ID", "PI_FLEET_AGENT_ID");
const RUN_DIR = envVar("PI_GUARDIAN_RUN_DIR", "PI_FLEET_STATE_DIR");
const AGENT_DIR = envVar("PI_GUARDIAN_AGENT_DIR", "PI_FLEET_AGENT_DIR");
const ROLE_NAME = envVar("PI_GUARDIAN_ROLE");
const IN_SUBAGENT = Boolean(RUN_ID && AGENT_ID && AGENT_DIR);

const BANNED_PHRASES: string[] = (() => {
	const raw = envVar("PI_GUARDIAN_BANNED_PHRASES", "PI_FLEET_BANNED_PHRASES");
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
})();

// ─── agent-role (codex core/src/agent/role.rs analog) ──────────────────────

/**
 * Codex's per-role config has many fields (model_reasoning_effort,
 * background_terminal_max_timeout, etc.); pi extensions can only meaningfully
 * apply `developer_instructions` via context-injection, so v0 ports just that
 * field. Future revisions can layer model/thinking overrides via
 * pi.setActiveTools / etc.
 *
 * codex source: codex-rs/core/src/agent/role.rs + builtins/{awaiter,explorer}.toml
 */
interface AgentRoleSpec {
	developer_instructions?: string;
	/** Free-form; kept for forward-compat with codex's richer schema. */
	[k: string]: unknown;
}

function rolesDir(): string {
	const piHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(piHome, "roles");
}

function loadRole(name: string): AgentRoleSpec | undefined {
	if (!name) return undefined;
	const path = join(rolesDir(), `${name}.json`);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as AgentRoleSpec) : undefined;
	} catch {
		return undefined;
	}
}

// ─── execpolicy (codex execpolicy/ analog, JSON-flavored) ──────────────────

/**
 * One prefix rule. Codex's Starlark `prefix_rule(pattern=[...], decision=..., justification=..., match=..., not_match=...)` collapses to this. Pattern
 * tokens can be a single string ("git") or alternatives (["push", "pull"])
 * — same semantics as codex's `Single`/`Alts` PatternToken.
 *
 * `decision`: "forbidden" blocks the tool call; "prompt" is parsed but
 * downgraded to a warning notify (pi extensions can't surface an interactive
 * approval prompt mid-tool-call without async UI work — that's the next
 * iteration).
 *
 * codex source: codex-rs/execpolicy/src/rule.rs (PrefixPattern, PatternToken)
 */
interface ExecPolicyRule {
	pattern: Array<string | string[]>;
	decision?: "forbidden" | "prompt" | "allow";
	justification?: string;
	/** Optional regex fallback for patterns prefix-tokens can't express
	 * (e.g. "find / without further args"). Applied to the joined command. */
	regex?: string;
}

interface ExecPolicyFile {
	rules: ExecPolicyRule[];
}

/**
 * Built-in defaults. These are the same patterns the old fleet-citizen had
 * but in codex-shaped prefix-rule form. They apply to every pi session
 * (in-fleet or not) so a stray `find /` in a normal pi run is blocked too.
 *
 * Where prefix-rule semantics can't capture intent (e.g. "grep -r /" with a
 * regex flag between), we drop to a `regex` field that runs against the
 * full command string.
 */
const DEFAULT_EXECPOLICY: ExecPolicyRule[] = [
	// git discipline (only enforced inside a sub-agent context)
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

	// catastrophic destruction
	//
	// IMPORTANT: matchPrefix uses EXACT token equality. A rule pattern of
	// ["rm", "-rf", "/"] would only match `rm -rf /` (with `/` alone) and
	// MISS `rm -rf /home/x`, `rm -rf /var/cache/foo`, `rm -rf /mnt/c/...`, etc.
	// All filesystem-scan / destruction rules below therefore drop the literal
	// path token from the prefix and rely on the regex to catch any absolute
	// system path. Allow-list: /tmp[/...] (small, regularly cleaned).
	//
	// Regex idiom shared across the rules below:
	//   `(?:^|\s)/(?!tmp\b|tmp/)`
	// = a `/` preceded by start-of-segment or whitespace, NOT followed by
	//   `tmp` + word-boundary (so `/tmp`, `/tmp ` allowed) or `tmp/` (so
	//   `/tmp/foo` allowed). Everything else (`/`, `/mnt/c/...`, `/home/x`,
	//   `/var/log/...`, `/etc/...`) matches and is blocked.
	{
		pattern: ["rm"],
		decision: "forbidden",
		justification:
			"rm -r/-rf on absolute system paths is too dangerous without explicit user confirmation. " +
			"If you really need to wipe an absolute path, cd there first and use a relative target, " +
			"or run it via /bash with the user's explicit ok. /tmp[/...] is allowed.",
		// Require `rm` + an -r/-rf/-R/-fr flag SOMEWHERE before the path, then
		// a path that starts with `/` and is not `/tmp[/...]`. Plain `rm <file>`
		// (no -r) is untouched.
		regex:
			"\\brm\\b(?:[^|;&\\n]*?\\s)-\\S*[rR]\\S*\\b[^|;&\\n]*?(?:^|\\s)/(?!tmp\\b|tmp/)",
	},

	// filesystem-scan bans
	//
	// One rule per scanner tool. Each catches `<tool> <abs-path>` for any
	// abs-path except /tmp[/...]. Replaces the old per-path rules (["find",
	// "/"], ["find", "/mnt"], ["rg", "/mnt"], etc.) which only matched the
	// bare path token — letting `find /mnt/c/Users`, `find /home/x`,
	// `rg /var/log/...` slip through.
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
		// Require -r/-R flag SOMEWHERE in the args, then an abs path that's not /tmp.
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

function execPolicyPath(): string {
	const override = process.env.PI_GUARDIAN_EXECPOLICY;
	if (override) return override;
	const piHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(piHome, "execpolicy.json");
}

function loadExecPolicy(): ExecPolicyRule[] {
	const path = execPolicyPath();
	let userRules: ExecPolicyRule[] = [];
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as ExecPolicyFile;
			if (parsed && Array.isArray(parsed.rules)) {
				userRules = parsed.rules.filter((r) => r && Array.isArray(r.pattern));
			}
		} catch {
			/* malformed user policy — ignore, fall back to defaults */
		}
	}
	// User rules layered on top of defaults — user can shadow / override by
	// matching the same prefix earlier in the merged list.
	return [...userRules, ...DEFAULT_EXECPOLICY];
}

/**
 * Tokenize a shell command into argv-ish strings. Best-effort: handles
 * single-quoted, double-quoted, and unquoted tokens; respects backslash
 * escapes inside double quotes. Doesn't handle subshells / pipes specially —
 * those are split at the boundary so each segment is checked separately.
 *
 * Codex uses `shlex::try_join` for the reverse; here we go the other way.
 */
function tokenize(command: string, depth = 0): string[][] {
	// Split on `;` `&&` `||` `|` only outside quotes so a wrapper like
	// `bash -lc 'echo ok && rm -rf /'` is first recognized as a shell wrapper,
	// then recursively inspected via its `-c` payload.
	const segments = splitShellSegments(command);
	const out: string[][] = [];
	for (const seg of segments) {
		const tokens = tokenizeSegment(seg);
		if (tokens.length === 0) continue;
		out.push(tokens);
		const wrapped = depth < 3 ? shellWrapperPayload(tokens) : undefined;
		if (wrapped) out.push(...tokenize(wrapped, depth + 1));
	}
	return out;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (inSingle) {
			cur += ch;
			if (ch === "'") inSingle = false;
			i += 1;
			continue;
		}
		if (inDouble) {
			cur += ch;
			if (ch === '"') inDouble = false;
			else if (ch === "\\" && i + 1 < command.length) {
				cur += command[i + 1];
				i += 1;
			}
			i += 1;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			cur += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			cur += ch;
			i += 1;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (ch === ";" || ch === "|" || two === "&&" || two === "||") {
			if (cur.trim()) segments.push(cur.trim());
			cur = "";
			i += two === "&&" || two === "||" ? 2 : 1;
			continue;
		}
		cur += ch;
		i += 1;
	}
	if (cur.trim()) segments.push(cur.trim());
	return segments;
}

function shellWrapperPayload(tokens: string[]): string | undefined {
	if (tokens.length < 3) return undefined;
	const shell = tokens[0].split(/[\\/]/).pop() ?? tokens[0];
	if (!["bash", "sh", "zsh", "dash", "fish"].includes(shell)) return undefined;
	for (let i = 1; i < tokens.length - 1; i++) {
		const tok = tokens[i];
		if (tok === "-c" || (/^-[A-Za-z]*c[A-Za-z]*$/.test(tok))) {
			return tokens[i + 1];
		}
	}
	return undefined;
}

function tokenizeSegment(seg: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < seg.length) {
		const ch = seg[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				cur += ch;
			}
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && i + 1 < seg.length) {
				cur += seg[i + 1];
				i += 1;
			} else {
				cur += ch;
			}
		} else if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (/\s/.test(ch)) {
			if (cur.length > 0) {
				out.push(cur);
				cur = "";
			}
		} else {
			cur += ch;
		}
		i += 1;
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

/**
 * Check if a tokenized command matches a rule's prefix pattern. Returns true
 * iff every pattern token matches the corresponding command token (alts: any
 * of the alternatives matches).
 *
 * Codex's matcher does the same with first-token-equals + per-token alts.
 */
function matchPrefix(tokens: string[], pattern: Array<string | string[]>): boolean {
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

/**
 * Returns the first matching rule for the command, or undefined if no rule
 * blocks it. Tries each segment (split on `;` / `&&` / `||` / `|`) so a
 * chained command can't smuggle a forbidden tail past the front.
 *
 * Matching semantics: prefix is required. If a rule also specifies a regex,
 * the regex is authoritative and BOTH must match. This lets a rule use a
 * cheap prefix pre-filter (e.g. `["grep"]`) plus a regex that narrows to
 * the dangerous form (`grep -r ... /`). Verified by tests/test-execpolicy.mjs.
 */
function evaluateExecPolicy(
	rules: ExecPolicyRule[],
	command: string,
): ExecPolicyRule | undefined {
	const segments = tokenize(command);
	for (const seg of segments) {
		for (const rule of rules) {
			if (!matchPrefix(seg, rule.pattern)) continue;
			if (rule.regex) {
				try {
					if (!new RegExp(rule.regex).test(command)) continue;
				} catch {
					continue; // malformed user regex — skip
				}
			}
			if (rule.decision === "forbidden") return rule;
		}
	}
	return undefined;
}

// ─── git info (used by /done, /halt, /guardian, addendum) ──────────────────

interface GitInfo {
	branch?: string;
	head?: string;
	dirty?: boolean;
}

const _gitInfoCache = new Map<string, { info: GitInfo; t: number }>();
const GIT_INFO_TTL_MS = 30_000;

async function gitInfoAsync(
	cwd: string,
	opts: { skipDirty?: boolean } = {},
): Promise<GitInfo> {
	const cached = _gitInfoCache.get(cwd);
	const now = Date.now();
	if (cached && now - cached.t < GIT_INFO_TTL_MS) {
		if (!opts.skipDirty && cached.info.dirty === undefined) {
			/* fall through */
		} else {
			return cached.info;
		}
	}
	try {
		const [branchRes, headRes] = await Promise.all([
			execAsync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 10_000 }),
			execAsync("git rev-parse --short HEAD", { cwd, timeout: 10_000 }),
		]);
		let dirty: boolean | undefined;
		if (!opts.skipDirty) {
			const statusRes = await execAsync(
				"git status --porcelain --untracked-files=no",
				{ cwd, timeout: 15_000 },
			);
			dirty = statusRes.stdout.trim().length > 0;
		}
		const info: GitInfo = {
			branch: branchRes.stdout.trim(),
			head: headRes.stdout.trim(),
			dirty,
		};
		_gitInfoCache.set(cwd, { info, t: now });
		return info;
	} catch {
		return {};
	}
}

function gitInfoSync(cwd: string, opts: { skipDirty?: boolean } = {}): GitInfo {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8", timeout: 10_000 }).trim();
		const head = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8", timeout: 10_000 }).trim();
		let dirty: boolean | undefined;
		if (!opts.skipDirty) {
			const status = execSync("git status --porcelain --untracked-files=no", { cwd, encoding: "utf8", timeout: 15_000 });
			dirty = status.trim().length > 0;
		}
		return { branch, head, dirty };
	} catch {
		return {};
	}
}

// ─── logging ──────────────────────────────────────────────────────────────

function logGuardian(message: string): void {
	if (!AGENT_DIR) return;
	const ts = new Date().toISOString().slice(11, 19);
	try {
		// File name kept as fleet-citizen.log for back-compat with the
		// pi-fleet Python CLI dashboard that scrapes it.
		appendFileSync(join(AGENT_DIR, "fleet-citizen.log"), `[${ts}] ${message}\n`);
	} catch {
		/* best-effort */
	}
}

const HALT_TEMPLATE = `HALT — workaround required.

I was asked to do X but the premise required:
  - <fill in: missing primitive / private namespace reach / per-iteration wrap>

Per AGENTS.md HALT-on-workaround pattern, I'm stopping and surfacing this
to the architect rather than shipping the workaround. Suggested prereq:
  - <fill in>
`;

function footerTag(): string {
	if (!IN_SUBAGENT) return "";
	return `${AGENT_ID}@${RUN_ID.slice(0, 16)}`;
}

// ─── extension entrypoint ─────────────────────────────────────────────────

// Load-once sentinel on `globalThis` (NOT process.env — that leaks to child
// pi spawns; NOT a module `let` — bun can load .ts twice as separate modules).
const LOAD_SENTINEL_KEY = "__pi_guardian_loaded__";

export default function guardian(pi: ExtensionAPI): void {
	const g = globalThis as Record<string, unknown>;
	if (g[LOAD_SENTINEL_KEY]) return;
	g[LOAD_SENTINEL_KEY] = true;
	delete process.env.PI_GUARDIAN_LOADED; // scrub any pre-fix leak

	const role = loadRole(ROLE_NAME);
	const execpolicy = loadExecPolicy();
	logGuardian(
		`guardian loaded  in_subagent=${IN_SUBAGENT}  role=${ROLE_NAME || "(none)"}  ` +
			`rules=${execpolicy.length}  banned=${BANNED_PHRASES.length}`,
	);

	// banned-phrase scanner state (preserved verbatim — no codex equivalent)
	let textWindow = "";
	const TEXT_WINDOW_MAX = 4096;
	let lastBannedHit = 0;
	let bannedSteerCount = 0;
	const MAX_STEER_REPEATS = 3;

	// ─── 1 + 2: identity + agent-role context injection ───────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (IN_SUBAGENT && ctx.hasUI) {
			ctx.ui.setStatus("guardian", footerTag());
			try {
				ctx.ui.setTitle(`pi · ${AGENT_ID} · ${RUN_ID.slice(0, 16)}`);
			} catch {
				/* ignore — setTitle is optional */
			}
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!IN_SUBAGENT) return undefined;
		const cwd = process.cwd();
		const info = await gitInfoAsync(cwd, { skipDirty: true });
		const lines: string[] = [];
		lines.push("");
		lines.push(`<guardian>`);
		lines.push(`  run_id: ${RUN_ID}`);
		lines.push(`  agent_id: ${AGENT_ID}`);
		lines.push(`  worktree: ${cwd}`);
		if (ROLE_NAME) lines.push(`  role: ${ROLE_NAME}`);
		if (info.branch) lines.push(`  branch: ${info.branch}`);
		if (info.head) lines.push(`  head: ${info.head}`);
		if (BANNED_PHRASES.length) {
			lines.push(`  banned_phrases: ${JSON.stringify(BANNED_PHRASES)}`);
		}
		lines.push(`</guardian>`);
		lines.push("");
		lines.push("You are a dispatched sub-agent. Stay within scope. If your dispatch");
		lines.push("brief requires a workaround (missing primitive, per-iteration wrap of what");
		lines.push("should be one cfg axis, reaching into private namespaces) STOP and report");
		lines.push("via /halt rather than shipping the workaround. Commit when done.");

		// Agent-role developer instructions (codex's apply_role_to_config analog).
		// Layered AFTER the identity block so role-specific instructions land
		// closer to the model's working memory.
		if (role?.developer_instructions) {
			lines.push("");
			lines.push("<agent_role_instructions>");
			lines.push(String(role.developer_instructions).trim());
			lines.push("</agent_role_instructions>");
		}

		return { systemPrompt: event.systemPrompt + "\n" + lines.join("\n") };
	});

	// ─── 3: execpolicy enforcement on tool_call ───────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		// Built-in defaults apply EVERYWHERE (even outside sub-agents) for
		// catastrophic + filesystem-scan patterns. The git-discipline rules
		// only make sense inside a sub-agent context, so we gate them: if
		// the user is in a normal pi session and ran `git push`, that should
		// just work. Implementation: rules whose justification mentions
		// "dispatched dev agent" or "sub-agent" are sub-agent-only.
		const command: string = event.input.command ?? "";
		const applicable = IN_SUBAGENT
			? execpolicy
			: execpolicy.filter((r) => {
					const j = r.justification ?? "";
					return (
						!j.includes("dispatched dev agent") &&
						!j.includes("sub-agent") &&
						!j.includes("worktree isolation")
					);
				});
		const hit = evaluateExecPolicy(applicable, command);
		if (hit) {
			logGuardian(
				`execpolicy blocked: ${hit.justification ?? "(no reason)"} cmd=${command.slice(0, 200)}`,
			);
			return {
				block: true,
				reason: hit.justification ?? "blocked by execpolicy",
			};
		}
		return undefined;
	});

	// ─── 4: banned-phrase scanner (Lorenzo-specific, no codex equivalent) ──

	pi.on("message_update", async (event, _ctx) => {
		if (!BANNED_PHRASES.length) return;
		const ame = event.assistantMessageEvent;
		if (!ame || ame.type !== "text_delta") return;
		const delta = ame.delta ?? "";
		if (!delta) return;
		textWindow = (textWindow + delta).slice(-TEXT_WINDOW_MAX);
		const lower = textWindow.toLowerCase();
		const now = Date.now();
		if (now - lastBannedHit < 10_000) return;
		for (const phrase of BANNED_PHRASES) {
			if (lower.includes(phrase.toLowerCase())) {
				lastBannedHit = now;
				bannedSteerCount += 1;
				logGuardian(`banned-phrase hit (#${bannedSteerCount}): ${phrase}`);
				textWindow = "";

				if (bannedSteerCount > MAX_STEER_REPEATS) {
					logGuardian("MAX_STEER_REPEATS exceeded — not steering further");
					pi.sendUserMessage(
						`You have repeatedly used banned phrases (${bannedSteerCount}) despite ` +
							`previous steering. Stop drafting and emit /halt with reason "persistent ` +
							`banned-phrase use". The architect will review.`,
						{ deliverAs: "steer" },
					);
					return;
				}

				pi.sendUserMessage(
					`You used the banned phrase ${JSON.stringify(phrase)}. Per AGENTS.md this is a ` +
						`discipline failure — rewrite your last assistant turn without it. If the underlying ` +
						`claim is real, replace it with specific verification (cite parent-SHA rebuild evidence, ` +
						`name the exact file:line, or HALT and surface).`,
					{ deliverAs: "steer" },
				);
				return;
			}
		}
	});

	// ─── per-turn state snapshot (pi-fleet dashboard back-compat) ─────────

	pi.on("turn_end", async (_event, _ctx) => {
		if (!IN_SUBAGENT) return;
		const cwd = process.cwd();
		const info = await gitInfoAsync(cwd, { skipDirty: true });
		if (info.head) {
			try {
				// File name + shape preserved for the pi-fleet Python CLI.
				const stateFile = join(AGENT_DIR, "fleet-citizen-state.json");
				writeFileSync(
					stateFile,
					JSON.stringify({ branch: info.branch, head: info.head, t: Date.now() }, null, 2),
				);
			} catch (e) {
				logGuardian(`failed to write fleet-citizen-state.json: ${String(e)}`);
			}
		}
	});

	// ─── 5: rituals (/done, /halt, /guardian) ─────────────────────────────

	pi.registerCommand("done", {
		description: "Finalize this sub-agent: stage + commit + audit + report",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cwd = process.cwd();
			const info = await gitInfoAsync(cwd, { skipDirty: false });
			const messageHeader = args.trim() || `[${AGENT_ID || "pi"}] dispatch complete`;
			const lines: string[] = [];
			lines.push(`branch:    ${info.branch ?? "?"}`);
			lines.push(`head:      ${info.head ?? "?"}`);
			lines.push(`dirty:     ${info.dirty ? "YES" : "no"}`);
			try {
				const diffstat = execSync("git diff --stat HEAD", { cwd, encoding: "utf8", timeout: 15_000 });
				if (diffstat.trim()) {
					lines.push("");
					lines.push("staged + unstaged changes:");
					lines.push(diffstat.trim());
				}
			} catch {
				/* ignore */
			}
			ctx.ui.notify(`/done — ${messageHeader}`, "info");
			if (ctx.hasUI) ctx.ui.setStatus("guardian-done", `done @ ${info.head ?? "?"}`);
			if (AGENT_DIR) {
				try {
					writeFileSync(join(AGENT_DIR, "done-summary.txt"), lines.join("\n") + "\n");
				} catch {
					/* ignore */
				}
			}
			pi.sendMessage(
				{
					customType: "guardian-done-summary",
					content: lines.join("\n"),
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	pi.registerCommand("halt", {
		description: "Emit the AGENTS.md HALT-on-workaround pattern (no commit)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const body = args.trim() || HALT_TEMPLATE;
			ctx.ui.notify("HALT — surfacing to architect, NOT committing", "warning");
			if (AGENT_DIR) {
				try {
					writeFileSync(join(AGENT_DIR, "HALT.md"), body + "\n");
				} catch {
					/* ignore */
				}
			}
			pi.sendMessage(
				{
					customType: "guardian-halt",
					content: body,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	pi.registerCommand("guardian", {
		description: "Show this sub-agent's guardian identity, role, and execpolicy summary",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const cwd = process.cwd();
			const info = await gitInfoAsync(cwd, { skipDirty: false });
			const out = [
				`run_id     ${RUN_ID || "(not in a sub-agent)"}`,
				`agent_id   ${AGENT_ID || "-"}`,
				`worktree   ${cwd}`,
				`branch     ${info.branch ?? "?"}`,
				`head       ${info.head ?? "?"}`,
				`dirty      ${info.dirty ? "YES" : "no"}`,
				`role       ${ROLE_NAME || "(none)"}` + (role?.developer_instructions ? ` (${String(role.developer_instructions).length} chars)` : ""),
				`execpolicy ${execpolicy.length} rules (${execpolicy.filter((r) => r.decision === "forbidden").length} forbidden)`,
				`banned     ${BANNED_PHRASES.length} phrases`,
			].join("\n");
			ctx.ui.notify(out, "info");
		},
	});

	// Legacy alias — old /fleet command kept so muscle memory works.
	pi.registerCommand("fleet", {
		description: "Alias for /guardian (renamed; old fleet-citizen name kept for back-compat)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Defer to the /guardian handler by re-dispatching its body. Easier:
			// just re-call the same logic.
			const cwd = process.cwd();
			const info = await gitInfoAsync(cwd, { skipDirty: false });
			const out = [
				`run_id   ${RUN_ID || "(not in a sub-agent)"}`,
				`agent    ${AGENT_ID || "-"}`,
				`worktree ${cwd}`,
				`branch   ${info.branch ?? "?"}`,
				`head     ${info.head ?? "?"}`,
				`dirty    ${info.dirty ? "YES" : "no"}`,
				`banned   ${BANNED_PHRASES.length} phrases`,
			].join("\n");
			void args;
			ctx.ui.notify(out, "info");
		},
	});

	// ─── final report dump on shutdown ────────────────────────────────────

	pi.on("session_shutdown", async (event, _ctx) => {
		if (!IN_SUBAGENT) return;
		logGuardian(`session_shutdown reason=${event.reason}`);
		try {
			const cwd = process.cwd();
			const info = gitInfoSync(cwd, { skipDirty: true });
			const summary = {
				run_id: RUN_ID,
				agent_id: AGENT_ID,
				reason: event.reason,
				branch: info.branch,
				head: info.head,
				dirty: info.dirty,
				t: Date.now(),
			};
			writeFileSync(join(AGENT_DIR, "shutdown.json"), JSON.stringify(summary, null, 2));
		} catch {
			/* ignore */
		}
	});
}
