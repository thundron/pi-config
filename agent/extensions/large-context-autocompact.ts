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
};

let compactionInFlight = false;

function shouldCompact(ctx: ExtensionContext): { compact: boolean; reason?: string } {
	if (!cfg.enabled) return { compact: false, reason: "disabled" };
	if (!ctx.isIdle()) return { compact: false, reason: "busy" };
	if (compactionInFlight) return { compact: false, reason: "in-flight" };

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
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("input", async (event, ctx) => {
		// Avoid recursively intercepting the prompt replayed by this extension.
		if (event.source === "extension") return { action: "continue" as const };

		const decision = shouldCompact(ctx);
		if (!decision.compact) return { action: "continue" as const };

		const usage = ctx.getContextUsage();
		compactionInFlight = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Large-context auto-compaction: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens; replaying prompt after compact.`,
				"info",
			);
		}

		ctx.compact({
			customInstructions: "Preserve all current goals, active decisions, file edits, commands run, test results, blockers, and the exact user prompt that triggered this proactive large-context compaction.",
			onComplete: () => {
				compactionInFlight = false;
				replayInput(pi, event);
			},
			onError: (error) => {
				compactionInFlight = false;
				if (ctx.hasUI) ctx.ui.notify(`Large-context auto-compaction failed; sending prompt normally: ${error.message}`, "warning");
				replayInput(pi, event);
			},
		});

		return { action: "handled" as const };
	});

	(pi as unknown as { __largeContextAutocompactInternals?: unknown }).__largeContextAutocompactInternals = {
		cfg,
		shouldCompact,
	};
}
