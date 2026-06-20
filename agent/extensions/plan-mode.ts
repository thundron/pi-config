/**
 * plan-mode — pi extension that ports codex's collaboration-mode templates.
 *
 * "Plan mode" is a read-mostly state where the assistant is steered toward
 * exploration + clarifying questions + producing a `<proposed_plan>` block,
 * with mutating actions (edit / write / file-changing bash) restricted. This
 * extension also exposes Codex-style `/mode default|plan|execute|pair` behavior
 * using `<collaboration_mode>...</collaboration_mode>` context markers.
 *
 * Pi ships an `examples/extensions/plan-mode/` reference, but its prompt is
 * minimal. This port uses codex's substantially-engineered plan.md template
 * verbatim, so the model gets the same 3-phase workflow (ground → intent →
 * implementation) and the same `<proposed_plan>` finalization contract.
 *
 * Primitives composed:
 *   - pi.registerCommand("plan", …)        — toggle ON
 *   - pi.registerCommand("execute", …)     — toggle OFF + enter execute style
 *   - pi.registerCommand("mode", …)        — Codex collaboration modes
 *   - pi.setActiveTools(...)               — restrict to read-mostly tools
 *   - pi.on("context", …)                  — prepend codex's plan.md as a system
 *                                            message before each LLM call
 *   - pi.sendMessage({display: false, …})  — persist toggle state across sessions
 *   - pi.on("session_start" / "session_tree") — re-derive plan-mode from branch
 *   - ctx.ui.setStatus("plan-mode", …)     — footer visibility
 *
 * codex source mapped:
 *   collaboration-mode-templates/templates/plan.md → PLAN_MODE_PROMPT (verbatim)
 *   collaboration-mode-templates/templates/{default,execute,pair_programming}.md
 *   core/src/context/collaboration_mode_instructions.rs
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

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

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

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 — Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.

## PHASE 3 — Implementation chat (what/how we’ll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`request_user_input\` tool to ask any questions.
* Offer only meaningful multiple‑choice options; don’t include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can’t be expressed with reasonable multiple‑choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`request_user_input\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., “where is this struct”).

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

plan content should be human and agent digestible. The final plan must be plan-only, concise by default, and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

When possible, prefer a compact structure with 3-5 short sections, usually: Summary, Key Changes or Implementation Changes, Test Plan, and Assumptions. Do not include a separate Scope section unless scope boundaries are genuinely important to avoid mistakes.

Prefer grouped implementation bullets by subsystem or behavior over file-by-file inventories. Mention files only when needed to disambiguate a non-obvious change, and avoid naming more than 3 paths unless extra specificity is necessary to prevent mistakes. Prefer behavior-level descriptions over symbol-by-symbol removal lists. For v1 feature-addition plans, do not invent detailed schema, validation, precedence, fallback, or wire-shape policy unless the request establishes it or it is needed to prevent a concrete implementation mistake; prefer the intended capability and minimum interface/behavior changes.

Keep bullets short and avoid explanatory sub-bullets unless they are needed to prevent ambiguity. Prefer the minimum detail needed for implementation safety, not exhaustive coverage. Within each section, compress related changes into a few high-signal bullets and omit branch-by-branch logic, repeated invariants, and long lists of unaffected behavior unless they are necessary to prevent a likely implementation mistake. Avoid repeated repo facts and irrelevant edge-case or rollout detail. For straightforward refactors, keep the plan to a compact summary, key edits, tests, and assumptions. If the user asks for more detail, then expand.

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.

If the user stays in Plan mode and asks for revisions after a prior \`<proposed_plan>\`, any new \`<proposed_plan>\` must be a complete replacement.`;

const KNOWN_MODE_NAMES = "default, plan, execute, pair";
type CollaborationMode = "default" | "plan" | "execute" | "pair";

const DEFAULT_MODE_PROMPT = `# Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are default, plan, execute, pair.

## request_user_input availability

Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.`;

const EXECUTE_MODE_PROMPT = `# Collaboration Style: Execute
You execute on a well-specified task independently and report progress.

You do not collaborate on decisions in this mode. You execute end-to-end.
You make reasonable assumptions when the user hasn't specified something, and you proceed without asking questions.

## Assumptions-first execution
When information is missing, do not ask the user questions.
Instead:
- Make a sensible assumption.
- Clearly state the assumption in the final message (briefly).
- Continue executing.

Group assumptions logically, for example architecture/frameworks/implementation, features/behavior, design/themes/feel.
If the user does not react to a proposed suggestion, consider it accepted.

## Execution principles
*Think out loud.* Share reasoning when it helps the user evaluate tradeoffs. Keep explanations short and grounded in consequences. Avoid design lectures or exhaustive option lists.

*Use reasonable assumptions.* When the user hasn't specified something, suggest a sensible choice instead of asking an open-ended question. Group your assumptions logically, for example architecture/frameworks/implementation, features/behavior, design/themes/feel. Clearly label suggestions as provisional. Share reasoning when it helps the user evaluate tradeoffs. Keep explanations short and grounded in consequences. They should be easy to accept or override. If the user does not react to a proposed suggestion, consider it accepted.

Example: "There are a few viable ways to structure this. A plugin model gives flexibility but adds complexity; a simpler core with extension points is easier to reason about. Given what you've said about your team's size, I'd lean towards the latter."
Example: "If this is a shared internal library, I'll assume API stability matters more than rapid iteration."

*Think ahead.* What else might the user need? How will the user test and understand what you did? Think about ways to support them and propose things they might need BEFORE you build. Offer at least one suggestion you came up with by thinking ahead.
Example: "This feature changes as time passes but you probably want to test it without waiting for a full hour to pass. I'll include a debug mode where you can move through states without just waiting."

*Be mindful of time.* The user is right here with you. Any time you spend reading files or searching for information is time that the user is waiting for you. Do make use of these tools if helpful, but minimize the time the user is waiting for you. As a rule of thumb, spend only a few seconds on most turns and no more than 60 seconds when doing research. If you are missing information and would normally ask, make a reasonable assumption and continue.
Example: "I checked the readme and searched for the feature you mentioned, but didn't find it immediately. I'll proceed with the most likely implementation and verify behavior with a quick test."

## Long-horizon execution
Treat the task as a sequence of concrete steps that add up to a complete delivery.
- Break the work into milestones that move the task forward in a visible way.
- Execute step by step, verifying along the way rather than doing everything at the end.
- If the task is large, keep a running checklist of what is done, what is next, and what is blocked.
- Avoid blocking on uncertainty: choose a reasonable default and continue.

## Reporting progress
In this phase you show progress on your task and appraise the user of your progress using plan tool.
- Provide updates that directly map to the work you are doing (what changed, what you verified, what remains).
- If something fails, report what failed, what you tried, and what you will do next.
- When you finish, summarize what you delivered and how the user can validate it.

## Executing
Once you start working, you should execute independently. Your job is to deliver the task and report progress.`;

const PAIR_PROGRAMMING_MODE_PROMPT = `# Collaboration Style: Pair Programming

## Build together as you go
You treat collaboration as pairing by default. The user is right with you in the terminal, so avoid taking steps that are too large or take a lot of time (like running long tests), unless asked for it. You check for alignment and comfort before moving forward, explain reasoning step by step, and dynamically adjust depth based on the user's signals. There is no need to ask multiple rounds of questions—build as you go. When there are multiple viable paths, you present clear options with friendly framing, ground them in examples and intuition, and explicitly invite the user into the decision so the choice feels empowering rather than burdensome. When you do more complex work you use the planning tool liberally to keep the user updated on what you are doing.

## Debugging
If you are debugging something with the user, assume you are a team. You can ask them what they see and ask them to provide you with information you don't have access to, for example you can ask them to check error messages in developer tools or provide you with screenshots.`;

function collaborationPrompt(mode: CollaborationMode): string {
	const body = mode === "plan"
		? PLAN_MODE_PROMPT
		: mode === "execute"
			? EXECUTE_MODE_PROMPT
			: mode === "pair"
				? PAIR_PROGRAMMING_MODE_PROMPT
				: DEFAULT_MODE_PROMPT;
	return `<collaboration_mode>\n${body}\n</collaboration_mode>`;
}

function parseCollaborationMode(raw: string): CollaborationMode | undefined {
	const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
	if (v === "default") return "default";
	if (v === "plan") return "plan";
	if (v === "execute" || v === "exec") return "execute";
	if (v === "pair" || v === "pairprogramming") return "pair";
	return undefined;
}

function collaborationModeLabel(mode: CollaborationMode): string {
	return mode === "pair" ? "pair programming" : mode;
}

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

interface CollaborationModeEntry {
	mode: CollaborationMode;
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

function findActiveCollaborationMode(ctx: ExtensionContext): CollaborationMode | undefined {
	let mode: CollaborationMode | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === "collaboration/mode") {
			const details = entry.details as Partial<CollaborationModeEntry>;
			if (details.mode === "default" || details.mode === "plan" || details.mode === "execute" || details.mode === "pair") {
				mode = details.mode;
			}
		} else if (entry.customType === "plan/on") {
			mode = "plan";
		} else if (entry.customType === "plan/off" && mode === "plan") {
			mode = undefined;
		}
	}
	return mode;
}

// ─── Footer ────────────────────────────────────────────────────────────────

function refreshFooter(ctx: ExtensionContext, active: PlanOnEntry | undefined, mode: CollaborationMode | undefined): void {
	if (!ctx.hasUI) return;
	if (active) {
		ctx.ui.setStatus(STATUS_KEY, "📋 plan mode · /execute to exit");
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, mode ? `🤝 ${collaborationModeLabel(mode)}` : undefined);
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	/**
	 * In-memory cache, kept in sync with the session entries by the
	 * session_start / session_tree handlers. Avoids walking the branch on
	 * every `context` event (which fires before every LLM call).
	 */
	let active: PlanOnEntry | undefined;
	let activeMode: CollaborationMode | undefined;

	const recompute = (ctx: ExtensionContext): void => {
		active = findActivePlanOn(ctx);
		activeMode = active ? "plan" : findActiveCollaborationMode(ctx);
		refreshFooter(ctx, active, activeMode);
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
		const mode = active ? "plan" : activeMode;
		if (!mode) return; // pass through unchanged
		const modeMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: collaborationPrompt(mode) }],
			timestamp: Date.now(),
		};
		// Prepend so the model sees collaboration-mode guidance ahead of normal context.
		return { messages: [modeMessage, ...event.messages] };
	});

	/**
	 * /plan — enter plan mode.
	 *
	 * Idempotent: re-running while already in plan mode is a friendly notify.
	 */
	const enterPlanMode = (ctx: ExtensionCommandContext): void => {
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
		activeMode = "plan";
		refreshFooter(ctx, active, activeMode);
		ctx.ui.notify(
			`📋 Plan mode ON. Tools restricted to: ${PLAN_MODE_TOOLS.join(", ")}. ` +
				`/execute to exit.`,
			"info",
		);
	};

	const exitPlanMode = (ctx: ExtensionCommandContext): string[] => {
		const restoreTo = active?.previousTools && active.previousTools.length > 0
			? active.previousTools
			: ["read", "bash", "edit", "write"];
		if (active) {
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
		}
		active = undefined;
		return restoreTo;
	};

	const setCollaborationMode = (mode: CollaborationMode, ctx: ExtensionCommandContext): void => {
		if (mode === "plan") {
			enterPlanMode(ctx);
			return;
		}
		const restoreTo = exitPlanMode(ctx);
		pi.sendMessage<CollaborationModeEntry>({
			customType: "collaboration/mode",
			content: `collaboration mode ${collaborationModeLabel(mode)}`,
			display: false,
			details: { mode, t: Date.now() },
		});
		activeMode = mode;
		refreshFooter(ctx, active, activeMode);
		ctx.ui.notify(
			mode === "execute"
				? `Collaboration mode set to execute. Tools restored to: ${restoreTo.join(", ")}.`
				: `Collaboration mode set to ${collaborationModeLabel(mode)}.`,
			"info",
		);
	};

	pi.registerCommand("plan", {
		description:
			"Enter plan mode: restrict to read-mostly tools and steer the model toward a structured plan (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => enterPlanMode(ctx),
	});

	/**
	 * /execute — exit plan mode, restore the previous tool set.
	 */
	pi.registerCommand("execute", {
		description: "Exit plan mode, restore tools, and enter Codex execute collaboration style.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => setCollaborationMode("execute", ctx),
	});

	pi.registerCommand("mode", {
		description: "Set Codex collaboration mode: default | plan | execute | pair",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();
			if (!args || args === "show" || args === "status") {
				ctx.ui.notify(
					`collaboration mode: ${activeMode ? collaborationModeLabel(activeMode) : "unset"}\nknown modes: ${KNOWN_MODE_NAMES}\nset with: /mode default | plan | execute | pair`,
					"info",
				);
				return;
			}
			const mode = parseCollaborationMode(args);
			if (!mode) {
				ctx.ui.notify("Usage: /mode default | plan | execute | pair", "warning");
				return;
			}
			setCollaborationMode(mode, ctx);
		},
		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const opts = [
				{ value: "default", description: "Codex default collaboration mode" },
				{ value: "plan", description: "Plan mode" },
				{ value: "execute", description: "Assumptions-first execution mode" },
				{ value: "pair", description: "Pair-programming mode" },
			];
			const p = prefix.trim().toLowerCase();
			return opts.filter((o) => o.value.startsWith(p)).map((o) => ({ value: o.value, label: o.value, description: o.description }));
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
