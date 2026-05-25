/**
 * background-procs — pi extension that ports codex's `/ps` + `/stop`
 * background-terminal management slash commands.
 *
 * Caveat: codex's `/ps` + `/stop` are backed by its `unified_exec` subsystem
 * that tracks long-running terminals at the agent-core layer (PIDs are
 * always known). Pi's `bash` tool returns when the command finishes; any
 * daemon spawned with `&` / `nohup` / `setsid` outlives the bash call but
 * pi has no built-in registry for it. This port works around that with:
 *
 *   1. A model-callable `bg_register` tool — the model explicitly registers
 *      the PID after it backgrounds a process (the disciplined path).
 *   2. Auto-detection in tool_result — for bash tool calls whose output
 *      matches well-known "started in background" patterns, we extract the
 *      PID and register automatically (the convenient path).
 *
 * Either way the result is a list of pi-tracked PIDs, surfaced via:
 *   /ps               — list tracked processes with live alive-check
 *   /stop [id|all]    — SIGTERM tracked (and de-register on success)
 *   /bg cleanup       — purge already-dead PIDs from the registry
 *
 * codex sources mapped:
 *   tui/src/chatwidget.rs (add_ps_output, clean_background_terminals)
 *   core/src/unified_exec (the registry pi doesn't have)
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── State ──────────────────────────────────────────────────────────────────

interface BgProc {
	id: string;
	pid: number;
	command: string;
	description?: string;
	source: "manual" | "auto-bash-result";
	startedAt: number;
}

const STATUS_KEY = "background-procs";

// ─── PID liveness ──────────────────────────────────────────────────────────

/**
 * Cheap process-alive check: `kill -0 pid` returns true if the process exists
 * and is signalable. On non-POSIX platforms (Windows) we just return true,
 * since this extension primarily targets the same platforms pi runs on
 * (Linux/macOS/WSL).
 */
function isAlive(pid: number): boolean {
	if (process.platform === "win32") return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process; EPERM = exists but we don't own it
		const e = err as NodeJS.ErrnoException;
		return e.code === "EPERM";
	}
}

function sigterm(pid: number): { ok: boolean; error?: string } {
	try {
		process.kill(pid, "SIGTERM");
		return { ok: true };
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ESRCH") return { ok: true }; // already dead
		return { ok: false, error: `${e.code ?? "unknown"}: ${e.message}` };
	}
}

// ─── Auto-detection patterns ───────────────────────────────────────────────

/**
 * Regexes applied to bash tool result text to extract a PID when the command
 * appears to have backgrounded a daemon. Patterns are intentionally narrow
 * to avoid false positives — we'd rather miss an auto-registration than
 * track an unrelated number.
 */
const AUTO_PID_PATTERNS: Array<{ name: string; re: RegExp }> = [
	// bash job-control announcement: "[1] 12345"
	{ name: "job-control", re: /^\[\d+\]\s+(\d+)\s*$/m },
	// nohup-ish "Started ... pid 12345"
	{ name: "started-pid", re: /\b[Ss]tarted[^\n]*\bpid[:= ]+(\d+)\b/ },
	// systemd-run-ish "Started process with pid 12345"
	{ name: "process-pid", re: /\bprocess[^\n]*\bpid[:= ]+(\d+)\b/i },
	// custom convention: the command ends with `& echo $!` and stdout is just a PID
	{ name: "echo-bang", re: /^\s*(\d{2,7})\s*$/ },
];

/**
 * Looks like a bash command intentionally backgrounded (heuristic).
 * Used to gate auto-detection: don't try to parse PIDs out of foreground
 * command output even if there's a stray number that matches.
 */
function commandBackgrounded(command: string): boolean {
	if (!command) return false;
	const c = command.trim();
	return (
		/[^&]&\s*(echo\s+\$!.*)?$/.test(c) || // ends in &
		/\bnohup\b/.test(c) ||
		/\bsetsid\b/.test(c) ||
		/\bdisown\b/.test(c)
	);
}

// ─── Tool schemas ───────────────────────────────────────────────────────────

const BgRegisterParams = Type.Object({
	pid: Type.Number({
		description:
			"The OS process id of the backgrounded process. After `cmd &` you typically have it in $! (write `cmd & echo $!`).",
	}),
	command: Type.String({
		description: "The command line that was backgrounded (for display).",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional one-line note about what the process does.",
		}),
	),
});

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const procs = new Map<string, BgProc>();
	let nextId = 1;

	const allocId = (): string => `bg-${nextId++}`;

	const refreshFooter = (ctx: { hasUI: boolean; ui: { setStatus: (k: string, v?: string) => void } }): void => {
		if (!ctx.hasUI) return;
		const live = [...procs.values()].filter((p) => isAlive(p.pid)).length;
		if (live === 0 && procs.size === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} else {
			ctx.ui.setStatus(
				STATUS_KEY,
				`⚙ ${live} bg proc${live === 1 ? "" : "s"}${
					procs.size > live ? ` (${procs.size - live} dead)` : ""
				}`,
			);
		}
	};

	const register = (
		pid: number,
		command: string,
		source: BgProc["source"],
		description?: string,
	): BgProc => {
		const id = allocId();
		const rec: BgProc = {
			id,
			pid,
			command: command.trim().slice(0, 200),
			description,
			source,
			startedAt: Date.now(),
		};
		procs.set(id, rec);
		return rec;
	};

	// ─── Model tool: bg_register ───────────────────────────────────────────

	pi.registerTool({
		name: "bg_register",
		label: "register bg process",
		description:
			"Register a process you just backgrounded (with `&`, `nohup`, `setsid`, etc.) so the user can see it in /ps and stop it with /stop. Best practice: invoke as `<cmd> & echo $!` from bash, read the PID from output, then call this.",
		parameters: BgRegisterParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { pid: number; command: string; description?: string };
			if (!Number.isFinite(p.pid) || p.pid <= 0) {
				return {
					content: [{ type: "text", text: `Invalid pid: ${p.pid}` }],
					details: { ok: false },
					isError: true,
				};
			}
			if (!isAlive(p.pid)) {
				return {
					content: [
						{
							type: "text",
							text: `pid ${p.pid} is not a live process. Not registering. (Did the backgrounded command already exit?)`,
						},
					],
					details: { ok: false, alive: false },
					isError: true,
				};
			}
			const rec = register(p.pid, p.command, "manual", p.description);
			refreshFooter(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Registered ${rec.id} pid=${rec.pid}: ${rec.command}`,
					},
				],
				details: { ok: true, ...rec },
			};
		},
	});

	// ─── Auto-detect on tool_result (best-effort) ──────────────────────────

	/**
	 * Track the last command we saw on a bash tool_call so we can pair it with
	 * the matching tool_result. Keyed by toolCallId.
	 *
	 * Memory guard: entries have a TTL so a tool_call without a matching
	 * tool_result (mid-tool abort / network drop / runaway agent) doesn't leak
	 * unbounded over a long session. We sweep + cap on every insert.
	 */
	interface PendingBash {
		cmd: string;
		t: number;
	}
	const pendingBashCommands = new Map<string, PendingBash>();
	const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — generous for slow tools
	const PENDING_MAX_SIZE = 1024; // hard cap

	function sweepPending(): void {
		const cutoff = Date.now() - PENDING_TTL_MS;
		for (const [id, rec] of pendingBashCommands) {
			if (rec.t < cutoff) pendingBashCommands.delete(id);
		}
		// Hard cap: drop oldest entries first (Map iteration is insertion order).
		while (pendingBashCommands.size > PENDING_MAX_SIZE) {
			const oldestKey = pendingBashCommands.keys().next().value;
			if (oldestKey === undefined) break;
			pendingBashCommands.delete(oldestKey);
		}
	}

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "bash") return;
		const cmd = (event.input as { command?: string }).command;
		if (typeof cmd === "string") {
			pendingBashCommands.set(event.toolCallId, { cmd, t: Date.now() });
			sweepPending();
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const entry = pendingBashCommands.get(event.toolCallId);
		pendingBashCommands.delete(event.toolCallId);
		const cmd = entry?.cmd;
		if (!cmd || !commandBackgrounded(cmd)) return;

		// Pull text from the result content. The shape is { content: [{type,text}] }.
		const result = event.result as { content?: Array<{ type?: string; text?: string }> };
		const text = (result?.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
		if (!text) return;

		for (const { re } of AUTO_PID_PATTERNS) {
			const m = text.match(re);
			if (!m) continue;
			const pid = Number.parseInt(m[1], 10);
			if (!Number.isFinite(pid) || pid <= 0) continue;
			if (!isAlive(pid)) continue;
			// De-dup: skip if we already track this exact PID
			if ([...procs.values()].some((p) => p.pid === pid)) return;
			register(pid, cmd, "auto-bash-result");
			refreshFooter(ctx);
			return; // first match wins
		}
	});

	// ─── /ps ───────────────────────────────────────────────────────────────

	pi.registerCommand("ps", {
		description:
			"List tracked background processes with live alive-check (codex port of /ps).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (procs.size === 0) {
				ctx.ui.notify(
					"No tracked background processes.\n\n" +
						"Processes are tracked when:\n" +
						"  - The agent calls bg_register({ pid, command }) explicitly, OR\n" +
						"  - A bash invocation with & / nohup / setsid emits a PID we can parse.",
					"info",
				);
				return;
			}
			const rows: string[] = [];
			rows.push(
				`${"id".padEnd(6)} ${"pid".padEnd(8)} ${"state".padEnd(7)} ${"source".padEnd(18)} ${"started".padEnd(8)} command`,
			);
			rows.push("─".repeat(80));
			for (const p of procs.values()) {
				const alive = isAlive(p.pid);
				const state = alive ? "alive" : "dead";
				const age = formatAge(Date.now() - p.startedAt);
				rows.push(
					`${p.id.padEnd(6)} ${String(p.pid).padEnd(8)} ${state.padEnd(7)} ${p.source.padEnd(18)} ${age.padEnd(8)} ${p.command.slice(0, 60)}`,
				);
			}
			rows.push("");
			rows.push("Use /stop <id> to SIGTERM, /stop all to SIGTERM every tracked, /bg cleanup to purge dead.");
			ctx.ui.notify(rows.join("\n"), "info");
			refreshFooter(ctx);
		},
	});

	// ─── /stop ─────────────────────────────────────────────────────────────

	pi.registerCommand("stop", {
		description:
			"SIGTERM a tracked background process by id, or all tracked at once (codex port of /stop). Usage: /stop <id> | /stop all",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const target = rawArgs.trim().toLowerCase();
			if (!target) {
				ctx.ui.notify("Usage: /stop <id> | /stop all", "warning");
				return;
			}
			const targets =
				target === "all"
					? [...procs.values()]
					: [...procs.values()].filter((p) => p.id === target || p.id.startsWith(target));
			if (targets.length === 0) {
				ctx.ui.notify(`No tracked process matches "${target}".`, "warning");
				return;
			}
			const results: string[] = [];
			for (const p of targets) {
				if (!isAlive(p.pid)) {
					procs.delete(p.id);
					results.push(`  ${p.id} pid=${p.pid}  already dead, removed`);
					continue;
				}
				const { ok, error } = sigterm(p.pid);
				if (ok) {
					procs.delete(p.id);
					results.push(`  ${p.id} pid=${p.pid}  SIGTERM sent, removed`);
				} else {
					results.push(`  ${p.id} pid=${p.pid}  FAILED: ${error}`);
				}
			}
			refreshFooter(ctx);
			ctx.ui.notify(results.join("\n"), "info");
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const p = prefix.trim().toLowerCase();
			const ids = [...procs.keys()].filter((id) => id.startsWith(p));
			const opts = ids.map((id) => ({ value: id, description: `pid ${procs.get(id)?.pid}` }));
			if ("all".startsWith(p)) opts.push({ value: "all", description: "SIGTERM every tracked" });
			return opts;
		},
	});

	// ─── /bg — extra utilities (cleanup) ───────────────────────────────────

	pi.registerCommand("bg", {
		description: "Background-process utilities. Usage: /bg cleanup (purge dead from registry).",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const sub = rawArgs.trim().toLowerCase();
			if (sub === "cleanup" || sub === "prune") {
				let removed = 0;
				for (const [id, p] of [...procs.entries()]) {
					if (!isAlive(p.pid)) {
						procs.delete(id);
						removed++;
					}
				}
				refreshFooter(ctx);
				ctx.ui.notify(
					`Purged ${removed} dead process${removed === 1 ? "" : "es"} from the registry. ${procs.size} remain.`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /bg cleanup", "warning");
		},
	});

	// ─── Session-shutdown SIGTERM-all (best-effort) ────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		// Don't auto-kill on shutdown — these are user-controlled. Just clear the
		// footer marker.
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
