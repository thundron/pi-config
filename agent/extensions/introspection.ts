/**
 * introspection — pi extension that ports codex's introspection slash
 * commands (`/hooks`, `/mcp`, `/debug-config`) as a single grab-bag.
 *
 * Currently exposes:
 *   /hooks         — list lifecycle events + per-event fire counts
 *   /tools (/mcp)  — list registered tools grouped by source extension
 *   /debug-config  — dump active config: settings, model, thinking, cwd, sources
 *
 * Port plan tracker: ~/dev/pi-config/PORT-PLAN.md
 *
 * codex source for /hooks:
 *   tui/src/chatwidget/hooks.rs        (add_hooks_output / open_hooks_browser)
 *   tui/src/slash_command.rs           (SlashCommand::Hooks description)
 *
 * Note on the codex→pi port shape: codex's hooks are user-declared SHELL
 * COMMANDS tied to lifecycle events via TOML config (and `/hooks` opens a
 * browser over them). Pi's equivalent is *extensions* — JS modules that
 * subscribe to lifecycle events via `pi.on(...)`. The user-visible value of
 * codex's `/hooks` is "show me what's wired to lifecycle events"; for pi,
 * that means enumerating the lifecycle event taxonomy + live fire counts.
 * The static "which extensions subscribed to which event" is not exposed by
 * pi's public extension API, so we surface activity instead.
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ─── Pi lifecycle event taxonomy ───────────────────────────────────────────

/**
 * Every event pi extensions can subscribe to via `pi.on(event, handler)`.
 * Pulled from `@earendil-works/pi-coding-agent` types.d.ts at v0.75.5.
 *
 * Grouped to match the README structure: resource / session / agent / model /
 * tool / context / message. The descriptions are paraphrased from the type
 * doc-comments so users running `/hooks` see what each event means.
 */
interface HookSpec {
	event: string;
	group: string;
	description: string;
}

const HOOKS: HookSpec[] = [
	// Resource discovery
	{
		event: "resources_discover",
		group: "resource",
		description: "Fired once at startup to discover extensions/skills/prompts/themes.",
	},
	// Session lifecycle
	{
		event: "session_start",
		group: "session",
		description: "Fired when a session starts (fresh or resumed).",
	},
	{
		event: "session_before_switch",
		group: "session",
		description: "Before switching to a different session file. Can cancel.",
	},
	{
		event: "session_before_fork",
		group: "session",
		description: "Before forking. Can cancel.",
	},
	{
		event: "session_before_compact",
		group: "session",
		description: "Before context compaction. Can cancel.",
	},
	{
		event: "session_compact",
		group: "session",
		description: "After compaction completes.",
	},
	{
		event: "session_shutdown",
		group: "session",
		description: "Last chance for cleanup before pi exits / replaces the session.",
	},
	{
		event: "session_before_tree",
		group: "session",
		description: "Before navigating the session tree. Can cancel.",
	},
	{
		event: "session_tree",
		group: "session",
		description: "After tree navigation completes (branch switched).",
	},
	// Provider request / response
	{
		event: "context",
		group: "context",
		description:
			"Before each LLM call. Handler can modify the messages array (used by goal-mode, plan-mode, personality, memories).",
	},
	{
		event: "before_provider_request",
		group: "provider",
		description: "Before sending the request payload. Handler can replace it entirely.",
	},
	{
		event: "after_provider_response",
		group: "provider",
		description: "After response headers arrive, before the stream is consumed.",
	},
	// Agent loop
	{
		event: "before_agent_start",
		group: "agent",
		description: "After user submits prompt, before agent loop starts. Has the prompt + assembled system prompt.",
	},
	{
		event: "agent_start",
		group: "agent",
		description: "Agent loop begins.",
	},
	{
		event: "agent_end",
		group: "agent",
		description: "Agent loop fully settles (all turns + tool calls done). Used by goal-mode to schedule auto-continuation.",
	},
	{
		event: "turn_start",
		group: "agent",
		description: "Each LLM turn begins (multiple per agent loop if tool calls happen).",
	},
	{
		event: "turn_end",
		group: "agent",
		description: "Each LLM turn ends. Carries the final assistant message + tool results.",
	},
	// Message stream
	{
		event: "message_start",
		group: "message",
		description: "Any message (user/assistant/toolResult) begins.",
	},
	{
		event: "message_update",
		group: "message",
		description: "Streamed token-by-token update during assistant message.",
	},
	{
		event: "message_end",
		group: "message",
		description: "Any message completes.",
	},
	// Tool execution
	{
		event: "tool_execution_start",
		group: "tool",
		description: "A tool begins executing.",
	},
	{
		event: "tool_execution_update",
		group: "tool",
		description: "Partial/streaming output from an executing tool.",
	},
	{
		event: "tool_execution_end",
		group: "tool",
		description: "A tool finishes executing.",
	},
	{
		event: "tool_call",
		group: "tool",
		description:
			"Before a tool is dispatched. Handler can block the call with { block: true, reason }.",
	},
	{
		event: "tool_result",
		group: "tool",
		description: "After a tool result is produced. Handler can override result, isError, or terminate.",
	},
	// Model / thinking changes
	{
		event: "model_select",
		group: "model",
		description: "User chose a new model.",
	},
	{
		event: "thinking_level_select",
		group: "model",
		description: "User changed thinking level.",
	},
	// Input
	{
		event: "user_bash",
		group: "input",
		description: "User invoked a !bash escape from the composer. Handler can block.",
	},
	{
		event: "input",
		group: "input",
		description:
			"Any input received (interactive / rpc / extension). Handler can transform or mark handled.",
	},
];

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Per-event fire counts, keyed by event name.
	const counts: Record<string, number> = Object.fromEntries(
		HOOKS.map((h) => [h.event, 0]),
	);

	// Wire a counter to every lifecycle event so /hooks can show live activity.
	// We MUST NOT mutate the event or block any tool/input call — all handlers
	// here are read-only side-effect-free counters.
	const bump = (event: string) => () => {
		counts[event] = (counts[event] ?? 0) + 1;
	};

	// TypeScript can't unify the overloaded pi.on signatures without per-event
	// types, so we cast through unknown. The handler is a no-op counter and
	// never reads or returns event-specific fields, so this is safe.
	const onAny = (event: string) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(pi.on as unknown as (e: string, h: (...args: any[]) => void) => void)(
			event,
			bump(event),
		);
	};
	for (const h of HOOKS) onAny(h.event);

	// ─── /tools (alias /mcp) ─ codex-rs/tui/src/chatwidget.rs add_mcp_output ─────

	const toolsHandler = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		let tools: Array<{
			name: string;
			active: boolean;
			sourceInfo?: { source?: string; path?: string };
			description?: string;
		}> = [];
		try {
			const all = pi.getAllTools() as unknown as Array<{
				name: string;
				sourceInfo?: { source?: string; path?: string };
				description?: string;
			}>;
			const activeSet = new Set(pi.getActiveTools());
			tools = all.map((t) => ({ ...t, active: activeSet.has(t.name) }));
		} catch (err) {
			ctx.ui.notify(
				`Failed to read tool inventory: ${err instanceof Error ? err.message : err}`,
				"error",
			);
			return;
		}

		const filter = rawArgs.trim().toLowerCase();
		const filtered = filter
			? tools.filter((t) =>
					t.name.toLowerCase().includes(filter) ||
					(t.sourceInfo?.path ?? "").toLowerCase().includes(filter) ||
					(t.description ?? "").toLowerCase().includes(filter),
				)
			: tools;

		// Group by source-extension basename (or "built-in" if source is unknown).
		const groups = new Map<string, typeof tools>();
		for (const t of filtered) {
			const src = t.sourceInfo?.path
				? t.sourceInfo.path.split("/").pop() ?? "unknown"
				: "built-in";
			const arr = groups.get(src) ?? [];
			arr.push(t);
			groups.set(src, arr);
		}

		const lines: string[] = [];
		lines.push(
			filter
				? `Tools matching "${filter}" (${filtered.length}/${tools.length}):`
				: `Tools registered (${tools.length} total, ${tools.filter((t) => t.active).length} active):`,
		);
		lines.push("");
		for (const [src, ts] of [...groups.entries()].sort()) {
			lines.push(`[${src}] (${ts.length})`);
			for (const t of ts.sort((a, b) => a.name.localeCompare(b.name))) {
				const marker = t.active ? "●" : "○";
				const desc = (t.description ?? "").split("\n")[0].slice(0, 100);
				lines.push(`  ${marker} ${t.name.padEnd(24)} ${desc}`);
			}
		}
		lines.push("");
		lines.push("● active  ○ inactive (registered but not in the active tool set this session)");
		ctx.ui.notify(lines.join("\n"), "info");
	};

	pi.registerCommand("tools", {
		description:
			"List registered tools grouped by source extension, with active/inactive markers. Optional substring filter as argument.",
		handler: toolsHandler,
	});

	// /mcp — codex's name. In codex this filters to MCP-server tools; in pi every
	// tool registers via the same pi.registerTool() API, so /mcp aliases /tools.
	pi.registerCommand("mcp", {
		description:
			"Alias for /tools (codex port; pi doesn't distinguish MCP tools from other extension tools).",
		handler: toolsHandler,
	});

	// ─── /debug-config ─ codex-rs/tui/src/chatwidget.rs add_debug_config_output ─

	pi.registerCommand("debug-config", {
		description:
			"Dump active pi configuration: settings, current model, cwd, extensions, skills, env (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines: string[] = [];

			lines.push("[runtime]");
			const model = ctx.model;
			lines.push(`  model:          ${model?.provider ?? "?"} / ${model?.id ?? "?"}`);
			try {
				lines.push(`  thinkingLevel:  ${pi.getThinkingLevel() ?? "?"}`);
			} catch {
				lines.push("  thinkingLevel:  (unavailable)");
			}
			lines.push(`  cwd:            ${ctx.cwd}`);
			lines.push(`  sessionId:      ${ctx.sessionManager.getSessionId() ?? "(none)"}`);
			lines.push(`  sessionFile:    ${ctx.sessionManager.getSessionFile() ?? "(unpersisted)"}`);

			lines.push("");
			lines.push("[settings layers]");
			const layers = [
				{ label: "global", path: join(homedir(), ".pi", "agent", "settings.json") },
				{ label: "project", path: join(ctx.cwd, ".pi", "settings.json") },
			];
			for (const { label, path } of layers) {
				if (existsSync(path)) {
					try {
						const raw = readFileSync(path, "utf8");
						const parsed = JSON.parse(raw) as Record<string, unknown>;
						const keys = Object.keys(parsed).sort().join(", ");
						lines.push(`  ${label.padEnd(8)} ${path}`);
						lines.push(`             keys: ${keys || "(empty)"}`);
					} catch {
						lines.push(`  ${label.padEnd(8)} ${path} (invalid JSON)`);
					}
				} else {
					lines.push(`  ${label.padEnd(8)} ${path} (not present)`);
				}
			}

			lines.push("");
			lines.push("[loaded extensions + skills]");
			try {
				const commands = pi.getCommands() as unknown as Array<{
					name: string;
					source: string;
					sourceInfo?: { path?: string };
				}>;
				const byPath = new Map<string, { source: string; commands: string[] }>();
				for (const c of commands) {
					const path = c.sourceInfo?.path ?? "<unknown>";
					const rec = byPath.get(path) ?? { source: c.source, commands: [] };
					rec.commands.push(`/${c.name}`);
					byPath.set(path, rec);
				}
				for (const [path, rec] of [...byPath.entries()].sort()) {
					const basename = path.split("/").slice(-2).join("/");
					lines.push(`  [${rec.source.padEnd(9)}] ${basename}`);
					lines.push(`              ${rec.commands.sort().join(" ")}`);
				}
			} catch (err) {
				lines.push(`  (failed: ${err instanceof Error ? err.message : err})`);
			}

			lines.push("");
			lines.push("[env vars (pi/codex-related)]");
			for (const key of [
				"PI_CODING_AGENT_DIR",
				"PI_CODING_AGENT_SESSION_DIR",
				"PI_OFFLINE",
				"PI_NO_SPOOF",
				"PI_TELEMETRY",
				"PI_FLEET_HOME",
				"PI_MEMORIES_DIR",
			]) {
				const v = process.env[key];
				lines.push(`  ${key.padEnd(28)} ${v === undefined ? "(unset)" : v}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ─── /hooks ────────────────────────────────────────────────────────────

	pi.registerCommand("hooks", {
		description:
			"List pi extension lifecycle events with live fire counts (codex port of /hooks).",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim().toLowerCase();

			if (args === "reset" || args === "clear") {
				for (const h of HOOKS) counts[h.event] = 0;
				ctx.ui.notify("Hook fire counts reset.", "info");
				return;
			}

			const showAll = args === "all" || args === "-a";
			const lines: string[] = [];
			lines.push("Lifecycle events available to pi extensions (pi.on):");
			lines.push("");

			let lastGroup = "";
			for (const h of HOOKS) {
				if (h.group !== lastGroup) {
					lines.push(`[${h.group}]`);
					lastGroup = h.group;
				}
				const fired = counts[h.event] ?? 0;
				const fireBadge = fired > 0 ? `×${fired}` : " ·";
				// Show all by default, but mark fired ones; if --all is omitted,
				// dim un-fired ones via a marker only (no color in notify text).
				if (!showAll && fired === 0) {
					lines.push(`  ${fireBadge.padEnd(5)} ${h.event}`);
				} else {
					lines.push(`  ${fireBadge.padEnd(5)} ${h.event.padEnd(28)} ${h.description}`);
				}
			}
			lines.push("");
			lines.push(`Total ${HOOKS.length} events. /hooks all to show all descriptions. /hooks reset to clear counts.`);
			ctx.ui.notify(lines.join("\n"), "info");
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "all", description: "show full descriptions for every event" },
				{ value: "reset", description: "zero the fire counts" },
			];
			const p = prefix.trim().toLowerCase();
			return subs.filter((s) => s.value.startsWith(p));
		},
	});
}
