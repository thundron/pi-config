// Context utility tools aligned with Codex core tools.
//
// Ports Codex's `get_context_remaining` tool:
//   codex-rs/core/src/tools/handlers/get_context_remaining.rs
//   codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs
//   codex-rs/core/src/context/token_budget_context.rs
//
// Codex computes remaining tokens as model context window minus active context
// usage and returns `{ tokens_left: integer | null }`. Pi exposes the same
// high-level state to extensions via `ctx.getContextUsage()`, so this extension
// keeps the behavior small and direct.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GetContextRemainingParams = Type.Object({}, { additionalProperties: false });

export interface ContextRemainingResult {
	tokens_left: number | null;
}

export function computeTokensLeft(usage: { tokens: number | null; contextWindow: number } | undefined): number | null {
	if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return null;
	const contextWindow = Number.isFinite(usage.contextWindow) ? usage.contextWindow : 0;
	return Math.max(0, Math.floor(contextWindow - usage.tokens));
}

export function renderContextRemaining(tokensLeft: number | null): string {
	if (tokensLeft === null) return "<token_budget>\nYou have unknown tokens left in this context window.\n</token_budget>";
	return `<token_budget>\nYou have ${tokensLeft} tokens left in this context window.\n</token_budget>`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_context_remaining",
		label: "context remaining",
		description: "Get the remaining tokens in the current context window.",
		promptSnippet: "get_context_remaining: report remaining tokens in the current context window.",
		parameters: GetContextRemainingParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const tokensLeft = computeTokensLeft(ctx.getContextUsage());
			return {
				content: [{ type: "text" as const, text: renderContextRemaining(tokensLeft) }],
				details: { tokens_left: tokensLeft } satisfies ContextRemainingResult,
			};
		},
	});

	(pi as unknown as { __contextToolsInternals?: unknown }).__contextToolsInternals = {
		computeTokensLeft,
		renderContextRemaining,
	};
}
