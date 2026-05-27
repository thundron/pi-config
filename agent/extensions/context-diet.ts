// Continuous, non-destructive tool-result compression for pi.
// Hooks `context` (fires before every LLM call) and rewrites the messages
// array in-flight: older ToolResultMessage content gets compressed (head +
// trim-marker + tail) or torn out (single-line stub) so the LLM context stays
// lean across long sessions. Session-on-disk is never modified — /resume
// always restores the full history.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// ─── tunables (env-overridable; runtime-tweakable via /context-diet) ───────

interface DietConfig {
	enabled: boolean;
	/** "compress" keeps head+tail with a [trimmed N bytes] marker; "tear-out" replaces with a stub-only. */
	mode: "compress" | "tear-out";
	/** Last N turns are preserved verbatim (a turn ≈ everything since the previous user message). */
	keepRecentTurns: number;
	/** Any tool result larger than this gets compressed even if it's in a "recent" turn. */
	maxResultBytes: number;
	/** Bytes from the start of the original content to keep in compress mode. */
	headBytes: number;
	/** Bytes from the end of the original content to keep in compress mode. */
	tailBytes: number;
	/** Always preserve error results verbatim — they're small + load-bearing. */
	preserveErrors: boolean;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DEFAULT_CONFIG: DietConfig = {
	enabled: process.env.PI_CONTEXT_DIET_DISABLE !== "1",
	mode: process.env.PI_CONTEXT_DIET_MODE === "tear-out" ? "tear-out" : "compress",
	keepRecentTurns: envInt("PI_CONTEXT_DIET_KEEP_TURNS", 3),
	maxResultBytes: envInt("PI_CONTEXT_DIET_MAX_BYTES", 8192),
	headBytes: envInt("PI_CONTEXT_DIET_HEAD_BYTES", 512),
	tailBytes: envInt("PI_CONTEXT_DIET_TAIL_BYTES", 256),
	preserveErrors: process.env.PI_CONTEXT_DIET_KEEP_ERRORS !== "0",
};

const STATUS_KEY = "context-diet";

// ─── per-session running stats ─────────────────────────────────────────────

interface DietStats {
	/** Total bytes that would have been sent to the LLM if we hadn't intervened. */
	bytesOriginal: number;
	/** Bytes actually sent after rewriting. */
	bytesSent: number;
	/** Estimated tokens that would have been sent (chars/4 heuristic from pi). */
	tokensOriginal: number;
	/** Estimated tokens actually sent. */
	tokensSent: number;
	/** Tool results trimmed in the most recent call (not cumulative). */
	resultsTrimmedLast: number;
	/** Total tool results trimmed across the session. */
	resultsTrimmedTotal: number;
	/** Calls processed. */
	calls: number;
}

function emptyStats(): DietStats {
	return {
		bytesOriginal: 0,
		bytesSent: 0,
		tokensOriginal: 0,
		tokensSent: 0,
		resultsTrimmedLast: 0,
		resultsTrimmedTotal: 0,
		calls: 0,
	};
}

// Token estimate falls back to chars/4 if estimateTokens isn't importable
// (very old pi). Matches pi's own internal heuristic.
function tokensOf(msgs: AgentMessage[]): number {
	let n = 0;
	for (const m of msgs) {
		try { n += estimateTokens(m); }
		catch { n += Math.ceil(messageByteLen(m) / 4); }
	}
	return n;
}

// ─── helpers ───────────────────────────────────────────────────────────────

// `AgentMessage["content"]` is NOT valid type-wise: AgentMessage is a union
// that includes `CustomAgentMessages[...]` members which may lack `content`.
// Accept the shapes we actually see (string or content-block array) via
// duck-typing.
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") out += b.text;
	}
	return out;
}

function byteLen(s: string): number {
	// Best-effort UTF-8 byte length without spawning Buffer (works in any JS).
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; }
		else n += 3;
	}
	return n;
}

function messageByteLen(m: AgentMessage): number {
	if (m.role === "toolResult") return byteLen(textOf(m.content));
	if (m.role === "user") return byteLen(textOf(m.content));
	if (m.role === "assistant") {
		let n = 0;
		const content = (m as { content?: unknown }).content;
		if (Array.isArray(content)) {
			for (const b of content as Array<Record<string, unknown>>) {
				if (b.type === "text" && typeof b.text === "string") n += byteLen(b.text);
				else if (b.type === "thinking" && typeof b.thinking === "string") n += byteLen(b.thinking);
				else if (b.type === "toolCall" && b.input != null) {
					try { n += byteLen(JSON.stringify(b.input)); } catch { /* ignore */ }
				}
			}
		}
		return n;
	}
	return 0;
}

function totalBytes(msgs: AgentMessage[]): number {
	let n = 0;
	for (const m of msgs) n += messageByteLen(m);
	return n;
}

/**
 * Decide which message indices are "recent" (preserved verbatim by turn count).
 * A turn boundary = a user-role message. We keep the last `keepRecentTurns`
 * user messages + everything after them.
 */
function recentMessageCutoff(msgs: AgentMessage[], keepRecentTurns: number): number {
	if (keepRecentTurns <= 0) return msgs.length; // nothing is "recent" → trim all eligible
	let userSeen = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].role === "user") {
			userSeen += 1;
			if (userSeen >= keepRecentTurns) return i;
		}
	}
	return 0; // fewer than keepRecentTurns user messages exist → keep all
}

function makeStub(toolName: string, origBytes: number, mode: "compress" | "tear-out", original: string, cfg: DietConfig): string {
	if (mode === "tear-out") {
		return `[tool ${toolName} result torn out by context-diet — ${origBytes}B reclaimed; full content preserved on disk]`;
	}
	// compress
	if (origBytes <= cfg.headBytes + cfg.tailBytes + 80) {
		// Smaller than head+tail+marker — return as-is (no win to compress).
		return original;
	}
	const head = original.slice(0, cfg.headBytes);
	const tail = original.slice(original.length - cfg.tailBytes);
	const trimmed = origBytes - byteLen(head) - byteLen(tail);
	return `${head}\n\n[... context-diet trimmed ${trimmed}B; ${origBytes}B → ${cfg.headBytes + cfg.tailBytes}B; full content preserved on disk ...]\n\n${tail}`;
}

/**
 * Rewrite a single ToolResultMessage's content to a compressed/torn-out form.
 * Returns the new message (or the original, unchanged, when no rewrite applies).
 */
function rewriteToolResult(
	msg: AgentMessage,
	cfg: DietConfig,
	force: boolean,
): { msg: AgentMessage; trimmed: boolean; bytesSaved: number } {
	if (msg.role !== "toolResult") return { msg, trimmed: false, bytesSaved: 0 };
	// `msg` is now narrowed to ToolResultMessage. Don't re-cast to a wider
	// content shape; tsc rejects the conversion and the wider shape was lying
	// anyway (real content is (TextContent|ImageContent)[]).
	const tr = msg;
	if (cfg.preserveErrors && tr.isError) return { msg, trimmed: false, bytesSaved: 0 };
	const origText = textOf(tr.content);
	const origBytes = byteLen(origText);
	const eligibleBySize = origBytes > cfg.maxResultBytes;
	if (!force && !eligibleBySize) return { msg, trimmed: false, bytesSaved: 0 };
	if (origBytes < 256 && cfg.mode === "compress") return { msg, trimmed: false, bytesSaved: 0 };

	const stub = makeStub(tr.toolName, origBytes, cfg.mode, origText, cfg);
	const newBytes = byteLen(stub);
	if (newBytes >= origBytes) return { msg, trimmed: false, bytesSaved: 0 };

	// Drop image content too (replace whole content with a single text stub).
	const newMsg: AgentMessage = {
		...tr,
		content: [{ type: "text", text: stub }],
	} as AgentMessage;
	return { msg: newMsg, trimmed: true, bytesSaved: origBytes - newBytes };
}

/**
 * Walk the message list and rewrite tool results that:
 *   - sit before the recent cutoff (force-rewrite), OR
 *   - are larger than `maxResultBytes` regardless of position.
 * Returns the rewritten array + how many were trimmed and bytes saved.
 */
function rewriteContext(
	msgs: AgentMessage[],
	cfg: DietConfig,
): { msgs: AgentMessage[]; trimmed: number; bytesSaved: number } {
	const cutoff = recentMessageCutoff(msgs, cfg.keepRecentTurns);
	const out: AgentMessage[] = new Array(msgs.length);
	let trimmed = 0;
	let bytesSaved = 0;
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		const force = i < cutoff;
		const rewritten = rewriteToolResult(m, cfg, force);
		out[i] = rewritten.msg;
		if (rewritten.trimmed) {
			trimmed += 1;
			bytesSaved += rewritten.bytesSaved;
		}
	}
	return { msgs: out, trimmed, bytesSaved };
}

// ─── extension entrypoint ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cfg: DietConfig = { ...DEFAULT_CONFIG };
	const stats = emptyStats();

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n}B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
		return `${(n / (1024 * 1024)).toFixed(2)}MB`;
	}

	function fmtTokens(n: number): string {
		if (n < 1000) return `${n}t`;
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}kt`;
		return `${(n / 1_000_000).toFixed(2)}Mt`;
	}

	/** Cumulative % of the context window we bought back over the session. */
	function savedPercentOfWindow(ctx: ExtensionContext): number | null {
		const usage = ctx.getContextUsage();
		if (!usage || !usage.contextWindow) return null;
		const saved = stats.tokensOriginal - stats.tokensSent;
		return (saved / usage.contextWindow) * 100;
	}

	function refreshFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!cfg.enabled) {
			ctx.ui.setStatus(STATUS_KEY, "📉 diet OFF");
			return;
		}
		if (stats.calls === 0) {
			ctx.ui.setStatus(STATUS_KEY, "📉 diet on");
			return;
		}
		const savedTok = stats.tokensOriginal - stats.tokensSent;
		const pctSaved = savedPercentOfWindow(ctx);
		const pctStr = pctSaved === null ? "" : ` ↓${pctSaved.toFixed(1)}%`;
		ctx.ui.setStatus(
			STATUS_KEY,
			`📉 -${fmtTokens(savedTok)}${pctStr} (${stats.resultsTrimmedTotal} trims)`,
		);
	}

	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// The hot path: rewrite the message list before every LLM call.
	pi.on("context", async (event, ctx) => {
		if (!cfg.enabled) return undefined;
		const beforeBytes = totalBytes(event.messages);
		const beforeTokens = tokensOf(event.messages);
		const { msgs, trimmed, bytesSaved } = rewriteContext(event.messages, cfg);
		const afterBytes = beforeBytes - bytesSaved;
		const afterTokens = trimmed === 0 ? beforeTokens : tokensOf(msgs);
		stats.calls += 1;
		stats.bytesOriginal += beforeBytes;
		stats.bytesSent += afterBytes;
		stats.tokensOriginal += beforeTokens;
		stats.tokensSent += afterTokens;
		stats.resultsTrimmedLast = trimmed;
		stats.resultsTrimmedTotal += trimmed;
		refreshFooter(ctx);
		if (trimmed === 0) return undefined; // no rewrite → pass through (cheaper)
		return { messages: msgs };
	});

	// ─── slash command: /context-diet ─────────────────────────────────────

	pi.registerCommand("context-diet", {
		description:
			"Continuous tool-output compression. Subcommands: on | off | mode <compress|tear-out> | keep <N> | max <bytes> | reset | show",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();

			if (!args || args === "show" || args === "status") {
				const usage = ctx.getContextUsage();
				const lines: string[] = [];
				lines.push(`enabled:           ${cfg.enabled}`);
				lines.push(`mode:              ${cfg.mode}`);
				lines.push(`keep recent turns: ${cfg.keepRecentTurns}`);
				lines.push(`max result bytes:  ${cfg.maxResultBytes}`);
				lines.push(`head/tail bytes:   ${cfg.headBytes} / ${cfg.tailBytes}`);
				lines.push(`preserve errors:   ${cfg.preserveErrors}`);
				lines.push("");
				lines.push(`calls processed:   ${stats.calls}`);
				lines.push(`bytes original:    ${fmtBytes(stats.bytesOriginal)}`);
				lines.push(`bytes sent:        ${fmtBytes(stats.bytesSent)}`);
				const savedBytes = stats.bytesOriginal - stats.bytesSent;
				lines.push(`bytes saved:       ${fmtBytes(savedBytes)}`);
				lines.push(`tokens original:   ${fmtTokens(stats.tokensOriginal)}`);
				lines.push(`tokens sent:       ${fmtTokens(stats.tokensSent)}`);
				const savedTok = stats.tokensOriginal - stats.tokensSent;
				lines.push(`tokens saved:      ${fmtTokens(savedTok)}`);
				if (usage && usage.contextWindow) {
					const pctSaved = (savedTok / usage.contextWindow) * 100;
					lines.push(`context window:    ${usage.contextWindow.toLocaleString()} tok`);
					if (usage.percent !== null) lines.push(`live ctx usage:    ${usage.percent.toFixed(1)}%`);
					lines.push(`ctx window saved:  ${pctSaved.toFixed(1)}%  (≈${fmtTokens(savedTok)} reclaimed)`);
				}
				lines.push(`trims last call:   ${stats.resultsTrimmedLast}`);
				lines.push(`trims total:       ${stats.resultsTrimmedTotal}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [head, ...rest] = args.split(/\s+/);
			const tail = rest.join(" ").trim();
			const sub = head.toLowerCase();

			if (sub === "off" || sub === "disable") {
				cfg.enabled = false;
				refreshFooter(ctx);
				ctx.ui.notify("context-diet OFF — LLM will see full tool results until re-enabled.", "info");
				return;
			}
			if (sub === "on" || sub === "enable") {
				cfg.enabled = true;
				refreshFooter(ctx);
				ctx.ui.notify("context-diet ON.", "info");
				return;
			}
			if (sub === "reset") {
				stats.bytesOriginal = 0;
				stats.bytesSent = 0;
				stats.tokensOriginal = 0;
				stats.tokensSent = 0;
				stats.resultsTrimmedLast = 0;
				stats.resultsTrimmedTotal = 0;
				stats.calls = 0;
				refreshFooter(ctx);
				ctx.ui.notify("context-diet stats reset.", "info");
				return;
			}
			if (sub === "mode") {
				if (tail !== "compress" && tail !== "tear-out") {
					ctx.ui.notify("Usage: /context-diet mode compress|tear-out", "warning");
					return;
				}
				cfg.mode = tail;
				ctx.ui.notify(`mode = ${cfg.mode}`, "info");
				return;
			}
			if (sub === "keep") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /context-diet keep <N>  (N ≥ 0)", "warning");
					return;
				}
				cfg.keepRecentTurns = n;
				ctx.ui.notify(`keep recent turns = ${cfg.keepRecentTurns}`, "info");
				return;
			}
			if (sub === "max") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 256) {
					ctx.ui.notify("Usage: /context-diet max <bytes>  (≥256)", "warning");
					return;
				}
				cfg.maxResultBytes = n;
				ctx.ui.notify(`max result bytes = ${cfg.maxResultBytes}`, "info");
				return;
			}
			if (sub === "head") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /context-diet head <bytes>  (≥0)", "warning");
					return;
				}
				cfg.headBytes = n;
				ctx.ui.notify(`head bytes = ${cfg.headBytes}`, "info");
				return;
			}
			if (sub === "tail") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /context-diet tail <bytes>  (≥0)", "warning");
					return;
				}
				cfg.tailBytes = n;
				ctx.ui.notify(`tail bytes = ${cfg.tailBytes}`, "info");
				return;
			}
			if (sub === "errors") {
				if (tail === "preserve" || tail === "keep") cfg.preserveErrors = true;
				else if (tail === "trim" || tail === "compress") cfg.preserveErrors = false;
				else {
					ctx.ui.notify("Usage: /context-diet errors preserve|trim", "warning");
					return;
				}
				ctx.ui.notify(`preserve errors = ${cfg.preserveErrors}`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: ${sub}\n\n` +
					`Usage:\n` +
					`  /context-diet                     show current config + stats\n` +
					`  /context-diet on | off            enable / disable\n` +
					`  /context-diet mode compress|tear-out\n` +
					`  /context-diet keep <N>            keep last N turns verbatim\n` +
					`  /context-diet max <bytes>         compress any single result > N bytes\n` +
					`  /context-diet head <bytes>        head bytes kept in compress mode\n` +
					`  /context-diet tail <bytes>        tail bytes kept in compress mode\n` +
					`  /context-diet errors preserve|trim\n` +
					`  /context-diet reset               clear stats`,
				"warning",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "on", description: "enable" },
				{ value: "off", description: "disable" },
				{ value: "mode", description: "compress | tear-out" },
				{ value: "keep", description: "keep last N turns verbatim" },
				{ value: "max", description: "max bytes per result before trim" },
				{ value: "head", description: "bytes from start to keep" },
				{ value: "tail", description: "bytes from end to keep" },
				{ value: "errors", description: "preserve | trim" },
				{ value: "reset", description: "clear stats" },
				{ value: "show", description: "show current config + stats" },
				{ value: "status", description: "show current config + stats (alias)" },
			];
			const p = prefix.trim().toLowerCase();
			return subs
				.filter((s) => s.value.startsWith(p))
				.map((s) => ({ value: s.value, label: s.value, description: s.description }));
		},
	});

	// Internal helper for unit tests (loaded via dynamic import).
	(pi as unknown as { __contextDietInternals?: unknown }).__contextDietInternals = {
		rewriteContext,
		makeStub,
		recentMessageCutoff,
		byteLen,
		messageByteLen,
		tokensOf,
		cfg,
		stats,
	};
}
