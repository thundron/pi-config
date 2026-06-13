// Tool-call/result pairing guard for pi (Anthropic provider).
//
// WHY THIS EXISTS
// ---------------
// pi-core's provider layer reshapes the on-disk history right before the API
// call (pi-ai/providers/transform-messages.js → anthropic.js). Two of those
// transforms can orphan a `tool_result`:
//
//   1. transformMessages' second pass DROPS any assistant message whose
//      stopReason is "error" or "aborted" (an incomplete turn). That deletes
//      the assistant's `tool_use` blocks — but the `toolResult` messages that
//      followed are kept.
//   2. convertMessages drops an assistant message whose content is empty after
//      block-filtering (`if (blocks.length === 0) continue`), with the same
//      effect.
//
// transformMessages only synthesizes results for orphaned tool *calls*; it
// never removes orphaned tool *results*. So anthropic.js emits a `user` message
// with a `tool_result` block whose `tool_use_id` references a now-deleted
// `tool_use`, and Anthropic rejects the request:
//
//   400 invalid_request_error — messages.N.content.M: unexpected `tool_use_id`
//   found in `tool_result` blocks: <id>. Each `tool_result` block must have a
//   corresponding `tool_use` block in the previous message.
//
// This is amplified by long autonomous runs (goal-mode auto-continues across
// rate-limit/error turns, i.e. exactly the errored-assistant-with-tool-calls
// states core drops), so it reads as "the diet extensions broke things" even
// though the diet extensions preserve structure 1:1.
//
// WHAT THIS DOES
// --------------
// Hooks `before_provider_request` — the LAST interception point, operating on
// the fully-built Anthropic payload (after transformMessages + convertMessages).
// It repairs the payload in place so the pairing invariant always holds:
//
//   • Drops `tool_result` blocks whose `tool_use_id` has no matching `tool_use`
//     in the immediately-preceding message (the orphan that triggers the 400).
//     A user message emptied by this is removed entirely.
//   • Defensively backfills a synthetic `tool_result` for any `tool_use` that
//     isn't answered in the next message (the mirror-image 400), so our own
//     edits can never leave a dangling call.
//   • Preserves `cache_control` by re-homing it onto the new last content block
//     when the block that carried it is removed.
//
// Provider-agnostic by construction: if the payload isn't Anthropic-shaped
// (no tool_use/tool_result blocks anywhere) it is a no-op.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tool-pairing-guard";

const ENABLED = process.env.PI_TOOL_PAIRING_GUARD_DISABLE !== "1";

// ─── payload shape (duck-typed; Anthropic Messages API) ──────────────────────

interface Block {
	type?: string;
	id?: string; // tool_use
	tool_use_id?: string; // tool_result
	name?: string; // tool_use
	cache_control?: unknown;
	[k: string]: unknown;
}

interface Msg {
	role?: string;
	content?: string | Block[];
	[k: string]: unknown;
}

interface Payload {
	messages?: Msg[];
	[k: string]: unknown;
}

interface GuardStats {
	calls: number;
	orphanResultsDropped: number;
	emptyMessagesDropped: number;
	syntheticResultsAdded: number;
	lastRepaired: number;
}

function emptyStats(): GuardStats {
	return {
		calls: 0,
		orphanResultsDropped: 0,
		emptyMessagesDropped: 0,
		syntheticResultsAdded: 0,
		lastRepaired: 0,
	};
}

function blocksOf(m: Msg | undefined): Block[] | null {
	if (!m || !Array.isArray(m.content)) return null;
	return m.content as Block[];
}

function toolUseIds(m: Msg | undefined): Set<string> {
	const ids = new Set<string>();
	const blocks = blocksOf(m);
	if (!blocks) return ids;
	for (const b of blocks) {
		if (b && b.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
	}
	return ids;
}

function hasToolBlocks(messages: Msg[]): boolean {
	for (const m of messages) {
		const blocks = blocksOf(m);
		if (!blocks) continue;
		for (const b of blocks) {
			if (b && (b.type === "tool_use" || b.type === "tool_result")) return true;
		}
	}
	return false;
}

/**
 * Carry `cache_control` from a removed last-block forward onto whatever block
 * now sits at the end of the last user message. Anthropic only allows a small
 * number of cache breakpoints and pins them to the final user turn, so losing
 * one is harmless (it just reduces cache hits), but moving it keeps caching
 * working after a repair.
 */
function rehomeCacheControl(messages: Msg[], salvaged?: unknown): void {
	let cc: unknown = salvaged;
	for (const m of messages) {
		const blocks = blocksOf(m);
		if (!blocks) continue;
		for (const b of blocks) {
			if (b && b.cache_control !== undefined) {
				cc = b.cache_control;
				delete b.cache_control;
			}
		}
	}
	if (cc === undefined) return;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		const blocks = blocksOf(messages[i]);
		if (!blocks || blocks.length === 0) continue;
		blocks[blocks.length - 1].cache_control = cc;
		return;
	}
}

export interface RepairResult {
	messages: Msg[];
	orphanResultsDropped: number;
	emptyMessagesDropped: number;
	syntheticResultsAdded: number;
}

/**
 * Repair an Anthropic-shaped message list so every tool_result has a matching
 * tool_use in the previous message and every tool_use is answered in the next.
 * Pure (no mutation of inputs at the array level beyond rebuilding); returns a
 * new array. Returns the input unchanged when there are no tool blocks.
 */
export function repairToolPairing(messagesIn: Msg[]): RepairResult {
	if (!Array.isArray(messagesIn) || !hasToolBlocks(messagesIn)) {
		return {
			messages: messagesIn,
			orphanResultsDropped: 0,
			emptyMessagesDropped: 0,
			syntheticResultsAdded: 0,
		};
	}

	let orphanResultsDropped = 0;
	let emptyMessagesDropped = 0;
	let syntheticResultsAdded = 0;
	// cache_control salvaged from any dropped block, so a repair never silently
	// discards the conversation cache breakpoint.
	let salvagedCacheControl: unknown;

	// ── Pass 1: drop orphaned tool_result blocks ────────────────────────────
	// "Orphaned" = tool_use_id not present in the immediately-preceding message
	// (which, per Anthropic's rule, must be the assistant turn that made the
	// call). Drop the message entirely if it ends up with no content.
	const pass1: Msg[] = [];
	for (let i = 0; i < messagesIn.length; i++) {
		const m = messagesIn[i];
		const blocks = blocksOf(m);
		if (!blocks) {
			pass1.push(m);
			continue;
		}
		const hasResults = blocks.some((b) => b && b.type === "tool_result");
		if (!hasResults) {
			pass1.push(m);
			continue;
		}
		const prev = pass1.length > 0 ? pass1[pass1.length - 1] : undefined;
		const allowed = prev && prev.role === "assistant" ? toolUseIds(prev) : new Set<string>();
		const kept: Block[] = [];
		for (const b of blocks) {
			if (b && b.type === "tool_result") {
				const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
				if (!allowed.has(id)) {
					if (b.cache_control !== undefined) salvagedCacheControl = b.cache_control;
					orphanResultsDropped += 1;
					continue;
				}
			}
			kept.push(b);
		}
		if (kept.length === 0) {
			emptyMessagesDropped += 1;
			continue; // drop the now-empty message
		}
		pass1.push(kept.length === blocks.length ? m : { ...m, content: kept });
	}

	// ── Pass 2: backfill synthetic results for unanswered tool_use blocks ────
	// Guarantees our own edits never leave a dangling tool_use (the mirror 400).
	const pass2: Msg[] = [];
	for (let i = 0; i < pass1.length; i++) {
		const m = pass1[i];
		pass2.push(m);
		if (m.role !== "assistant") continue;
		const ids = toolUseIds(m);
		if (ids.size === 0) continue;

		const next = pass1[i + 1];
		const answered = new Set<string>();
		const nextBlocks = blocksOf(next);
		if (next && next.role === "user" && nextBlocks) {
			for (const b of nextBlocks) {
				if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") {
					answered.add(b.tool_use_id);
				}
			}
		}
		const missing = [...ids].filter((id) => !answered.has(id));
		if (missing.length === 0) continue;

		const synthetic: Block[] = missing.map((id) => ({
			type: "tool_result",
			tool_use_id: id,
			content: "[tool-pairing-guard: no result captured for this call]",
			is_error: true,
		}));
		syntheticResultsAdded += synthetic.length;

		if (next && next.role === "user" && nextBlocks) {
			// Inject into the existing following user message (mutate a copy).
			const merged = { ...next, content: [...synthetic, ...nextBlocks] };
			pass1[i + 1] = merged; // so the next loop iteration sees the merged copy
		} else {
			// No following user message — insert one right after this assistant.
			pass2.push({ role: "user", content: synthetic });
		}
	}

	if (orphanResultsDropped > 0 || emptyMessagesDropped > 0) {
		rehomeCacheControl(pass2, salvagedCacheControl);
	}

	return {
		messages: pass2,
		orphanResultsDropped,
		emptyMessagesDropped,
		syntheticResultsAdded,
	};
}

// ─── extension entrypoint ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const stats = emptyStats();
	let enabled = ENABLED;

	function refreshFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, "🔗 pairing-guard OFF");
			return;
		}
		const repaired = stats.orphanResultsDropped + stats.syntheticResultsAdded;
		if (repaired === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined); // invisible until it actually does something
			return;
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			`🔗 ${stats.orphanResultsDropped} orphan / ${stats.syntheticResultsAdded} synth`,
		);
	}

	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!enabled) return undefined;
		const payload = event.payload as Payload | undefined;
		if (!payload || !Array.isArray(payload.messages)) return undefined;

		const result = repairToolPairing(payload.messages);
		stats.calls += 1;
		stats.lastRepaired =
			result.orphanResultsDropped + result.emptyMessagesDropped + result.syntheticResultsAdded;
		if (stats.lastRepaired === 0) return undefined; // nothing to fix → pass through

		stats.orphanResultsDropped += result.orphanResultsDropped;
		stats.emptyMessagesDropped += result.emptyMessagesDropped;
		stats.syntheticResultsAdded += result.syntheticResultsAdded;
		refreshFooter(ctx);

		if (ctx.hasUI) {
			const parts: string[] = [];
			if (result.orphanResultsDropped) parts.push(`${result.orphanResultsDropped} orphaned tool_result(s) dropped`);
			if (result.emptyMessagesDropped) parts.push(`${result.emptyMessagesDropped} empty message(s) removed`);
			if (result.syntheticResultsAdded) parts.push(`${result.syntheticResultsAdded} synthetic result(s) added`);
			ctx.ui.notify(`tool-pairing-guard repaired the request: ${parts.join(", ")}.`, "info");
		}

		return { ...payload, messages: result.messages };
	});

	pi.registerCommand("tool-pairing-guard", {
		description:
			"Repairs orphaned tool_use/tool_result pairs in the Anthropic payload. Subcommands: on | off | show",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();
			if (args === "on") {
				enabled = true;
				refreshFooter(ctx);
				if (ctx.hasUI) ctx.ui.notify("tool-pairing-guard: ON", "info");
				return;
			}
			if (args === "off") {
				enabled = false;
				refreshFooter(ctx);
				if (ctx.hasUI) ctx.ui.notify("tool-pairing-guard: OFF", "info");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					[
						`enabled:                  ${enabled}`,
						`calls processed:          ${stats.calls}`,
						`orphan results dropped:   ${stats.orphanResultsDropped}`,
						`empty messages dropped:   ${stats.emptyMessagesDropped}`,
						`synthetic results added:  ${stats.syntheticResultsAdded}`,
					].join("\n"),
					"info",
				);
			}
		},
	});

	// Back-door for unit tests (loaded via dynamic import).
	(pi as unknown as { __toolPairingGuardInternals?: unknown }).__toolPairingGuardInternals = {
		repairToolPairing,
		hasToolBlocks,
		toolUseIds,
		rehomeCacheControl,
	};
}
