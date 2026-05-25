/**
 * fleet-citizen — pi extension that gives every agent in a pi-fleet run:
 *   1. A footer status line showing fleet identity + context %
 *   2. Banned-phrase guard over assistant text (auto-steer to rewrite)
 *   3. Tool-call guardrails for dangerous bash invocations + main-tree edits
 *   4. /done slash command — runs commit + audit + writes status to fleet dir
 *   5. /halt slash command — emit the AGENTS.md HALT pattern
 *   6. Final report dump on session shutdown
 *
 * Reads identity + config from env (set by pi-fleet supervisor):
 *   PI_FLEET_RUN_ID            run-id this agent belongs to
 *   PI_FLEET_AGENT_ID          agent label (P73, P74a, etc.)
 *   PI_FLEET_STATE_DIR         absolute path to fleet run dir
 *   PI_FLEET_AGENT_DIR         absolute path to this agent's subdir
 *   PI_FLEET_BANNED_PHRASES    JSON array of phrases to refuse
 *   PI_FLEET_AUTO_COMPACT_THRESHOLD   fraction (0.0-1.0), default 0.85
 *
 * Safe to load outside a fleet too — every feature degrades gracefully when
 * the env vars are missing.
 *
 * Author: Lorenzo Alberto Maria Ambrosi <la@thundron.dev>
 * License: MIT
 */

import { exec, execSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

const RUN_ID = process.env.PI_FLEET_RUN_ID ?? "";
const AGENT_ID = process.env.PI_FLEET_AGENT_ID ?? "";
const STATE_DIR = process.env.PI_FLEET_STATE_DIR ?? "";
const AGENT_DIR = process.env.PI_FLEET_AGENT_DIR ?? "";
const IN_FLEET = Boolean(RUN_ID && AGENT_ID && AGENT_DIR);

const BANNED_PHRASES: string[] = (() => {
	try {
		const v = JSON.parse(process.env.PI_FLEET_BANNED_PHRASES ?? "[]");
		return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
})();

// Tool-call guardrails — patterns we refuse outright (no human prompt) for
// dispatched dev agents per AGENTS.md "Worktree discipline".
//
// FILESYSTEM-SCAN BANS (the find / class):
//   Any command that walks the WSL root filesystem or /mnt/* DrvFs FUSE
//   mounts takes minutes-to-hours and looks indistinguishable from a hang.
//   The agent should never need it; if it thinks it does, the brief is wrong.
//   Block the command, tell the agent to scope it. The agent will rewrite
//   with `find ./src ...` or similar on the next turn.
//
//   The reason string is fed BACK to the agent as the tool's error result,
//   so make it actionable: name the alternative.
const BANNED_BASH_PATTERNS: { re: RegExp; reason: string }[] = [
	// git discipline
	{ re: /\bgit\s+push\b/, reason: "git push is banned in dispatched dev agent context" },
	{ re: /\bgit\s+checkout\s+meta-kernel-ir-compositor\b/, reason: "checkout to meta-kernel-ir-compositor is banned" },
	{ re: /\bgit\s+(reset|checkout)\s+--ignore-other-worktrees\b/, reason: "--ignore-other-worktrees is banned" },
	{ re: /\bgit\s+(branch|update-ref)\s+-(?:f|B)\b/, reason: "force-branch / update-ref are banned" },
	{ re: /\brm\s+-rf\s+\/(?:\s|$)/, reason: "rm -rf / is catastrophic" },

	// find from /
	{
		re: /\bfind\s+\/(?!\S)/,
		reason:
			"find / scans the entire filesystem (~30+ min on WSL with /mnt/* FUSE mounts). Re-issue with an explicit scope: 'find . -name X' or 'find <specific-dir> -name X'. If you don't know where the file is, use 'find . -type f -name X' from the worktree root first.",
	},
	{
		re: /\bfind\s+\/mnt\b/,
		reason:
			"find /mnt walks WSL DrvFs FUSE mounts (extremely slow, often >5 min). Scope to a specific subdirectory under the worktree instead.",
	},

	// recursive grep / rg from / or /mnt
	{
		re: /\bgrep\s+(?:[^|;&\n]*\s+)?-\S*[rR]\S*\s+(?:[^|;&\n]*\s+)?\/(?!\S)/,
		reason:
			"grep -r / scans the entire filesystem. Scope to a specific directory: 'grep -r pattern ./src' or 'grep -r pattern $(git rev-parse --show-toplevel)'.",
	},
	{
		re: /\bgrep\s+(?:[^|;&\n]*\s+)?-\S*[rR]\S*\s+(?:[^|;&\n]*\s+)?\/mnt\b/,
		reason: "grep -r on /mnt walks WSL FUSE mounts. Scope it.",
	},
	{
		re: /\brg\s+(?:[^|;&\n]*\s+)?\/(?!\S)/,
		reason: "rg from / scans the entire filesystem. Scope it: 'rg pattern ./src' or just 'rg pattern' (rg defaults to cwd).",
	},
	{
		re: /\brg\s+(?:[^|;&\n]*\s+)?\/mnt\b/,
		reason: "rg on /mnt walks WSL FUSE mounts. Scope it.",
	},

	// disk-usage / tree / recursive-ls from / or /mnt
	{
		re: /\b(?:du|tree)\s+(?:-\S+\s+)*\/(?!\S)/,
		reason:
			"du / and tree / scan the entire filesystem. Scope to a specific directory.",
	},
	{
		re: /\b(?:du|tree)\s+(?:-\S+\s+)*\/mnt\b/,
		reason: "du/tree on /mnt walks WSL FUSE mounts. Scope it.",
	},
	{
		re: /\bls\s+(?:-\S+\s+)*(?=-\S*R\S*)\S+\s+\/(?!\S)/,
		reason: "ls -R / scans the entire filesystem. Scope to a specific directory.",
	},
];

const HALT_TEMPLATE = `HALT — workaround required.

I was asked to do X but the premise required:
  - <fill in: missing primitive / private namespace reach / per-iteration wrap>

Per AGENTS.md HALT-on-workaround pattern, I'm stopping and surfacing this
to the architect rather than shipping the workaround. Suggested prereq:
  - <fill in>
`;

// ── helpers ────────────────────────────────────────────────────────────────

function logSupervisor(message: string): void {
	if (!AGENT_DIR) return;
	const ts = new Date().toISOString().slice(11, 19);
	try {
		appendFileSync(join(AGENT_DIR, "fleet-citizen.log"), `[${ts}] ${message}\n`);
	} catch {
		// Best-effort logging only
	}
}

// Cached git info. The previous implementation called `execSync` 3x per
// invocation, blocking the Node event loop. On large worktrees mounted via
// WSL2 9P (/mnt/c), `git status --porcelain` alone can take 6-8 seconds.
// before_agent_start + turn_end together = 12-16s per turn of blocked event
// loop, which stalls the SSE stream from api.anthropic.com and triggers the
// 15-20 minute hang that pi-fleet's stall watchdog has been catching.
//
// New design:
//   - All git invocations are async (promisified exec) so the event loop
//     keeps spinning while git runs.
//   - Results cached per cwd with TTL (default 30s).
//   - `gitInfoAsync(cwd, { skipDirty: true })` skips the expensive
//     `git status --porcelain` call. Hot-path hooks (before_agent_start,
//     turn_end) use this; only /done / /halt / /fleet need the full dirty
//     state and pay the cost there (where the user invoked it explicitly).
//   - Cache TTL is short enough to refresh between turns but long enough
//     that rapid back-to-back hooks share one git invocation.

interface GitInfo {
	branch?: string;
	head?: string;
	dirty?: boolean;
}

const _gitInfoCache = new Map<string, { info: GitInfo; t: number }>();
const GIT_INFO_TTL_MS = 30_000;

async function gitInfoAsync(cwd: string, opts: { skipDirty?: boolean } = {}): Promise<GitInfo> {
	const cached = _gitInfoCache.get(cwd);
	const now = Date.now();
	if (cached && now - cached.t < GIT_INFO_TTL_MS) {
		// Cached — unless the caller wants dirty state and we don't have it
		if (!opts.skipDirty && cached.info.dirty === undefined) {
			// fall through to fetch dirty state
		} else {
			return cached.info;
		}
	}
	try {
		const [branchRes, headRes] = await Promise.all([
			execAsync("git rev-parse --abbrev-ref HEAD", { cwd }),
			execAsync("git rev-parse --short HEAD", { cwd }),
		]);
		let dirty: boolean | undefined;
		if (!opts.skipDirty) {
			// Only invoke git status when the caller explicitly wants dirty info.
			// Use --untracked-files=no to skip walking entire worktree for untracked
			// files — we only care about "has the agent staged/modified anything".
			const statusRes = await execAsync(
				"git status --porcelain --untracked-files=no",
				{ cwd },
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

// Synchronous fallback for command handlers that MUST have results inline
// (notify dialogs, etc.). Same skipDirty option. Used sparingly and only
// outside hot-path event hooks.
function gitInfoSync(cwd: string, opts: { skipDirty?: boolean } = {}): GitInfo {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
		const head = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8" }).trim();
		let dirty: boolean | undefined;
		if (!opts.skipDirty) {
			const status = execSync("git status --porcelain --untracked-files=no", { cwd, encoding: "utf8" });
			dirty = status.trim().length > 0;
		}
		return { branch, head, dirty };
	} catch {
		return {};
	}
}

function escapeFooterFleetTag(): string {
	if (!IN_FLEET) return "";
	return `fleet ${AGENT_ID}@${RUN_ID.slice(0, 16)}`;
}

// ── extension ──────────────────────────────────────────────────────────────

export default function fleetCitizen(pi: ExtensionAPI): void {
	let textWindow = ""; // rolling window for banned-phrase scanning
	const TEXT_WINDOW_MAX = 4096;
	let lastBannedHit = 0;

	logSupervisor(`fleet-citizen loaded  in_fleet=${IN_FLEET}  banned=${BANNED_PHRASES.length}`);

	// 1. Footer status — fleet identity (refreshed via thinking_level_select too)
	pi.on("session_start", async (_event, ctx) => {
		if (IN_FLEET) {
			ctx.ui.setStatus("fleet", escapeFooterFleetTag());
			ctx.ui.setTitle?.(`pi · ${AGENT_ID} · ${RUN_ID.slice(0, 16)}`);
		}
		// Inject a small system-prompt addendum reminding the agent of its identity
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!IN_FLEET) return undefined;
		const cwd = process.cwd();
		// Hot path: skip the expensive `git status` call here.  The agent gets
		// branch + head identifiers for orientation; it does NOT need to know
		// whether the worktree is currently dirty before its first turn.
		const info = await gitInfoAsync(cwd, { skipDirty: true });
		const lines: string[] = [];
		lines.push("");
		lines.push(`<fleet>`);
		lines.push(`  run_id: ${RUN_ID}`);
		lines.push(`  agent_id: ${AGENT_ID}`);
		lines.push(`  worktree: ${cwd}`);
		if (info.branch) lines.push(`  branch: ${info.branch}`);
		if (info.head) lines.push(`  head: ${info.head}`);
		if (BANNED_PHRASES.length) {
			lines.push(`  banned_phrases: ${JSON.stringify(BANNED_PHRASES)}`);
		}
		lines.push(`</fleet>`);
		lines.push("");
		lines.push("You are a dispatched fleet agent. Stay within scope. If your dispatch");
		lines.push("brief requires a workaround (missing primitive, per-iteration wrap of what");
		lines.push("should be one cfg axis, reaching into private namespaces) STOP and report");
		lines.push("via /halt rather than shipping the workaround. Commit when done.");
		return { systemPrompt: event.systemPrompt + "\n" + lines.join("\n") };
	});

	// 2. Banned-phrase scanner on streaming text. Tracks consecutive
	// auto-steers; after MAX_STEER_REPEATS hits without remediation, aborts
	// the agent rather than steering forever in a loop.
	let bannedSteerCount = 0;
	const MAX_STEER_REPEATS = 3;
	pi.on("message_update", async (event, _ctx) => {
		if (!BANNED_PHRASES.length) return;
		const ame = event.assistantMessageEvent;
		if (!ame || ame.type !== "text_delta") return;
		const delta = ame.delta ?? "";
		if (!delta) return;
		textWindow = (textWindow + delta).slice(-TEXT_WINDOW_MAX);
		const lower = textWindow.toLowerCase();
		const now = Date.now();
		// Debounce: don't fire more than once per 10s
		if (now - lastBannedHit < 10_000) return;
		for (const phrase of BANNED_PHRASES) {
			if (lower.includes(phrase.toLowerCase())) {
				lastBannedHit = now;
				bannedSteerCount += 1;
				logSupervisor(`banned-phrase hit (#${bannedSteerCount}): ${phrase}`);
				textWindow = ""; // reset so we don't refire on same text

				if (bannedSteerCount > MAX_STEER_REPEATS) {
					// Persistent offender. Stop steering, surface the failure.
					logSupervisor(`MAX_STEER_REPEATS exceeded — not steering further`);
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

	// 3. Tool-call guardrails — ONLY active when running inside a fleet,
	// so plain `pi` interactive sessions aren't affected. Users who want
	// these guardrails in non-fleet contexts can write their own extension
	// or set PI_FLEET_RUN_ID=local manually.
	pi.on("tool_call", async (event, _ctx) => {
		if (!IN_FLEET) return;
		if (!isToolCallEventType("bash", event)) return;
		const command: string = event.input.command ?? "";
		for (const rule of BANNED_BASH_PATTERNS) {
			if (rule.re.test(command)) {
				logSupervisor(`blocked bash: ${rule.reason}  cmd=${command.slice(0, 200)}`);
				return { block: true, reason: rule.reason };
			}
		}
		// Block edits to main tree (any path NOT under cwd or /tmp)
		if (/\b(rm|mv|cp)\s+.*\/mnt\/c\/Users\/thund\/development\/llama\.cpp(?!\/.claude\/worktrees)/.test(command)) {
			return { block: true, reason: "no edits to main tree from dispatched agent (per AGENTS.md worktree discipline)" };
		}
	});

	// Track last commit after every turn for the dashboard.
	// Hot path: SKIP git status; we only need branch+head to update the
	// diagnostic file. The full dirty state is computed when the user invokes
	// /done or /halt (where the latency is paid intentionally).
	pi.on("turn_end", async (_event, _ctx) => {
		if (!IN_FLEET) return;
		const cwd = process.cwd();
		const info = await gitInfoAsync(cwd, { skipDirty: true });
		if (info.head) {
			try {
				const stateFile = join(AGENT_DIR, "fleet-citizen-state.json");
				writeFileSync(
					stateFile,
					JSON.stringify({ branch: info.branch, head: info.head, t: Date.now() }, null, 2),
				);
			} catch (e) {
				logSupervisor(`failed to write fleet-citizen-state.json: ${String(e)}`);
			}
		}
	});

	// 4. /done — commit + audit ritual.  User invoked this explicitly, so the
	// extra latency for the FULL git status check is intentional and visible.
	pi.registerCommand("done", {
		description: "Finalize this agent: stage + commit + audit + report",
		handler: async (args: string, ctx: ExtensionContext) => {
			const cwd = process.cwd();
			const info = await gitInfoAsync(cwd, { skipDirty: false });
			const messageHeader = args.trim() || `[fleet ${AGENT_ID}] dispatch complete`;
			const lines: string[] = [];
			lines.push(`branch:    ${info.branch ?? "?"}`);
			lines.push(`head:      ${info.head ?? "?"}`);
			lines.push(`dirty:     ${info.dirty ? "YES" : "no"}`);
			try {
				const diffstat = execSync("git diff --stat HEAD", { cwd, encoding: "utf8" });
				if (diffstat.trim()) {
					lines.push("");
					lines.push("staged + unstaged changes:");
					lines.push(diffstat.trim());
				}
			} catch {
				/* ignore */
			}
			ctx.ui.notify(`/done — ${messageHeader}`, "info");
			ctx.ui.setStatus("fleet-done", `done @ ${info.head ?? "?"}`);
			if (AGENT_DIR) {
				try {
					writeFileSync(join(AGENT_DIR, "done-summary.txt"), lines.join("\n") + "\n");
				} catch {
					/* ignore */
				}
			}
			// Surface the summary to the assistant context for the final turn
			pi.sendMessage(
				{
					customType: "fleet-done-summary",
					content: lines.join("\n"),
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	// 5. /halt — emit the AGENTS.md HALT template
	pi.registerCommand("halt", {
		description: "Emit the AGENTS.md HALT-on-workaround pattern (no commit)",
		handler: async (args: string, ctx: ExtensionContext) => {
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
					customType: "fleet-halt",
					content: body,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	// 6. Status command — show fleet identity + git state + token usage
	pi.registerCommand("fleet", {
		description: "Show this agent's fleet identity",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const cwd = process.cwd();
			const info = await gitInfoAsync(cwd, { skipDirty: false });
			const out = [
				`run_id   ${RUN_ID || "(not in a fleet)"}`,
				`agent    ${AGENT_ID || "-"}`,
				`worktree ${cwd}`,
				`branch   ${info.branch ?? "?"}`,
				`head     ${info.head ?? "?"}`,
				`dirty    ${info.dirty ? "YES" : "no"}`,
				`banned   ${BANNED_PHRASES.length} phrases`,
			].join("\n");
			ctx.ui.notify(out, "info");
		},
	});

	// 7. Final report dump on shutdown.  Use SYNC variant here because the
	// event loop may be unwinding and we want to actually write the file before
	// the process exits.
	pi.on("session_shutdown", async (event, _ctx) => {
		if (!IN_FLEET) return;
		logSupervisor(`session_shutdown reason=${event.reason}`);
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
