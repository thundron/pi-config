// Proactive auto-compaction for very large-context models.
//
// Pi core compacts at `contextWindow - reserveTokens` (default reserve: 16k),
// which means 1M-token models wait until ~984k tokens. This extension adds a
// hook-level policy for large models only: before a user prompt is processed,
// compact at a configurable fraction (default 50%) and then replay the prompt.

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

interface LargeContextAutocompactConfig {
	enabled: boolean;
	minContextWindow: number;
	fraction: number;
	postTurnEnabled: boolean;
	postTurnDelayMs: number;
}

const STATUS_KEY = "large-context-autocompact";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFraction(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

const cfg: LargeContextAutocompactConfig = {
	enabled: process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_DISABLE !== "1",
	minContextWindow: envInt("PI_LARGE_CONTEXT_AUTOCOMPACT_MIN_CONTEXT", 1_000_000),
	fraction: envFraction("PI_LARGE_CONTEXT_AUTOCOMPACT_FRACTION", 0.5),
	postTurnEnabled: process.env.PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DISABLE !== "1",
	postTurnDelayMs: envInt("PI_LARGE_CONTEXT_AUTOCOMPACT_POST_TURN_DELAY_MS", 250),
};

let compactionInFlight = false;
let postTurnTimer: NodeJS.Timeout | undefined;
let postTurnGeneration = 0;

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
	if (!cfg.enabled) return { compact: false, reason: "disabled" };
	if (!ctx.isIdle()) return { compact: false, reason: "busy" };
	if (compactionInFlight) return { compact: false, reason: "in-flight" };
	if (ctx.hasPendingMessages()) return { compact: false, reason: "pending-messages" };

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return { compact: false, reason: "unknown" };
	if (usage.contextWindow < cfg.minContextWindow) return { compact: false, reason: "small-context" };

	const threshold = Math.floor(usage.contextWindow * cfg.fraction);
	return { compact: usage.tokens >= threshold };
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

function compactInstructions(mode: "pre-input" | "post-turn"): string {
	return mode === "pre-input"
		? "Preserve all current goals, active decisions, file edits, commands run, test results, blockers, and the exact user prompt that triggered this proactive large-context compaction."
		: "Preserve all current goals, active decisions, file edits, commands run, test results, blockers, and the exact state at the end of the just-finished assistant turn. This proactive large-context compaction is running after the turn settled so the next user prompt does not have to wait for compaction.";
}

function startCompaction(
	ctx: ExtensionContext,
	mode: "pre-input" | "post-turn",
	onComplete?: () => void,
	onError?: (error: Error) => void,
): void {
	compactionInFlight = true;
	// Publish intent BEFORE ctx.compact() — pi starts refusing prompts inside
	// that call, well before any extension event announces the compaction.
	const releaseIntent = beginCompactionIntent();
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
}

function schedulePostTurnCompaction(ctx: ExtensionContext): void {
	if (!cfg.enabled || !cfg.postTurnEnabled) return;
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
				`Large-context post-turn auto-compaction: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens; compacting before the next prompt.`,
				"info",
			);
		}
		startCompaction(ctx, "post-turn", undefined, (error) => {
			if (ctx.hasUI) ctx.ui.notify(`Large-context post-turn auto-compaction failed: ${error.message}`, "warning");
		});
	}, cfg.postTurnDelayMs);
	if (typeof postTurnTimer.unref === "function") postTurnTimer.unref();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(
				STATUS_KEY,
				cfg.enabled ? `LC compact @${Math.round(cfg.fraction * 100)}%` : undefined,
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearPostTurnTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		schedulePostTurnCompaction(ctx);
	});

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
				`Large-context auto-compaction: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens; replaying prompt after compact.`,
				"info",
			);
		}

		startCompaction(
			ctx,
			"pre-input",
			() => replayInput(pi, event),
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Large-context auto-compaction failed; sending prompt normally: ${error.message}`, "warning");
				replayInput(pi, event);
			},
		);

		return { action: "handled" as const };
	});

	(pi as unknown as { __largeContextAutocompactInternals?: unknown }).__largeContextAutocompactInternals = {
		cfg,
		shouldCompact,
		schedulePostTurnCompaction,
		compactInstructions,
		startCompaction,
		compactionIntentRegistry,
	};
}
