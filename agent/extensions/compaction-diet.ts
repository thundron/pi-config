// Bounded compaction summarization for pi.
//
// pi's default compaction serializes the entire to-be-summarized span into a
// single prompt and sends it to the session model. context-diet only shrinks
// the *live* per-turn request — it never touches the on-disk history and is
// bypassed entirely by the summarizer. So in a long session the summarization
// payload can exceed the model's context window and the request fails with
// `context_length_exceeded`, taking compaction down with it.
//
// This extension takes over the `session_before_compact` hook and:
//   1. trims oversized tool results in the to-summarize span (the dominant
//      source of bloat), the same head+tail compression context-diet uses;
//   2. if the trimmed span still doesn't fit, folds it through pi's own
//      `generateSummary` in bounded chunks (map-reduce: each chunk merges into
//      the running summary via the iterative-update prompt);
//   3. optionally routes summarization to a larger-context model.
//
// The result is fed back as `{ compaction: { summary, firstKeptEntryId,
// tokensBefore } }`, so no single request ever exceeds the window regardless
// of on-disk size. On any failure it returns nothing and pi falls back to its
// default compaction.

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, generateSummary, serializeConversation } from "@earendil-works/pi-coding-agent";

// ─── config (env-overridable; runtime-tweakable via /compaction-diet) ──────

interface DietConfig {
	enabled: boolean;
	/** "compress" keeps head+tail with a marker; "tear-out" replaces with a stub. */
	mode: "compress" | "tear-out";
	/** Trim any tool result whose text exceeds this many bytes before summarizing. */
	maxResultBytes: number;
	/** Bytes kept from the start of a trimmed result in compress mode. */
	headBytes: number;
	/** Bytes kept from the end of a trimmed result in compress mode. */
	tailBytes: number;
	/** Thinking level for the summarizer (only applied when the model supports it). */
	thinking: ThinkingLevel;
	/** Fraction of the model's context window usable for the summarization input. */
	usableFraction: number;
	/** Tokens reserved for prompt scaffolding (system prompt + tags + base prompt). */
	promptOverhead: number;
	/** Floor for a single chunk's token budget, so tiny windows don't fan out absurdly. */
	minChunkTokens: number;
	/** Optional "provider/model-id" to summarize with instead of the session model. */
	modelRef: string;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envFloat(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseFloat(raw);
	return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function envThinking(name: string, fallback: ThinkingLevel): ThinkingLevel {
	const raw = process.env[name];
	if (raw && THINKING_LEVELS.includes(raw)) return raw as ThinkingLevel;
	return fallback;
}

function defaultConfig(): DietConfig {
	return {
		enabled: process.env.PI_COMPACTION_DIET_DISABLE !== "1",
		mode: process.env.PI_COMPACTION_DIET_MODE === "tear-out" ? "tear-out" : "compress",
		maxResultBytes: envInt("PI_COMPACTION_DIET_MAX_BYTES", 4096),
		headBytes: envInt("PI_COMPACTION_DIET_HEAD_BYTES", 800),
		tailBytes: envInt("PI_COMPACTION_DIET_TAIL_BYTES", 400),
		thinking: envThinking("PI_COMPACTION_DIET_THINKING", "low"),
		usableFraction: envFloat("PI_COMPACTION_DIET_USABLE_FRACTION", 0.85),
		promptOverhead: envInt("PI_COMPACTION_DIET_PROMPT_OVERHEAD", 1500),
		minChunkTokens: envInt("PI_COMPACTION_DIET_MIN_CHUNK", 4000),
		modelRef: process.env.PI_COMPACTION_DIET_MODEL ?? "",
	};
}

const STATUS_KEY = "compaction-diet";

// ─── per-session stats ─────────────────────────────────────────────────────

interface DietStats {
	runs: number;
	lastModel: string;
	lastChunks: number;
	lastTrimmedResults: number;
	lastInputTokens: number;
	lastSummaryTokens: number;
	lastBytesSaved: number;
	lastFallback: boolean;
}

function emptyStats(): DietStats {
	return {
		runs: 0,
		lastModel: "",
		lastChunks: 0,
		lastTrimmedResults: 0,
		lastInputTokens: 0,
		lastSummaryTokens: 0,
		lastBytesSaved: 0,
		lastFallback: false,
	};
}

// ─── helpers ─────────────────────────────────────────────────────────────

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
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			n += 4;
			i += 1;
		} else n += 3;
	}
	return n;
}

function tokensOf(msgs: AgentMessage[]): number {
	let n = 0;
	for (const m of msgs) {
		try {
			n += estimateTokens(m);
		} catch {
			n += Math.ceil(byteLen(textOf((m as { content?: unknown }).content)) / 4);
		}
	}
	return n;
}

function makeStub(toolName: string, origBytes: number, mode: "compress" | "tear-out", original: string, cfg: DietConfig): string {
	if (mode === "tear-out") {
		return `[tool ${toolName} result torn out by compaction-diet — ${origBytes}B reclaimed; full content preserved on disk]`;
	}
	if (origBytes <= cfg.headBytes + cfg.tailBytes + 80) return original;
	const head = original.slice(0, cfg.headBytes);
	const tail = original.slice(original.length - cfg.tailBytes);
	const trimmed = origBytes - byteLen(head) - byteLen(tail);
	return `${head}\n\n[... compaction-diet trimmed ${trimmed}B; ${origBytes}B → ${cfg.headBytes + cfg.tailBytes}B; full content preserved on disk ...]\n\n${tail}`;
}

/**
 * Compress oversized tool results in the span before summarizing. Every result
 * is eligible regardless of position or error flag — the whole span is being
 * summarized away, so there is no recent-turn window to preserve.
 */
function trimForSummary(msgs: AgentMessage[], cfg: DietConfig): { msgs: AgentMessage[]; trimmed: number; bytesSaved: number } {
	const out: AgentMessage[] = new Array(msgs.length);
	let trimmed = 0;
	let bytesSaved = 0;
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role !== "toolResult") {
			out[i] = m;
			continue;
		}
		const origText = textOf(m.content);
		const origBytes = byteLen(origText);
		if (origBytes <= cfg.maxResultBytes) {
			out[i] = m;
			continue;
		}
		const stub = makeStub(m.toolName, origBytes, cfg.mode, origText, cfg);
		const newBytes = byteLen(stub);
		if (newBytes >= origBytes) {
			out[i] = m;
			continue;
		}
		out[i] = { ...m, content: [{ type: "text", text: stub }] } as AgentMessage;
		trimmed += 1;
		bytesSaved += origBytes - newBytes;
	}
	return { msgs: out, trimmed, bytesSaved };
}

interface Budgets {
	/** Max input tokens for a single-shot summary (no running summary fed back). */
	single: number;
	/** Max input tokens per chunk (leaves room for the running summary + output). */
	chunk: number;
}

function computeBudgets(model: Model<any>, reserveTokens: number, cfg: DietConfig): Budgets {
	const ctxWindow = model.contextWindow > 0 ? model.contextWindow : 128000;
	const outBudget = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
	const out = Number.isFinite(outBudget) ? outBudget : Math.floor(0.8 * reserveTokens);
	const usable = Math.floor(ctxWindow * cfg.usableFraction);
	const single = Math.max(cfg.minChunkTokens, usable - cfg.promptOverhead - out);
	const chunk = Math.max(cfg.minChunkTokens, usable - cfg.promptOverhead - out - out);
	return { single, chunk };
}

/** Greedy split into consecutive chunks each within `budget` tokens. Never splits a message. */
function planChunks(msgs: AgentMessage[], budget: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let cur: AgentMessage[] = [];
	let curTok = 0;
	for (const m of msgs) {
		let t: number;
		try {
			t = estimateTokens(m);
		} catch {
			t = Math.ceil(byteLen(textOf((m as { content?: unknown }).content)) / 4);
		}
		if (cur.length > 0 && curTok + t > budget) {
			chunks.push(cur);
			cur = [];
			curTok = 0;
		}
		cur.push(m);
		curTok += t;
	}
	if (cur.length > 0) chunks.push(cur);
	return chunks;
}

function parseModelRef(ref: string): { provider: string; id: string } | null {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return null;
	return { provider: ref.slice(0, slash).trim(), id: ref.slice(slash + 1).trim() };
}

interface ResolvedModel {
	model: Model<any>;
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
}

// ─── extension entrypoint ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cfg = defaultConfig();
	const stats = emptyStats();

	function note(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	}

	function refreshFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!cfg.enabled) {
			ctx.ui.setStatus(STATUS_KEY, "🗜 compaction-diet OFF");
			return;
		}
		if (stats.runs === 0) {
			ctx.ui.setStatus(STATUS_KEY, "🗜 compaction-diet on");
			return;
		}
		const chunkStr = stats.lastChunks > 1 ? ` ${stats.lastChunks}ch` : "";
		ctx.ui.setStatus(STATUS_KEY, `🗜 ${stats.lastModel}${chunkStr} (${fmtTokens(stats.lastInputTokens)}→${fmtTokens(stats.lastSummaryTokens)})`);
	}

	async function resolveModel(ctx: ExtensionContext): Promise<ResolvedModel | null> {
		if (cfg.modelRef) {
			const parsed = parseModelRef(cfg.modelRef);
			if (!parsed) {
				note(ctx, `compaction-diet: bad PI_COMPACTION_DIET_MODEL "${cfg.modelRef}" (want "provider/id") — using session model.`, "warning");
			} else {
				const m = ctx.modelRegistry.find(parsed.provider, parsed.id);
				if (!m) {
					note(ctx, `compaction-diet: model "${cfg.modelRef}" not found — using session model.`, "warning");
				} else {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
					if (auth.ok) return { model: m, apiKey: auth.apiKey, headers: auth.headers };
					note(ctx, `compaction-diet: no auth for "${cfg.modelRef}" (${auth.error}) — using session model.`, "warning");
				}
			}
		}
		const m = ctx.model;
		if (!m) return null;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
		if (!auth.ok) return null;
		return { model: m, apiKey: auth.apiKey, headers: auth.headers };
	}

	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!cfg.enabled) return undefined;

		const { preparation, customInstructions } = event;
		const signal = event.signal ?? new AbortController().signal;
		const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (all.length === 0) return undefined; // nothing for us; let default decide

		const resolved = await resolveModel(ctx);
		if (!resolved) return undefined; // no usable model/auth; fall back to default
		const { model, apiKey, headers } = resolved;

		const reserveTokens = preparation.settings.reserveTokens > 0 ? preparation.settings.reserveTokens : 16384;
		const { msgs: trimmed, trimmed: trimmedCount, bytesSaved } = trimForSummary(all, cfg);
		const { single, chunk } = computeBudgets(model, reserveTokens, cfg);
		const inputTokens = tokensOf(trimmed);

		const run = async (): Promise<string> => {
			if (inputTokens <= single) {
				try {
					return await generateSummary(trimmed, model, reserveTokens, apiKey, headers, signal, customInstructions, preparation.previousSummary, cfg.thinking);
				} catch (err) {
					if (signal.aborted) throw err;
					// Budget estimate was optimistic — fold instead of giving up.
				}
			}
			const chunks = planChunks(trimmed, chunk);
			stats.lastChunks = chunks.length;
			let running = preparation.previousSummary;
			for (const part of chunks) {
				running = await generateSummary(part, model, reserveTokens, apiKey, headers, signal, customInstructions, running, cfg.thinking);
			}
			return running ?? "";
		};

		stats.lastChunks = 1;
		try {
			const summary = await run();
			if (!summary.trim()) {
				if (!signal.aborted) note(ctx, "compaction-diet: empty summary — falling back to default compaction.", "warning");
				stats.lastFallback = true;
				refreshFooter(ctx);
				return undefined;
			}
			stats.runs += 1;
			stats.lastModel = model.id;
			stats.lastTrimmedResults = trimmedCount;
			stats.lastBytesSaved = bytesSaved;
			stats.lastInputTokens = inputTokens;
			stats.lastSummaryTokens = Math.ceil(byteLen(summary) / 4);
			stats.lastFallback = false;
			refreshFooter(ctx);
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		} catch (err) {
			if (signal.aborted) return undefined;
			const message = err instanceof Error ? err.message : String(err);
			note(ctx, `compaction-diet: summarization failed (${message}) — falling back to default compaction.`, "error");
			stats.lastFallback = true;
			refreshFooter(ctx);
			return undefined;
		}
	});

	// ─── slash command: /compaction-diet ──────────────────────────────────

	pi.registerCommand("compaction-diet", {
		description:
			"Bounded compaction summarization. Subcommands: on | off | mode <compress|tear-out> | max <bytes> | model <provider/id|clear> | thinking <level> | show",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();

			if (!args || args === "show" || args === "status") {
				const lines: string[] = [];
				lines.push(`enabled:          ${cfg.enabled}`);
				lines.push(`mode:             ${cfg.mode}`);
				lines.push(`max result bytes: ${cfg.maxResultBytes}`);
				lines.push(`head/tail bytes:  ${cfg.headBytes} / ${cfg.tailBytes}`);
				lines.push(`thinking:         ${cfg.thinking}`);
				lines.push(`usable fraction:  ${cfg.usableFraction}`);
				lines.push(`summary model:    ${cfg.modelRef || "(session model)"}`);
				lines.push("");
				lines.push(`runs this session: ${stats.runs}`);
				if (stats.runs > 0 || stats.lastFallback) {
					lines.push(`last model:        ${stats.lastModel || "(fallback)"}`);
					lines.push(`last chunks:       ${stats.lastChunks}`);
					lines.push(`last trims:        ${stats.lastTrimmedResults} results, ${fmtBytes(stats.lastBytesSaved)} saved`);
					lines.push(`last input:        ${fmtTokens(stats.lastInputTokens)}`);
					lines.push(`last summary:      ${fmtTokens(stats.lastSummaryTokens)}`);
					lines.push(`last fallback:     ${stats.lastFallback}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [head, ...rest] = args.split(/\s+/);
			const tail = rest.join(" ").trim();
			const sub = head.toLowerCase();

			if (sub === "off" || sub === "disable") {
				cfg.enabled = false;
				refreshFooter(ctx);
				ctx.ui.notify("compaction-diet OFF — pi's default compaction will summarize the full span.", "info");
				return;
			}
			if (sub === "on" || sub === "enable") {
				cfg.enabled = true;
				refreshFooter(ctx);
				ctx.ui.notify("compaction-diet ON.", "info");
				return;
			}
			if (sub === "mode") {
				if (tail !== "compress" && tail !== "tear-out") {
					ctx.ui.notify("Usage: /compaction-diet mode compress|tear-out", "warning");
					return;
				}
				cfg.mode = tail;
				ctx.ui.notify(`mode = ${cfg.mode}`, "info");
				return;
			}
			if (sub === "max") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 256) {
					ctx.ui.notify("Usage: /compaction-diet max <bytes>  (≥256)", "warning");
					return;
				}
				cfg.maxResultBytes = n;
				ctx.ui.notify(`max result bytes = ${cfg.maxResultBytes}`, "info");
				return;
			}
			if (sub === "model") {
				if (!tail || tail === "clear" || tail === "session") {
					cfg.modelRef = "";
					ctx.ui.notify("summary model = (session model)", "info");
					return;
				}
				if (!parseModelRef(tail)) {
					ctx.ui.notify('Usage: /compaction-diet model <provider/id>  (e.g. "google/gemini-2.5-pro")', "warning");
					return;
				}
				cfg.modelRef = tail;
				ctx.ui.notify(`summary model = ${cfg.modelRef}`, "info");
				return;
			}
			if (sub === "thinking") {
				if (!THINKING_LEVELS.includes(tail)) {
					ctx.ui.notify(`Usage: /compaction-diet thinking <${THINKING_LEVELS.join("|")}>`, "warning");
					return;
				}
				cfg.thinking = tail as ThinkingLevel;
				ctx.ui.notify(`thinking = ${cfg.thinking}`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: ${sub}\n\n` +
					`Usage:\n` +
					`  /compaction-diet                  show config + last-run stats\n` +
					`  /compaction-diet on | off         enable / disable\n` +
					`  /compaction-diet mode compress|tear-out\n` +
					`  /compaction-diet max <bytes>      trim tool results larger than N bytes\n` +
					`  /compaction-diet model <provider/id|clear>\n` +
					`  /compaction-diet thinking <${THINKING_LEVELS.join("|")}>`,
				"warning",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "on", description: "enable" },
				{ value: "off", description: "disable" },
				{ value: "mode", description: "compress | tear-out" },
				{ value: "max", description: "trim tool results larger than N bytes" },
				{ value: "model", description: "provider/id summarization model | clear" },
				{ value: "thinking", description: "summarizer thinking level" },
				{ value: "show", description: "show config + last-run stats" },
			];
			const p = prefix.trim().toLowerCase();
			return subs.filter((s) => s.value.startsWith(p)).map((s) => ({ value: s.value, label: s.value, description: s.description }));
		},
	});

	// Internal helpers for unit tests (loaded via dynamic import).
	(pi as unknown as { __compactionDietInternals?: unknown }).__compactionDietInternals = {
		trimForSummary,
		makeStub,
		computeBudgets,
		planChunks,
		parseModelRef,
		tokensOf,
		byteLen,
		serializeConversation,
		convertToLlm,
		cfg,
		stats,
	};
}

// ─── small formatters ──────────────────────────────────────────────────────

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
