/**
 * subagents — pi extension that ports OpenAI Codex's `multi_agents` tool
 * family + `agent-graph-store` topology to pi as a model-driven orchestrator.
 *
 * The parent pi session dispatches sub-agents *as part of its own reasoning*
 * by calling tools (codex's design), instead of being driven externally by a
 * Python supervisor reading a static manifest (the legacy `pi-fleet` design).
 *
 * Naming follows industry standards (Anthropic Claude Code "Subagents";
 * codex `/subagents` slash command). The orchestrator's on-disk state dir
 * is still rooted at `~/.pi/fleet/runs/` so the legacy `pi-fleet status`
 * Python CLI keeps working against runs created by this extension.
 *
 * Because pi doesn't expose in-process agent threads (codex does — they
 * share one Rust process), the port implements sub-agents as child `pi
 * -p --mode json` subprocesses. This sidesteps the upstream `--mode rpc`
 * stream-handling bug and gives the same isolation pi-fleet has, while
 * exposing codex's well-typed tool API to the parent agent.
 *
 * Primitives composed (from pi's extension API):
 *   - pi.registerTool({ name: "subagent_spawn",  … })   — dispatch a sub-agent
 *   - pi.registerTool({ name: "subagent_wait",   … })   — block on sub-agents
 *   - pi.registerTool({ name: "subagent_list",   … })   — introspect topology
 *   - pi.registerTool({ name: "subagent_close",  … })   — graceful close (SIGTERM)
 *   - pi.registerCommand("subagents", …)                — human-facing CLI:
 *       /subagents, /subagents ls, /subagents abort [id|all], /subagents fire <manifest>
 *   - node:child_process.spawn — child pi lifecycle
 *   - ctx.ui.setStatus("subagents", …) — footer visibility
 *
 * Codex mapping (codex-rs/core/src/tools/handlers/multi_agents/*):
 *   spawn        → subagent_spawn
 *   wait         → subagent_wait
 *   close_agent  → subagent_close
 *   send_input   → DEFERRED (requires live IPC; reinstate when pi --mode rpc lands fix)
 *   resume_agent → DEFERRED (subprocess model: re-spawn from saved instruction instead)
 *
 * State layout (back-compat with the legacy `pi-fleet status` Python CLI):
 *   ~/.pi/fleet/runs/<run-id>/
 *     run.json              # { runId, createdAt, parentSessionId, source: "fleet-mode" }
 *     agents/<agentId>/
 *       agent.json          # frozen spawn options
 *       instruction.md      # the brief, frozen
 *       pi.pid              # child process pid
 *       events.jsonl        # raw JSONL stream from child stdout
 *       stderr.log          # child stderr
 *       state.json          # live status snapshot (read by /fleet)
 *       result.md           # final assistant text once child exits
 *
 * The fleet-citizen extension (sibling file in this repo) is still loaded by
 * each child for guardrails + /done + /halt + banned-phrase scanning.
 *
 * Author: pi self-replication exercise — codex-rs/core/src/tools/handlers/multi_agents/
 * License: MIT
 */

import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const execAsync = promisify(execCb);

// ─── Types ──────────────────────────────────────────────────────────────────

type AgentStatus =
	| "queued"
	| "starting"
	| "streaming"
	| "done"
	| "aborted"
	| "error";

/** Codex's `multi_agents/spawn` arg shape, adapted for pi subprocesses. */
interface SpawnArgs {
	instruction: string;
	/** Optional human-readable label. If omitted, auto-assigned as agent-N. */
	id?: string;
	/** Working directory for the child. If `worktree_root` is set, a git worktree is auto-created. */
	cwd?: string;
	/** Auto-create a git worktree at `<root>/<runId>-<id>` and run the child there. */
	worktree_root?: string;
	/** Parent SHA / branch to base the worktree on. Defaults to HEAD. */
	parent_ref?: string;
	/** Model to use (overrides parent's default). */
	model?: string;
	/** Thinking level. */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Provider override. */
	provider?: string;
	/**
	 * Codex agent-role name (see guardian.ts). When set, the child's
	 * `guardian` extension loads `~/.pi/agent/roles/<role>.json` and layers
	 * its `developer_instructions` into the child's system prompt.
	 * codex source: codex-rs/core/src/agent/role.rs (apply_role_to_config)
	 */
	role?: string;
	/** Extra raw pi CLI args. Use sparingly. */
	extra_args?: string[];
}

/** Persistent record per agent (mirrored to agent.json + state.json on disk). */
interface AgentRecord {
	id: string;
	runId: string;
	status: AgentStatus;
	instruction: string;
	cwd: string;
	worktree?: string;
	model?: string;
	thinking?: string;
	provider?: string;
	role?: string;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	resultText?: string;
	errorMessage?: string;
	stopReason?: string;
	extraArgs: string[];
}

/** In-memory handle for a live child + its accumulated state. */
interface LiveAgent {
	record: AgentRecord;
	child?: ChildProcess;
	/** Resolved when the child's agent_end event has been parsed (or it died). */
	completion: Promise<AgentRecord>;
	/** Set by the completion-watcher when it resolves. */
	complete: (rec: AgentRecord) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const FLEET_HOME =
	process.env.PI_FLEET_HOME ?? join(homedir(), ".pi", "fleet");
const RUNS_DIR = join(FLEET_HOME, "runs");
const DEFAULT_MAX_CONCURRENCY = 16; // codex DEFAULT_AGENT_JOB_CONCURRENCY
const MAX_MAX_CONCURRENCY = 64; // codex MAX_AGENT_JOB_CONCURRENCY
const STATUS_KEY = "subagents";
/** Marker stamped on every events.jsonl line so legacy pi-fleet replay still works. */
const EVENT_TIMESTAMP_FIELD = "_pi_fleet_t";

// ─── Time / id helpers ──────────────────────────────────────────────────────

function nowMs(): number {
	return Date.now();
}

function pad(n: number, w: number): string {
	const s = String(n);
	return s.length >= w ? s : "0".repeat(w - s.length) + s;
}

/** YYYYMMDD-HHMMSS — matches legacy pi-fleet run-id format. */
function makeRunId(name: string): string {
	const d = new Date();
	const stamp =
		`${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}` +
		`-${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`;
	const slug = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug ? `${stamp}-${slug}` : stamp;
}

// ─── Filesystem layout ──────────────────────────────────────────────────────

function runDir(runId: string): string {
	return join(RUNS_DIR, runId);
}

function agentDir(runId: string, agentId: string): string {
	return join(runDir(runId), "agents", agentId);
}

function ensureDir(p: string): void {
	if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function safeWriteJson(path: string, data: unknown): void {
	try {
		ensureDir(dirname(path));
		writeFileSync(path, JSON.stringify(data, null, 2));
	} catch {
		/* ignore — best-effort persistence */
	}
}

function safeAppendLine(path: string, line: string): void {
	try {
		ensureDir(dirname(path));
		appendFileSync(path, line.endsWith("\n") ? line : line + "\n");
	} catch {
		/* ignore */
	}
}

function safeReadJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

// ─── Worktree helpers ───────────────────────────────────────────────────────

/**
 * Ensure a git worktree exists at <root>/<runId>-<agentId> based on parentRef
 * (default: HEAD). Returns absolute worktree path. Safe to call when the
 * worktree already exists.
 */
async function ensureWorktree(
	root: string,
	runId: string,
	agentId: string,
	parentRef: string | undefined,
	repoRoot: string,
): Promise<string> {
	const absRoot = isAbsolute(root) ? root : resolve(repoRoot, root);
	const wtPath = join(absRoot, `${runId}-${agentId}`);
	if (existsSync(wtPath)) return wtPath;
	const branch = `fleet-mode/${runId}/${agentId}`;
	const ref = parentRef ?? "HEAD";
	ensureDir(absRoot);
	await execAsync(`git worktree add -b ${shellQuote(branch)} ${shellQuote(wtPath)} ${shellQuote(ref)}`, {
		cwd: repoRoot,
	});
	return wtPath;
}

function shellQuote(s: string): string {
	if (/^[\w./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function findRepoRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
		return stdout.trim();
	} catch {
		return cwd;
	}
}

// ─── Concurrency cap ────────────────────────────────────────────────────────

/** Simple promise-based semaphore. Codex uses futures::FuturesUnordered with a Semaphore. */
class Semaphore {
	private waiters: Array<() => void> = [];
	private available: number;
	constructor(initial: number) {
		this.available = initial;
	}
	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}
	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.available += 1;
	}
	resize(newMax: number): void {
		this.available = Math.max(0, newMax - (this.waiters.length === 0 ? newMax - this.available : 0));
	}
}

// ─── Tool schemas (codex-faithful) ─────────────────────────────────────────

const SpawnParams = Type.Object({
	instruction: Type.String({
		description:
			"The brief / task for the sub-agent. This becomes the sub-agent's user prompt.",
	}),
	id: Type.Optional(
		Type.String({
			description:
				"Optional human-readable agent id (e.g. 'P73'). Auto-assigned as agent-N if omitted.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. Defaults to the parent's cwd unless worktree_root is set.",
		}),
	),
	worktree_root: Type.Optional(
		Type.String({
			description:
				"If set, creates a git worktree at <worktree_root>/<runId>-<id> and runs the sub-agent there.",
		}),
	),
	parent_ref: Type.Optional(
		Type.String({
			description: "Git ref to base the worktree on. Defaults to HEAD.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Override parent's model." })),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "Override parent's thinking level.",
		}),
	),
	provider: Type.Optional(Type.String({ description: "Override parent's provider." })),
	role: Type.Optional(
		Type.String({
			description:
				"Agent-role name (codex port). Loads ~/.pi/agent/roles/<name>.json and layers its developer_instructions into the child's system prompt. Codex source: core/src/agent/role.rs.",
		}),
	),
	extra_args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Extra raw pi CLI args appended to the child invocation. Use sparingly.",
		}),
	),
});

const WaitParams = Type.Object({
	agent_ids: Type.Array(Type.String(), {
		description: "Agent ids to wait for. Pass an empty array or omit to wait for all live agents.",
	}),
	timeout_ms: Type.Optional(
		Type.Number({
			description: "Max time to block (default: no timeout). On timeout, partial results are returned.",
		}),
	),
});

const CloseParams = Type.Object({
	agent_ids: Type.Array(Type.String(), {
		description: "Agent ids to close. Pass ['all'] to close every live agent.",
	}),
});

const ListParams = Type.Object({
	status_filter: Type.Optional(
		StringEnum(["queued", "starting", "streaming", "done", "aborted", "error"] as const),
	),
});

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// One fleet run-id per pi session. Created lazily on first spawn so sessions
	// that never use the tools don't litter ~/.pi/fleet/runs/.
	let runId: string | undefined;
	let parentSessionId: string | undefined;
	let nextAutoId = 1;

	const live = new Map<string, LiveAgent>();
	const semaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);
	let currentCap = DEFAULT_MAX_CONCURRENCY;

	// ─── Footer ────────────────────────────────────────────────────────────

	const refreshFooter = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (live.size === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const counts: Record<string, number> = {};
		for (const a of live.values()) counts[a.record.status] = (counts[a.record.status] ?? 0) + 1;
		const parts: string[] = [];
		const order: AgentStatus[] = ["streaming", "starting", "queued", "done", "aborted", "error"];
		for (const s of order) if (counts[s]) parts.push(`${counts[s]}${s[0]}`);
		ctx.ui.setStatus(STATUS_KEY, `👥 ${parts.join(" ")}`);
	};

	// ─── Run + agent bootstrapping ─────────────────────────────────────────

	const ensureRun = (ctx: ExtensionContext): string => {
		if (runId) return runId;
		const sessionName = ctx.sessionManager.getSessionName() ?? "session";
		runId = makeRunId(sessionName);
		parentSessionId = ctx.sessionManager.getSessionId();
		const rd = runDir(runId);
		ensureDir(rd);
		safeWriteJson(join(rd, "run.json"), {
			runId,
			createdAt: nowMs(),
			parentSessionId,
			source: "fleet-mode",
			version: 1,
		});
		return runId;
	};

	const persistAgent = (rec: AgentRecord): void => {
		const ad = agentDir(rec.runId, rec.id);
		safeWriteJson(join(ad, "agent.json"), rec);
		safeWriteJson(join(ad, "state.json"), {
			status: rec.status,
			pid: rec.pid,
			startedAt: rec.startedAt,
			endedAt: rec.endedAt,
			model: rec.model,
			thinking: rec.thinking,
			stopReason: rec.stopReason,
			errorMessage: rec.errorMessage,
		});
		if (rec.pid !== undefined) {
			try {
				writeFileSync(join(ad, "pi.pid"), `${rec.pid}\n`);
			} catch {
				/* ignore */
			}
		}
		if (rec.resultText) {
			try {
				writeFileSync(join(ad, "result.md"), rec.resultText);
			} catch {
				/* ignore */
			}
		}
	};

	// ─── Spawn one child pi subprocess ─────────────────────────────────────

	const spawnAgent = async (
		ctx: ExtensionContext,
		args: SpawnArgs,
	): Promise<AgentRecord> => {
		const rid = ensureRun(ctx);
		const id = args.id?.trim() || `agent-${nextAutoId++}`;
		if (live.has(id)) {
			throw new Error(`agent id "${id}" already in use in this run`);
		}

		// Resolve cwd / worktree.
		let cwd = args.cwd ?? ctx.cwd;
		let worktree: string | undefined;
		if (args.worktree_root) {
			const repoRoot = await findRepoRoot(ctx.cwd);
			worktree = await ensureWorktree(args.worktree_root, rid, id, args.parent_ref, repoRoot);
			cwd = worktree;
		}
		if (!isAbsolute(cwd)) cwd = resolve(ctx.cwd, cwd);

		const ad = agentDir(rid, id);
		ensureDir(ad);
		try {
			writeFileSync(join(ad, "instruction.md"), args.instruction);
		} catch {
			/* ignore */
		}

		const record: AgentRecord = {
			id,
			runId: rid,
			status: "queued",
			instruction: args.instruction,
			cwd,
			worktree,
			model: args.model,
			thinking: args.thinking,
			provider: args.provider,
			role: args.role,
			startedAt: nowMs(),
			extraArgs: args.extra_args ?? [],
		};
		persistAgent(record);

		let completeFn!: (rec: AgentRecord) => void;
		const completion = new Promise<AgentRecord>((resolveCompletion) => {
			completeFn = resolveCompletion;
		});

		const liveAgent: LiveAgent = {
			record,
			completion,
			complete: completeFn,
		};
		live.set(id, liveAgent);
		refreshFooter(ctx);

		// Capacity-respecting dispatch: queue under the semaphore, then run.
		(async () => {
			await semaphore.acquire();
			try {
				record.status = "starting";
				persistAgent(record);
				refreshFooter(ctx);

				const argv = buildChildArgv(record);
				const child = spawnProc("pi", argv, {
					cwd: record.cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						PI_NO_SPOOF: process.env.PI_NO_SPOOF ?? "0",
						// guardian.ts (new codex-shaped name) picks these up
						PI_GUARDIAN_RUN_ID: rid,
						PI_GUARDIAN_AGENT_ID: id,
						PI_GUARDIAN_RUN_DIR: runDir(rid),
						PI_GUARDIAN_AGENT_DIR: ad,
						...(record.role ? { PI_GUARDIAN_ROLE: record.role } : {}),
						// legacy PI_FLEET_* aliases for back-compat with pi-fleet's
						// Python supervisor + the fleet-citizen.ts stub.
						PI_FLEET_RUN_ID: rid,
						PI_FLEET_AGENT_ID: id,
						PI_FLEET_STATE_DIR: runDir(rid),
						PI_FLEET_AGENT_DIR: ad,
					},
				});
				record.pid = child.pid;
				record.status = "streaming";
				liveAgent.child = child;
				persistAgent(record);
				refreshFooter(ctx);

				const eventsPath = join(ad, "events.jsonl");
				const stderrPath = join(ad, "stderr.log");
				attachStdoutWatcher(child, eventsPath, record);
				attachStderrWatcher(child, stderrPath);

				const exitCode: number | null = await new Promise((res) => {
					child.once("exit", (code) => res(code));
					child.once("error", () => res(null));
				});

				// If we didn't already learn the result from events, fall back to exit code.
				if (record.status === "streaming") {
					if (exitCode === 0) {
						record.status = "done";
					} else {
						record.status = "error";
						record.errorMessage =
							record.errorMessage ?? `child exited with code ${exitCode ?? "?"}`;
					}
				}
				record.endedAt = nowMs();
				persistAgent(record);
				refreshFooter(ctx);
			} catch (err) {
				record.status = "error";
				record.errorMessage = err instanceof Error ? err.message : String(err);
				record.endedAt = nowMs();
				persistAgent(record);
				refreshFooter(ctx);
			} finally {
				semaphore.release();
				completeFn(record);
			}
		})();

		return record;
	};

	// ─── Reading the child's JSONL event stream ────────────────────────────

	/**
	 * Maximum buffered bytes between newlines from a child's stdout. If a child
	 * produces a single line longer than this (e.g. broken JSON, binary output,
	 * runaway log), we flush the buffer as one malformed-line entry to disk and
	 * reset, preventing unbounded memory growth.
	 *
	 * 1 MB is generously larger than any pi event we expect (~tens of KB for
	 * agent_end with full message list) but small enough that a misbehaving
	 * child can't OOM the parent.
	 */
	const STDOUT_LINE_BUFFER_CAP = 1024 * 1024;

	function attachStdoutWatcher(
		child: ChildProcess,
		eventsPath: string,
		record: AgentRecord,
	): void {
		ensureDir(dirname(eventsPath));
		let buffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				// Stamp + persist verbatim for legacy pi-fleet replay compatibility.
				let stamped = line;
				try {
					const obj = JSON.parse(line);
					obj[EVENT_TIMESTAMP_FIELD] = Date.now() / 1000;
					stamped = JSON.stringify(obj);
					handleChildEvent(obj, record);
				} catch {
					/* malformed JSON — store raw line, ignore */
				}
				safeAppendLine(eventsPath, stamped);
			}
			// DoS guard: if the buffer has grown past the cap with no newline,
			// flush it as one synthetic line and reset. Prevents a misbehaving
			// child (e.g. piping a binary or dropping newlines) from OOMing us.
			if (buffer.length > STDOUT_LINE_BUFFER_CAP) {
				safeAppendLine(
					eventsPath,
					JSON.stringify({
						type: "_pi_fleet_stdout_overflow",
						bytes: buffer.length,
						preview: buffer.slice(0, 200),
						[EVENT_TIMESTAMP_FIELD]: Date.now() / 1000,
					}),
				);
				buffer = "";
			}
		});
	}

	function attachStderrWatcher(child: ChildProcess, stderrPath: string): void {
		ensureDir(dirname(stderrPath));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			safeAppendLine(stderrPath, chunk.replace(/\n$/, ""));
		});
	}

	/**
	 * Inspect a single child event. We care about agent_end (terminal),
	 * which carries the full message list — last assistant message is the result.
	 */
	function handleChildEvent(ev: { type?: string; messages?: unknown[] }, rec: AgentRecord): void {
		if (ev.type !== "agent_end" || !Array.isArray(ev.messages)) return;
		const messages = ev.messages as Array<{
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			content?: Array<{ type?: string; text?: string }>;
		}>;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) {
			rec.status = "error";
			rec.errorMessage = "child produced no assistant message";
			return;
		}
		rec.stopReason = lastAssistant.stopReason;
		const text = (lastAssistant.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
		rec.resultText = text;
		if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
			rec.status = lastAssistant.stopReason === "aborted" ? "aborted" : "error";
			rec.errorMessage = lastAssistant.errorMessage;
		} else {
			rec.status = "done";
		}
	}

	function buildChildArgv(rec: AgentRecord): string[] {
		const argv: string[] = ["-p", "--mode", "json", "--no-session", "--no-context-files"];
		if (rec.model) argv.push("--model", rec.model);
		if (rec.thinking) argv.push("--thinking", rec.thinking);
		if (rec.provider) argv.push("--provider", rec.provider);
		argv.push(...rec.extraArgs);
		// pi takes the prompt as a trailing positional arg; no `--` separator needed.
		argv.push(rec.instruction);
		return argv;
	}

	// ─── Tool: agent_spawn ─────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_spawn",
		label: "spawn sub-agent",
		description:
			"Spawn a sub-agent pi process to work on a parallel task. Returns immediately with the sub-agent id and current status. Use subagent_wait to block until it finishes. Optionally creates a git worktree per sub-agent.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const rec = await spawnAgent(ctx, params as SpawnArgs);
				return {
					content: [
						{
							type: "text",
							text:
								`Spawned subagent ${rec.id} (status: ${rec.status})\n` +
								`  cwd:     ${rec.cwd}\n` +
								(rec.worktree ? `  worktree: ${rec.worktree}\n` : "") +
								`  events:  ${join(agentDir(rec.runId, rec.id), "events.jsonl")}`,
						},
					],
					details: {
						agent_id: rec.id,
						run_id: rec.runId,
						status: rec.status,
						cwd: rec.cwd,
						worktree: rec.worktree,
					},
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `subagent_spawn failed: ${err instanceof Error ? err.message : err}` },
					],
					details: { error: String(err) },
					isError: true,
				};
			}
		},
	});

	// ─── Tool: agent_wait ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_wait",
		label: "wait for sub-agents",
		description:
			"Block until the named sub-agents reach a terminal status (done/aborted/error). Pass an empty array or omit agent_ids to wait for all live sub-agents. Returns a summary of each: status, stop reason, and result text.",
		parameters: WaitParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const args = params as { agent_ids?: string[]; timeout_ms?: number };
			const targets = (args.agent_ids && args.agent_ids.length > 0
				? args.agent_ids
				: Array.from(live.keys())
			).map((id) => live.get(id)).filter((v): v is LiveAgent => v !== undefined);

			if (targets.length === 0) {
				return {
					content: [{ type: "text", text: "No live sub-agents to wait for." }],
					details: { agents: [] },
				};
			}

			const abortPromise = new Promise<"abort">((resolve) => {
				if (signal.aborted) resolve("abort");
				else signal.addEventListener("abort", () => resolve("abort"), { once: true });
			});
			const timeoutPromise = args.timeout_ms
				? new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), args.timeout_ms))
				: new Promise<never>(() => {});

			const completions = Promise.all(targets.map((a) => a.completion));
			const winner = await Promise.race([
				completions.then(() => "done" as const),
				abortPromise,
				timeoutPromise,
			]);

			const records = targets.map((a) => a.record);
			const lines = [
				`subagent_wait → ${winner}`,
				"",
				...records.map((r) =>
					`  ${r.id.padEnd(12)} ${r.status.padEnd(10)} ${r.stopReason ?? ""}${
						r.errorMessage ? `  err: ${r.errorMessage.slice(0, 80)}` : ""
					}`,
				),
				"",
				...records
					.filter((r) => r.resultText)
					.flatMap((r) => [
						`── ${r.id} result ──`,
						r.resultText ?? "",
						"",
					]),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					reason: winner,
					agents: records.map((r) => ({
						id: r.id,
						status: r.status,
						stopReason: r.stopReason,
						errorMessage: r.errorMessage,
						resultText: r.resultText,
					})),
				},
			};
		},
	});

	// ─── Tool: agent_list ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_list",
		label: "list sub-agents",
		description:
			"List all sub-agents in the current run with status, model, and cwd. Optionally filter by status.",
		parameters: ListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filter = (params as { status_filter?: AgentStatus }).status_filter;
			const all = Array.from(live.values()).map((a) => a.record);
			const filtered = filter ? all.filter((r) => r.status === filter) : all;
			const lines =
				filtered.length === 0
					? ["No sub-agents."]
					: filtered.map(
							(r) =>
								`  ${r.id.padEnd(12)} ${r.status.padEnd(10)} ` +
								`${(r.model ?? "(default)").padEnd(24)} ${r.cwd}`,
					);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { run_id: runId, agents: filtered },
			};
		},
	});

	// ─── Tool: agent_close ─────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_close",
		label: "close sub-agents",
		description:
			"Gracefully close (SIGTERM) the named sub-agents. Pass ['all'] to close every live sub-agent. Returns the post-close status of each target.",
		parameters: CloseParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = params as { agent_ids: string[] };
			const ids =
				args.agent_ids.length === 1 && args.agent_ids[0] === "all"
					? Array.from(live.keys())
					: args.agent_ids;
			const results: Array<{ id: string; status: AgentStatus; signalled: boolean }> = [];
			for (const id of ids) {
				const la = live.get(id);
				if (!la) {
					results.push({ id, status: "error", signalled: false });
					continue;
				}
				if (la.child && la.record.status !== "done" && la.record.status !== "error") {
					try {
						la.child.kill("SIGTERM");
						la.record.status = "aborted";
					} catch {
						/* ignore */
					}
				}
				persistAgent(la.record);
				results.push({ id, status: la.record.status, signalled: true });
			}
			refreshFooter(ctx);
			return {
				content: [
					{
						type: "text",
						text: results.map((r) => `  ${r.id.padEnd(12)} ${r.status}${r.signalled ? "" : "  (unknown)"}`).join("\n"),
					},
				],
				details: { results },
			};
		},
	});

	// ─── Slash command: /fleet ─────────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "Manage parallel sub-agents (codex /subagents port). /subagents, /subagents ls, /subagents abort [id|all], /subagents fire <manifest.json>",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();
			if (!args || args === "ls" || args === "status") {
				const lines: string[] = [];
				if (runId) {
					lines.push(`run: ${runId}`);
					lines.push(`dir: ${runDir(runId)}`);
					lines.push("");
				}
				if (live.size === 0) {
					lines.push("No active sub-agents in this session.");
					lines.push("");
					lines.push("Set the model loose: ask it to call subagent_spawn for parallel work,");
					lines.push("or load a manifest with: /subagents fire <path-to-manifest.json>");
				} else {
					lines.push("sub-agents:");
					for (const a of live.values()) {
						const r = a.record;
						lines.push(
							`  ${r.id.padEnd(14)} ${r.status.padEnd(10)} ${(r.model ?? "(default)").padEnd(22)} ${r.cwd}`,
						);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [sub, ...rest] = args.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (sub === "abort" || sub === "kill") {
				const target = tail || "all";
				const ids =
					target === "all"
						? Array.from(live.keys())
						: [target].flatMap((s) => {
								if (live.has(s)) return [s];
								// Prefix match — pi-fleet behavior
								const matches = Array.from(live.keys()).filter((k) => k.startsWith(s));
								return matches;
							});
				if (ids.length === 0) {
					ctx.ui.notify(`No matching sub-agent for "${target}"`, "warning");
					return;
				}
				let closed = 0;
				for (const id of ids) {
					const la = live.get(id);
					if (!la?.child) continue;
					try {
						la.child.kill("SIGTERM");
						la.record.status = "aborted";
						persistAgent(la.record);
						closed++;
					} catch {
						/* ignore */
					}
				}
				refreshFooter(ctx);
				ctx.ui.notify(`Aborted ${closed} sub-agent(s): ${ids.join(", ")}`, "info");
				return;
			}

			if (sub === "fire") {
				if (!tail) {
					ctx.ui.notify("Usage: /subagents fire <path-to-manifest.json>", "warning");
					return;
				}
				const manifestPath = isAbsolute(tail) ? tail : resolve(ctx.cwd, tail);
				try {
					const n = await fireManifest(ctx, manifestPath);
					ctx.ui.notify(`Fired ${n} sub-agent(s) from ${manifestPath}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`Manifest fire failed: ${err instanceof Error ? err.message : err}`,
						"error",
					);
				}
				return;
			}

			if (sub === "cap" || sub === "concurrency") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 1 || n > MAX_MAX_CONCURRENCY) {
					ctx.ui.notify(
						`Invalid concurrency cap. Use an integer in [1, ${MAX_MAX_CONCURRENCY}].`,
						"warning",
					);
					return;
				}
				currentCap = n;
				semaphore.resize(n);
				ctx.ui.notify(`Concurrency cap set to ${n}.`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: ${sub}\n\nUsage:\n  /subagents               show status\n  /subagents ls            list sub-agents\n  /subagents abort [id|all]\n  /subagents fire <manifest.json>\n  /subagents cap <N>       set concurrency`,
				"warning",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ value: "ls", description: "list sub-agents" },
				{ value: "abort", description: "SIGTERM sub-agent(s)" },
				{ value: "fire", description: "dispatch from a manifest.json" },
				{ value: "cap", description: "set concurrency cap" },
			];
			if (prefix.includes(" ")) return null;
			const p = prefix.trim().toLowerCase();
			return subs.filter((s) => s.value.startsWith(p));
		},
	});

	// ─── Manifest backward-compat ──────────────────────────────────────────

	/**
	 * Read a legacy pi-fleet manifest.json and dispatch each agent via spawnAgent.
	 * Schema (subset, the fields we honor):
	 *   {
	 *     "name": "...",
	 *     "parent_sha": "...",
	 *     "concurrency": N,
	 *     "common": {
	 *       "preamble": "path",
	 *       "worktree_root": "rel-to-repo-root",
	 *       "auto_compact_threshold": 0.85
	 *     },
	 *     "agents": [{ "id", "model", "thinking", "provider", "brief": "path", "extra_args": [] }]
	 *   }
	 */
	async function fireManifest(ctx: ExtensionContext, manifestPath: string): Promise<number> {
		if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
		const manifest = safeReadJson<{
			name?: string;
			parent_sha?: string;
			concurrency?: number;
			common?: { preamble?: string; worktree_root?: string };
			agents: Array<{
				id?: string;
				model?: string;
				thinking?: string;
				provider?: string;
				brief: string;
				worktree?: string;
				extra_args?: string[];
			}>;
		}>(manifestPath);
		if (!manifest) throw new Error(`failed to parse manifest: ${manifestPath}`);
		if (!Array.isArray(manifest.agents)) throw new Error("manifest missing 'agents' array");

		const manifestDir = dirname(manifestPath);
		const preamble = manifest.common?.preamble
			? readFileSync(resolvePath(manifestDir, manifest.common.preamble), "utf8")
			: "";

		if (manifest.concurrency && manifest.concurrency >= 1) {
			currentCap = Math.min(manifest.concurrency, MAX_MAX_CONCURRENCY);
			semaphore.resize(currentCap);
		}

		let n = 0;
		for (const a of manifest.agents) {
			const briefBody = readFileSync(resolvePath(manifestDir, a.brief), "utf8");
			const instruction = preamble ? `${preamble}\n\n---\n\n${briefBody}` : briefBody;
			await spawnAgent(ctx, {
				instruction,
				id: a.id,
				cwd: a.worktree,
				worktree_root: !a.worktree ? manifest.common?.worktree_root : undefined,
				parent_ref: manifest.parent_sha,
				model: a.model,
				thinking: a.thinking as SpawnArgs["thinking"],
				provider: a.provider,
				extra_args: a.extra_args,
			});
			n++;
		}
		return n;
	}

	function resolvePath(base: string, p: string): string {
		return isAbsolute(p) ? p : resolve(base, p);
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Don't auto-resume children from previous sessions — their parent died,
		// and re-attaching to orphaned pi processes is fragile. We DO still see
		// their on-disk state via the legacy `pi-fleet status` CLI.
		refreshFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Best-effort: SIGTERM any still-streaming children so we don't leak them.
		for (const a of live.values()) {
			if (a.child && (a.record.status === "starting" || a.record.status === "streaming")) {
				try {
					a.child.kill("SIGTERM");
					a.record.status = "aborted";
					a.record.endedAt = nowMs();
					persistAgent(a.record);
				} catch {
					/* ignore */
				}
			}
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Stash unused helpers/state-only-vars so TS doesn't flag them.
	void readdirSync;
	void statSync;
	void currentCap;
	void parentSessionId;
}
