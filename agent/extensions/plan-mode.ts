/**
 * plan-mode — pi extension that ports codex's `/plan` collaboration mode.
 *
 * "Plan mode" is a read-mostly state where the assistant is steered toward
 * exploration + clarifying questions + producing a `<proposed_plan>` block,
 * with mutating actions (edit / write / file-changing bash) restricted.
 *
 * Pi ships an `examples/extensions/plan-mode/` reference, but its prompt is
 * minimal. This port uses codex's substantially-engineered plan.md template
 * verbatim, so the model gets the same 3-phase workflow (ground → intent →
 * implementation) and the same `<proposed_plan>` finalization contract.
 *
 * Primitives composed:
 *   - pi.registerCommand("plan", …)        — toggle ON
 *   - pi.registerCommand("execute", …)     — toggle OFF (codex's "exit plan")
 *   - pi.setActiveTools(...)               — restrict to read-mostly tools
 *   - pi.on("context", …)                  — prepend codex's plan.md as a system
 *                                            message before each LLM call
 *   - pi.sendMessage({display: false, …})  — persist toggle state across sessions
 *   - pi.on("session_start" / "session_tree") — re-derive plan-mode from branch
 *   - ctx.ui.setStatus("plan-mode", …)     — footer visibility
 *
 * codex source mapped:
 *   collaboration-mode-templates/templates/plan.md → PLAN_MODE_PROMPT (verbatim)
 *   tui/src/collaboration_modes.rs (plan_mask)     → toggle + tool restriction
 *   tui/src/chatwidget/slash_dispatch.rs           → /plan slash command
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Plan-mode prompt (verbatim from codex collaboration-mode-templates) ────

/**
 * Embedded verbatim from codex-rs/collaboration-mode-templates/templates/plan.md
 * so the extension is self-contained.
 *
 * codex source: codex-rs/collaboration-mode-templates/templates/plan.md
 */
const PLAN_MODE_PROMPT = `# Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 — Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system. Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 — Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.

## PHASE 3 — Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2–4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

The final plan must be plan-only, concise by default, and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

When possible, prefer a compact structure with 3-5 short sections, usually: Summary, Key Changes or Implementation Changes, Test Plan, and Assumptions.

Prefer grouped implementation bullets by subsystem or behavior over file-by-file inventories. Mention files only when needed to disambiguate a non-obvious change. Prefer behavior-level descriptions over symbol-by-symbol removal lists.

Keep bullets short and avoid explanatory sub-bullets unless they are needed to prevent ambiguity. Prefer the minimum detail needed for implementation safety, not exhaustive coverage.

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.

If the user stays in Plan mode and asks for revisions after a prior \`<proposed_plan>\`, any new \`<proposed_plan>\` must be a complete replacement.`;

// ─── Read-only tool allowlist while plan-mode is on ────────────────────────

/**
 * Tools kept active in plan mode. `bash` is included because codex's prompt
 * explicitly allows tests / builds / dry-runs that don't mutate repo-tracked
 * files. The prompt does the enforcement; the tool surface is a soft restriction.
 *
 * Hard-restrict tools (`edit`, `write`) are excluded so even a misbehaving
 * model can't fall through the prompt-level guard.
 */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];

const STATUS_KEY = "plan-mode";

// ─── State persistence via custom_message entries ──────────────────────────

interface PlanOnEntry {
	/** Snapshot of active tools at toggle-on time, so /execute can restore. */
	previousTools: string[];
	t: number;
}

interface PlanOffEntry {
	t: number;
}

/**
 * Walk the current branch, return the most recent `plan/on` payload IFF it
 * has no subsequent `plan/off`. That's our signal that plan mode is active.
 */
function findActivePlanOn(ctx: ExtensionContext): PlanOnEntry | undefined {
	const branch = ctx.sessionManager.getBranch();
	let on: PlanOnEntry | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === "plan/on") {
			on = entry.details as PlanOnEntry;
		} else if (entry.customType === "plan/off") {
			on = undefined;
		}
	}
	return on;
}

// ─── Footer ────────────────────────────────────────────────────────────────

function refreshFooter(ctx: ExtensionContext, active: PlanOnEntry | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, active ? "📋 plan mode · /execute to exit" : undefined);
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	/**
	 * In-memory cache, kept in sync with the session entries by the
	 * session_start / session_tree handlers. Avoids walking the branch on
	 * every `context` event (which fires before every LLM call).
	 */
	let active: PlanOnEntry | undefined;

	const recompute = (ctx: ExtensionContext): void => {
		active = findActivePlanOn(ctx);
		refreshFooter(ctx, active);
	};

	pi.on("session_start", async (_event, ctx) => {
		recompute(ctx);
		// On a fresh session_start with plan-mode persisted, re-apply the tool
		// restriction. Tools are session-scoped in pi, so a resume needs to
		// re-restrict explicitly.
		if (active) {
			try {
				pi.setActiveTools(PLAN_MODE_TOOLS);
			} catch {
				/* tools registry may not be ready in print mode; ignore */
			}
		}
	});

	pi.on("session_tree", async (_event, ctx) => recompute(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	/**
	 * Prepend codex's plan.md prompt as a synthetic assistant-side system
	 * message before every LLM call. This is the mechanism by which pi enforces
	 * the plan-mode behavior on the model (codex does the equivalent at the
	 * session-config layer via collaboration-mode-templates).
	 *
	 * We use the `user` role with a clear marker prefix because pi's
	 * AgentMessage union doesn't include a dedicated `system` role; the user
	 * role with a synthetic-message marker is the closest portable analog.
	 */
	pi.on("context", async (event, _ctx) => {
		if (!active) return; // pass through unchanged
		const planMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: PLAN_MODE_PROMPT }],
			timestamp: Date.now(),
		};
		// Prepend so the model sees plan-mode guidance ahead of normal context.
		return { messages: [planMessage, ...event.messages] };
	});

	/**
	 * /plan — enter plan mode.
	 *
	 * Idempotent: re-running while already in plan mode is a friendly notify.
	 */
	pi.registerCommand("plan", {
		description:
			"Enter plan mode: restrict to read-mostly tools and steer the model toward a structured plan (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (active) {
				ctx.ui.notify("Already in plan mode. /execute to exit.", "info");
				return;
			}
			const previousTools = ctx.hasUI || true ? safeGetActiveTools(pi) : [];
			pi.sendMessage<PlanOnEntry>({
				customType: "plan/on",
				content: "plan mode enabled",
				display: false,
				details: { previousTools, t: Date.now() },
			});
			try {
				pi.setActiveTools(PLAN_MODE_TOOLS);
			} catch (err) {
				ctx.ui.notify(
					`Plan mode toggled but tool restriction failed: ${
						err instanceof Error ? err.message : err
					}`,
					"warning",
				);
			}
			active = { previousTools, t: Date.now() };
			refreshFooter(ctx, active);
			ctx.ui.notify(
				`📋 Plan mode ON. Tools restricted to: ${PLAN_MODE_TOOLS.join(", ")}. ` +
					`/execute to exit.`,
				"info",
			);
		},
	});

	/**
	 * /execute — exit plan mode, restore the previous tool set.
	 */
	pi.registerCommand("execute", {
		description: "Exit plan mode and restore the previous tool set (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!active) {
				ctx.ui.notify("Not in plan mode. /execute is a no-op.", "info");
				return;
			}
			const restoreTo =
				active.previousTools.length > 0 ? active.previousTools : ["read", "bash", "edit", "write"];
			pi.sendMessage<PlanOffEntry>({
				customType: "plan/off",
				content: "plan mode disabled",
				display: false,
				details: { t: Date.now() },
			});
			try {
				pi.setActiveTools(restoreTo);
			} catch (err) {
				ctx.ui.notify(
					`Plan mode toggled off but tool restore failed: ${
						err instanceof Error ? err.message : err
					}`,
					"warning",
				);
			}
			active = undefined;
			refreshFooter(ctx, active);
			ctx.ui.notify(`📋 Plan mode OFF. Tools restored to: ${restoreTo.join(", ")}.`, "info");
		},
	});
}

function safeGetActiveTools(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return [];
	}
}
