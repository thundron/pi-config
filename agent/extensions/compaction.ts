// Unified compaction management for pi.
//
// This extension owns the whole compaction pipeline for a session, in two
// halves that hand off to each other:
//
//   1. TRIGGER (when to compact) — pi core only compacts near
//      `contextWindow - reserveTokens` (~984k on a 1M model). For large-context
//      models this waits far too long, so the trigger proactively compacts at a
//      configurable fraction of the window (default 50%), either right after a
//      turn settles (post-turn) or just before the next prompt (pre-input
//      fallback). It also supplies `customInstructions` describing what to
//      preserve.
//
//   2. DIET (how to summarize) — pi's default compaction serializes the entire
//      to-be-summarized span into ONE prompt sent to the session model. In a
//      long session that payload can exceed the model's window and the request
//      fails with `context_length_exceeded`. The diet half handles
//      `session_before_compact`: it trims oversized tool results, then produces
//      a bounded single-shot or chunked-fold summary that respects the
//      summarization model's window, honoring the trigger's customInstructions.
//
// The two halves used to be separate extensions (large-context-autocompact +
// compaction-diet) with independent on/off switches — disabling one left the
// other running. They are now one extension behind one master switch
// (`/compaction on|off`), with sub-toggles for each half.

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { generateSummary } from "@earendil-works/pi-coding-agent";

// ─── config ────────────────────────────────────────────────────────────────

interface CompactionConfig {
	/** Master switch: off disables both trigger and diet. */
	enabled: boolean;

	// ── trigger (when to compact) ──
	/** Proactive early-compaction trigger. */
	triggerEnabled: boolean;
	/** Only trigger for models whose context window is at/above this. */
	minContextWindow: number;
	/** Compact when usage reaches this fraction of the window. */
	fraction: number;
	/** Compact right after a turn settles (preferred), not just before next prompt. */
	postTurnEnabled: boolean;
	/** Delay before the post-turn compaction fires. */
	postTurnDelayMs: number;

	// ── diet (how to summarize) ──
	/** Bounded summarization of the span in session_before_compact. */
	dietEnabled: boolean;
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
	/** Fraction of the summarization model's context window usable for input. */
	usableFraction: number;
	/** Tokens reserved for prompt scaffolding (system prompt + tags + base prompt). */
	promptOverhead: number;
	/** Floor for a single chunk's token budget, so tiny windows don't fan out absurdly. */
	minChunkTokens: number;
	/** Optional "provider/model-id" to summarize with instead of the session model. */
	modelRef: string;
}

const STATUS_KEY = "compaction";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envPosInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envFraction(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = Number.parseFloat(raw);
	return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
}

function envThinking(name: string, fallback: ThinkingLevel): ThinkingLevel {
	const raw = process.env[name];
	if (raw && THINKING_LEVELS.includes(raw)) return raw as ThinkingLevel;
	return fallback;
}

function buildConfig(): CompactionConfig {
	return {
		enabled: process.env.PI_COMPACTION_DISABLE !== "1",

		triggerEnabled: process.env.PI_COMPACTION_TRIGGER_DISABLE !== "1",
		minContextWindow: envPosInt("PI_COMPACTION_MIN_CONTEXT", 1_000_000),
		fraction: envFraction("PI_COMPACTION_FRACTION", 0.5),
		postTurnEnabled: process.env.PI_COMPACTION_POST_TURN_DISABLE !== "1",
		postTurnDelayMs: envPosInt("PI_COMPACTION_POST_TURN_DELAY_MS", 250),

		dietEnabled: process.env.PI_COMPACTION_DIET_DISABLE !== "1",
		mode: process.env.PI_COMPACTION_MODE === "tear-out" ? "tear-out" : "compress",
		maxResultBytes: envInt("PI_COMPACTION_MAX_BYTES", 4096),
		headBytes: envInt("PI_COMPACTION_HEAD_BYTES", 800),
		tailBytes: envInt("PI_COMPACTION_TAIL_BYTES", 400),
		thinking: envThinking("PI_COMPACTION_THINKING", "low"),
		usableFraction: envFraction("PI_COMPACTION_USABLE_FRACTION", 0.85),
		promptOverhead: envInt("PI_COMPACTION_PROMPT_OVERHEAD", 1500),
		minChunkTokens: envPosInt("PI_COMPACTION_MIN_CHUNK", 4000),
		modelRef: process.env.PI_COMPACTION_MODEL ?? "",
	};
}

// ─── per-session stats (diet) ────────────────────────────────────────────────

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

// ─── module state ────────────────────────────────────────────────────────────

const cfg: CompactionConfig = buildConfig();
const stats: DietStats = emptyStats();

let compactionInFlight = false;
let postTurnTimer: NodeJS.Timeout | undefined;
let postTurnGeneration = 0;

const triggerActive = (): boolean => cfg.enabled && cfg.triggerEnabled;
const dietActive = (): boolean => cfg.enabled && cfg.dietEnabled;

// ─── shared helpers ──────────────────────────────────────────────────────────

function note(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
}

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

function estTokens(m: AgentMessage): number {
	return Math.ceil(byteLen(textOf((m as { content?: unknown }).content)) / 4);
}

function tokensOf(msgs: AgentMessage[]): number {
	let n = 0;
	for (const m of msgs) n += estTokens(m);
	return n;
}

// ─── footer ──────────────────────────────────────────────────────────────────

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

function footerText(): string | undefined {
	if (!cfg.enabled) return "⊘ compaction off";
	const trig = cfg.triggerEnabled ? `@${Math.round(cfg.fraction * 100)}%` : "no-trigger";
	if (stats.runs === 0) return `📦 compaction ${trig}`;
	const chunkStr = stats.lastChunks > 1 ? ` ${stats.lastChunks}ch` : "";
	return `📦 ${trig} ${stats.lastModel}${chunkStr} (${fmtTokens(stats.lastInputTokens)}→${fmtTokens(stats.lastSummaryTokens)})`;
}

function refreshFooter(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText());
}

// ─── trigger: when to compact ─────────────────────────────────────────────────

// ─── Cross-extension compaction intent ──────────────────────────────────────
//
// Pi's `AgentSession.prompt()` rejects every prompt from the moment
// `ctx.compact()` installs its abort controller. That happens *before* the
// `session_before_compact` extension event is emitted — an `abort()` await, an
// auth resolution await, and a full-branch `prepareCompaction()` pass sit in
// between — so extensions that only watch `session_before_compact` (goal-mode)
// see a window where compaction is already fatal to prompts but not yet
// announced. Publishing the intent here closes that window: goal-mode's
// auto-continuation holds while `count > 0`.
//
// A process-global counter (rather than an import) keeps the two extensions
// independently loadable — pi loads each file in isolation.

interface CompactionIntentRegistry {
	count: number;
}

function compactionIntentRegistry(): CompactionIntentRegistry {
	const g = globalThis as { __piCompactionIntent?: CompactionIntentRegistry };
	if (!g.__piCompactionIntent) g.__piCompactionIntent = { count: 0 };
	return g.__piCompactionIntent;
}

function beginCompactionIntent(): () => void {
	const registry = compactionIntentRegistry();
	registry.count += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		registry.count = Math.max(0, registry.count - 1);
	};
}


function shouldCompact(ctx: ExtensionContext): { compact: boolean; reason?: string } {
	if (!triggerActive()) return { compact: false, reason: "disabled" };
	if (!ctx.isIdle()) return { compact: false, reason: "busy" };
	if (compactionInFlight) return { compact: false, reason: "in-flight" };
	if (ctx.hasPendingMessages()) return { compact: false, reason: "pending-messages" };

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return { compact: false, reason: "unknown" };
	if (usage.contextWindow < cfg.minContextWindow) return { compact: false, reason: "small-context" };

	const threshold = Math.floor(usage.contextWindow * cfg.fraction);
	return { compact: usage.tokens >= threshold };
}

function compactInstructions(mode: "pre-input" | "post-turn"): string {
	return mode === "pre-input"
		? "Preserve all current goals, active decisions, file edits, commands run, test results, blockers, and the exact user prompt that triggered this proactive large-context compaction."
		: "Preserve all current goals, active decisions, file edits, commands run, test results, blockers, and the exact state at the end of the just-finished assistant turn. This proactive large-context compaction is running after the turn settled so the next user prompt does not have to wait for compaction.";
}

function replayInput(pi: ExtensionAPI, event: InputEvent): void {
	if (!event.images || event.images.length === 0) {
		pi.sendUserMessage(event.text);
		return;
	}
	pi.sendUserMessage([{ type: "text", text: event.text }, ...event.images]);
}

function clearPostTurnTimer(): void {
	if (postTurnTimer) clearTimeout(postTurnTimer);
	postTurnTimer = undefined;
}

function startCompaction(
	ctx: ExtensionContext,
	mode: "pre-input" | "post-turn",
	onComplete?: () => void,
	onError?: (error: Error) => void,
): void {
	compactionInFlight = true;
	// Publish before ctx.compact(): pi refuses prompts before it emits any
	// compaction event, so goal-mode must see this intent during setup too.
	const releaseIntent = beginCompactionIntent();
	try {
		ctx.compact({
			customInstructions: compactInstructions(mode),
			onComplete: () => {
				compactionInFlight = false;
				releaseIntent();
				onComplete?.();
			},
			onError: (error) => {
				compactionInFlight = false;
				releaseIntent();
				onError?.(error);
			},
		});
	} catch (error) {
		compactionInFlight = false;
		releaseIntent();
		throw error;
	}
}

function schedulePostTurnCompaction(ctx: ExtensionContext): void {
	if (!triggerActive() || !cfg.postTurnEnabled) return;
	postTurnGeneration += 1;
	const generation = postTurnGeneration;
	clearPostTurnTimer();
	postTurnTimer = setTimeout(() => {
		postTurnTimer = undefined;
		if (generation !== postTurnGeneration) return;
		const decision = shouldCompact(ctx);
		if (!decision.compact) return;
		const usage = ctx.getContextUsage();
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Post-turn auto-compaction: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens; compacting before the next prompt.`,
				"info",
			);
		}
		startCompaction(ctx, "post-turn", undefined, (error) => {
			if (ctx.hasUI) ctx.ui.notify(`Post-turn auto-compaction failed: ${error.message}`, "warning");
		});
	}, cfg.postTurnDelayMs);
	if (typeof postTurnTimer.unref === "function") postTurnTimer.unref();
}

// ─── diet: how to summarize ───────────────────────────────────────────────────

function makeStub(toolName: string, origBytes: number, mode: "compress" | "tear-out", original: string, c: CompactionConfig): string {
	if (mode === "tear-out") {
		return `[tool ${toolName} result torn out by compaction — ${origBytes}B reclaimed; full content preserved on disk]`;
	}
	if (origBytes <= c.headBytes + c.tailBytes + 80) return original;
	const head = original.slice(0, c.headBytes);
	const tail = original.slice(original.length - c.tailBytes);
	const trimmed = origBytes - byteLen(head) - byteLen(tail);
	return `${head}\n\n[... compaction trimmed ${trimmed}B; ${origBytes}B → ${c.headBytes + c.tailBytes}B; full content preserved on disk ...]\n\n${tail}`;
}

/**
 * Compress oversized tool results in the span before summarizing. Every result
 * is eligible regardless of position or error flag — the whole span is being
 * summarized away, so there is no recent-turn window to preserve.
 */
function trimForSummary(msgs: AgentMessage[], c: CompactionConfig): { msgs: AgentMessage[]; trimmed: number; bytesSaved: number } {
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
		if (origBytes <= c.maxResultBytes) {
			out[i] = m;
			continue;
		}
		const stub = makeStub(m.toolName, origBytes, c.mode, origText, c);
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

function computeBudgets(model: Model<any>, reserveTokens: number, c: CompactionConfig): Budgets {
	const ctxWindow = model.contextWindow > 0 ? model.contextWindow : 128000;
	const outBudget = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
	const out = Number.isFinite(outBudget) ? outBudget : Math.floor(0.8 * reserveTokens);
	const usable = Math.floor(ctxWindow * c.usableFraction);
	const single = Math.max(c.minChunkTokens, usable - c.promptOverhead - out);
	const chunk = Math.max(c.minChunkTokens, usable - c.promptOverhead - out - out);
	return { single, chunk };
}

/** Greedy split into consecutive chunks each within `budget` tokens. Never splits a message. */
function planChunks(msgs: AgentMessage[], budget: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let cur: AgentMessage[] = [];
	let curTok = 0;
	for (const m of msgs) {
		const t = estTokens(m);
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

// pi-ai's ProviderHeaders is Record<string, string | null> but generateSummary
// wants Record<string, string>; drop null-valued headers at the boundary.
function normalizeHeaders(h: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!h) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) if (v != null) out[k] = v;
	return out;
}

async function resolveModel(ctx: ExtensionContext): Promise<ResolvedModel | null> {
	if (cfg.modelRef) {
		const parsed = parseModelRef(cfg.modelRef);
		if (!parsed) {
			note(ctx, `compaction: bad PI_COMPACTION_MODEL "${cfg.modelRef}" (want "provider/id") — using session model.`, "warning");
		} else {
			const m = ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (!m) {
				note(ctx, `compaction: model "${cfg.modelRef}" not found — using session model.`, "warning");
			} else {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
				if (auth.ok) return { model: m, apiKey: auth.apiKey, headers: normalizeHeaders(auth.headers) };
				note(ctx, `compaction: no auth for "${cfg.modelRef}" (${auth.error}) — using session model.`, "warning");
			}
		}
	}
	const m = ctx.model;
	if (!m) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
	if (!auth.ok) return null;
	return { model: m, apiKey: auth.apiKey, headers: normalizeHeaders(auth.headers) };
}

// ─── extension entrypoint ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		clearPostTurnTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ── trigger: post-turn ──
	pi.on("agent_end", async (_event, ctx) => {
		schedulePostTurnCompaction(ctx);
	});

	// ── trigger: pre-input fallback ──
	pi.on("input", async (event, ctx) => {
		// Avoid recursively intercepting the prompt replayed by this extension.
		if (event.source === "extension") return { action: "continue" as const };

		postTurnGeneration += 1;
		clearPostTurnTimer();

		const decision = shouldCompact(ctx);
		if (!decision.compact) return { action: "continue" as const };

		const usage = ctx.getContextUsage();
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Auto-compaction: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens; replaying prompt after compact.`,
				"info",
			);
		}

		startCompaction(
			ctx,
			"pre-input",
			() => replayInput(pi, event),
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Auto-compaction failed; sending prompt normally: ${error.message}`, "warning");
				replayInput(pi, event);
			},
		);

		return { action: "handled" as const };
	});

	// ── diet: bounded summarization ──
	pi.on("session_before_compact", async (event, ctx) => {
		if (!dietActive()) return undefined;

		const { preparation, customInstructions } = event;
		const signal = event.signal ?? new AbortController().signal;
		const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (all.length === 0) return undefined; // nothing for us; let default decide

		try {
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
			const summary = await run();
			if (!summary.trim()) {
				if (!signal.aborted) note(ctx, "compaction: empty summary — falling back to default compaction.", "warning");
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
			note(ctx, `compaction: summarization failed (${message}) — falling back to default compaction.`, "error");
			stats.lastFallback = true;
			refreshFooter(ctx);
			return undefined;
		}
	});

	// ─── slash command: /compaction ─────────────────────────────────────────────
	pi.registerCommand("compaction", {
		description:
			"Unified compaction (proactive trigger + bounded summarizer). Subcommands: on | off | trigger on|off | diet on|off | fraction <0.1-0.95> | mode <compress|tear-out> | max <bytes> | model <provider/id|clear> | thinking <level> | show",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();

			if (!args || args === "show" || args === "status") {
				const usage = ctx.getContextUsage();
				const lines: string[] = [];
				lines.push(`enabled:          ${cfg.enabled}`);
				lines.push("");
				lines.push(`trigger:          ${cfg.triggerEnabled}`);
				lines.push(`  fraction:       ${cfg.fraction} (compact at ${Math.round(cfg.fraction * 100)}% of window)`);
				lines.push(`  min context:    ${cfg.minContextWindow} tokens (large-context models only)`);
				lines.push(`  post-turn:      ${cfg.postTurnEnabled}`);
				lines.push(`  current usage:  ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens`);
				lines.push("");
				lines.push(`diet:             ${cfg.dietEnabled}`);
				lines.push(`  mode:           ${cfg.mode}`);
				lines.push(`  max result:     ${cfg.maxResultBytes} bytes`);
				lines.push(`  head/tail:      ${cfg.headBytes} / ${cfg.tailBytes} bytes`);
				lines.push(`  thinking:       ${cfg.thinking}`);
				lines.push(`  usable frac:    ${cfg.usableFraction}`);
				lines.push(`  summary model:  ${cfg.modelRef || "(session model)"}`);
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
				clearPostTurnTimer();
				postTurnGeneration += 1;
				refreshFooter(ctx);
				ctx.ui.notify("compaction OFF — pi's default compaction threshold + summarization apply.", "info");
				return;
			}
			if (sub === "on" || sub === "enable") {
				cfg.enabled = true;
				refreshFooter(ctx);
				ctx.ui.notify(
					`compaction ON — trigger ${cfg.triggerEnabled ? `@${Math.round(cfg.fraction * 100)}%` : "off"}, diet ${cfg.dietEnabled ? "on" : "off"}.`,
					"info",
				);
				return;
			}
			if (sub === "trigger") {
				const v = tail.toLowerCase();
				if (v !== "on" && v !== "off") {
					ctx.ui.notify("Usage: /compaction trigger on|off", "warning");
					return;
				}
				cfg.triggerEnabled = v === "on";
				if (!cfg.triggerEnabled) {
					clearPostTurnTimer();
					postTurnGeneration += 1;
				}
				refreshFooter(ctx);
				ctx.ui.notify(`trigger = ${cfg.triggerEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (sub === "diet") {
				const v = tail.toLowerCase();
				if (v !== "on" && v !== "off") {
					ctx.ui.notify("Usage: /compaction diet on|off", "warning");
					return;
				}
				cfg.dietEnabled = v === "on";
				refreshFooter(ctx);
				ctx.ui.notify(`diet = ${cfg.dietEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (sub === "fraction") {
				const value = Number.parseFloat(tail);
				if (!Number.isFinite(value) || value < 0.1 || value > 0.95) {
					ctx.ui.notify("Usage: /compaction fraction <0.1-0.95>", "warning");
					return;
				}
				cfg.fraction = value;
				refreshFooter(ctx);
				ctx.ui.notify(`fraction = ${cfg.fraction} (compact at ${Math.round(cfg.fraction * 100)}% of window)`, "info");
				return;
			}
			if (sub === "mode") {
				if (tail !== "compress" && tail !== "tear-out") {
					ctx.ui.notify("Usage: /compaction mode compress|tear-out", "warning");
					return;
				}
				cfg.mode = tail;
				ctx.ui.notify(`mode = ${cfg.mode}`, "info");
				return;
			}
			if (sub === "max") {
				const n = Number.parseInt(tail, 10);
				if (!Number.isFinite(n) || n < 256) {
					ctx.ui.notify("Usage: /compaction max <bytes>  (≥256)", "warning");
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
					ctx.ui.notify('Usage: /compaction model <provider/id>  (e.g. "google/gemini-2.5-pro")', "warning");
					return;
				}
				cfg.modelRef = tail;
				ctx.ui.notify(`summary model = ${cfg.modelRef}`, "info");
				return;
			}
			if (sub === "thinking") {
				if (!THINKING_LEVELS.includes(tail)) {
					ctx.ui.notify(`Usage: /compaction thinking <${THINKING_LEVELS.join("|")}>`, "warning");
					return;
				}
				cfg.thinking = tail as ThinkingLevel;
				ctx.ui.notify(`thinking = ${cfg.thinking}`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: ${sub}\n\n` +
					`Usage:\n` +
					`  /compaction                       show config + last-run stats\n` +
					`  /compaction on | off              master enable / disable\n` +
					`  /compaction trigger on | off      proactive early-compaction\n` +
					`  /compaction diet on | off         bounded summarizer\n` +
					`  /compaction fraction <0.1-0.95>   trigger threshold\n` +
					`  /compaction mode compress|tear-out\n` +
					`  /compaction max <bytes>           trim tool results larger than N bytes\n` +
					`  /compaction model <provider/id|clear>\n` +
					`  /compaction thinking <${THINKING_LEVELS.join("|")}>`,
				"warning",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "on", description: "master enable" },
				{ value: "off", description: "master disable" },
				{ value: "trigger", description: "proactive early-compaction on|off" },
				{ value: "diet", description: "bounded summarizer on|off" },
				{ value: "fraction", description: "trigger threshold 0.1-0.95" },
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
	(pi as unknown as { __compactionInternals?: unknown }).__compactionInternals = {
		// trigger
		shouldCompact,
		schedulePostTurnCompaction,
		compactInstructions,
		startCompaction,
		compactionIntentRegistry,
		// diet
		trimForSummary,
		makeStub,
		computeBudgets,
		planChunks,
		parseModelRef,
		tokensOf,
		byteLen,
		normalizeHeaders,
		// state
		cfg,
		stats,
	};
}
