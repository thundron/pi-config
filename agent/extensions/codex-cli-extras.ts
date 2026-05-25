/**
 * codex-cli-extras — small codex slash commands ported to pi as a grab-bag.
 *
 * Each command in here is a small standalone port from codex's TUI. Larger
 * features get their own extension file (see goal-mode.ts, subagents.ts).
 *
 * Currently exposes:
 *   /diff     — git diff including untracked files
 *   /init     — generate AGENTS.md with project context
 *   /review   — review code changes (uncommitted / base / commit / custom)
 *   /rollout       — print the session JSONL path (codex `/rollout`)
 *   /feedback      — print where + how to file feedback (codex `/feedback`)
 *   /test-approval — exercise pi's confirm + select dialogs (codex `/test-approval`)
 *
 * Port plan tracker: ~/dev/pi-config/PORT-PLAN.md
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import { exec as execCb } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execCb);
const DIFF_TIMEOUT_MS = 30_000;

// ─── /diff ──────────────────────────────────────────────────────────────────

/**
 * Port of codex's `tui/src/get_git_diff.rs` SlashCommand::Diff.
 *
 * Behavior (matches codex):
 *   1. Check we're inside a git repo (`git rev-parse --is-inside-work-tree`).
 *      If not, report and exit.
 *   2. Run `git diff --color` for tracked changes.
 *   3. Run `git ls-files --others --exclude-standard` to find untracked files.
 *   4. For each untracked file, run `git diff --color --no-index -- <null> <file>`
 *      to produce a "new file" diff against /dev/null.
 *   5. Concatenate tracked + untracked diffs, emit via ctx.ui.notify so the
 *      output is selectable / scrollable in pi's TUI.
 *
 * Differences from codex:
 *   - Codex's TUI renders into a dedicated diff view; pi's extension API
 *     emits via the notify mechanism (multi-line, info-level). For long
 *     diffs the TUI will scroll; for very long diffs prefer `git diff` in
 *     a terminal directly.
 *   - Codex parallelizes tracked + untracked listing via tokio::join. Here
 *     we use Promise.all to the same effect.
 */
async function runGitDiff(cwd: string): Promise<{
	inRepo: boolean;
	text: string;
	error?: string;
}> {
	// Step 1: are we in a git repo?
	try {
		const { stdout } = await execAsync("git rev-parse --is-inside-work-tree", {
			cwd,
			timeout: DIFF_TIMEOUT_MS,
		});
		if (stdout.trim() !== "true") return { inRepo: false, text: "" };
	} catch {
		return { inRepo: false, text: "" };
	}

	// Step 2 + 3: tracked diff + untracked listing in parallel.
	let trackedDiff = "";
	let untrackedList = "";
	try {
		const results = await Promise.all([
			runGitCapture(cwd, ["diff", "--color"], /*allowExit1*/ true),
			runGitCapture(cwd, ["ls-files", "--others", "--exclude-standard"], /*allowExit1*/ false),
		]);
		trackedDiff = results[0];
		untrackedList = results[1];
	} catch (err) {
		return {
			inRepo: true,
			text: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// Step 4: untracked files → "new file" diffs against /dev/null (NUL on Windows).
	const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
	const untrackedFiles = untrackedList
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	let untrackedDiff = "";
	for (const file of untrackedFiles) {
		try {
			const piece = await runGitCapture(
				cwd,
				["diff", "--color", "--no-index", "--", nullDevice, file],
				/*allowExit1*/ true,
			);
			untrackedDiff += piece;
		} catch (err) {
			untrackedDiff += `# (failed to diff untracked ${file}: ${
				err instanceof Error ? err.message : err
			})\n`;
		}
	}

	return { inRepo: true, text: trackedDiff + untrackedDiff };
}

/**
 * Run `git` with the given args. Return stdout. If `allowExit1` is true,
 * treat exit code 1 as success (git diff returns 1 when differences exist).
 */
async function runGitCapture(cwd: string, args: string[], allowExit1: boolean): Promise<string> {
	const cmd = "git " + args.map(shellQuote).join(" ");
	try {
		const { stdout } = await execAsync(cmd, {
			cwd,
			timeout: DIFF_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (err) {
		const e = err as { code?: number; stdout?: string; message?: string };
		if (allowExit1 && e.code === 1) return e.stdout ?? "";
		throw new Error(`${cmd} failed: ${e.message ?? err}`);
	}
}

function shellQuote(s: string): string {
	if (/^[\w./@:=-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── /init ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * AGENTS.md is the de-facto contributor-guide-for-agents filename, honored by
 * pi (via --no-context-files toggle), codex, claude code, and others.
 */
const AGENTS_MD_FILENAME = "AGENTS.md";

/**
 * Port of codex's `tui/prompt_for_init_command.md`, embedded verbatim so
 * the extension is self-contained (no dependency on the codex repo being
 * checked out at a specific path).
 *
 * codex source: codex-rs/tui/prompt_for_init_command.md
 */
const INIT_PROMPT = `Generate a file named ${AGENTS_MD_FILENAME} that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

// ─── /review ────────────────────────────────────────────────────────────────

/**
 * Review prompts ported verbatim from `core/src/review_prompts.rs`. The text
 * is intentionally terse — codex sends these as a top-level user message and
 * the model responds with a structured findings list. We do the same.
 *
 * codex source: codex-rs/core/src/review_prompts.rs
 */
const REVIEW_UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

function reviewBaseBranchPrompt(baseBranch: string, mergeBaseSha: string): string {
	return (
		`Review the code changes against the base branch '${baseBranch}'. ` +
		`The merge base commit for this comparison is ${mergeBaseSha}. ` +
		`Run \`git diff ${mergeBaseSha}\` to inspect the changes relative to ${baseBranch}. ` +
		"Provide prioritized, actionable findings."
	);
}

function reviewBaseBranchBackupPrompt(branch: string): string {
	return (
		`Review the code changes against the base branch '${branch}'. ` +
		`Start by finding the merge diff between the current branch and ${branch}'s upstream e.g. ` +
		`(\`git merge-base HEAD "$(git rev-parse --abbrev-ref \"${branch}@{upstream}\")"\`), ` +
		"then run `git diff` against that SHA to see what changes we would merge into the " +
		`${branch} branch. Provide prioritized, actionable findings.`
	);
}

function reviewCommitPrompt(sha: string, title: string | undefined): string {
	if (title) {
		return `Review the code changes introduced by commit ${sha} ("${title}"). Provide prioritized, actionable findings.`;
	}
	return `Review the code changes introduced by commit ${sha}. Provide prioritized, actionable findings.`;
}

/** Resolve the merge-base SHA between HEAD and a branch. */
async function gitMergeBase(cwd: string, branch: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync(`git merge-base HEAD ${shellQuote(branch)}`, {
			cwd,
			timeout: 10_000,
		});
		const sha = stdout.trim();
		return sha.length > 0 ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** Fetch the commit subject (title) for a given sha. */
async function gitCommitTitle(cwd: string, sha: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync(`git log -1 --format=%s ${shellQuote(sha)}`, {
			cwd,
			timeout: 10_000,
		});
		const title = stdout.trim();
		return title.length > 0 ? title : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a /review invocation into a final prompt string + a user-facing
 * hint. Returns `{ error }` if the args are bad / git operations fail.
 *
 * Inline-args grammar (ports codex's review-popup targets to a CLI form):
 *   /review                          → ReviewTarget::UncommittedChanges
 *   /review base <branch>            → ReviewTarget::BaseBranch
 *   /review commit <sha>             → ReviewTarget::Commit
 *   /review <anything else>          → ReviewTarget::Custom (free-text instructions)
 */
async function resolveReviewRequest(
	cwd: string,
	args: string,
): Promise<{ prompt: string; hint: string } | { error: string }> {
	const trimmed = args.trim();
	if (trimmed === "") {
		return { prompt: REVIEW_UNCOMMITTED_PROMPT, hint: "current changes" };
	}
	const [head, ...rest] = trimmed.split(/\s+/);
	const tail = rest.join(" ").trim();
	const sub = head.toLowerCase();

	if (sub === "base" || sub === "branch") {
		if (!tail) return { error: "Usage: /review base <branch>" };
		const sha = await gitMergeBase(cwd, tail);
		const prompt = sha
			? reviewBaseBranchPrompt(tail, sha)
			: reviewBaseBranchBackupPrompt(tail);
		return { prompt, hint: `changes against '${tail}'` };
	}

	if (sub === "commit") {
		if (!tail) return { error: "Usage: /review commit <sha>" };
		const title = await gitCommitTitle(cwd, tail);
		const shortSha = tail.slice(0, 7);
		const prompt = reviewCommitPrompt(tail, title);
		return {
			prompt,
			hint: title ? `commit ${shortSha}: ${title}` : `commit ${shortSha}`,
		};
	}

	// Anything else is a custom review instruction (free-text).
	return { prompt: trimmed, hint: trimmed };
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description:
			"Show `git diff` for the current working directory, including untracked files (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await runGitDiff(ctx.cwd);
			if (!result.inRepo) {
				ctx.ui.notify("`/diff` — not inside a git repository", "warning");
				return;
			}
			if (result.error) {
				ctx.ui.notify(`/diff failed: ${result.error}`, "error");
				return;
			}
			if (!result.text.trim()) {
				ctx.ui.notify("/diff — no changes", "info");
				return;
			}
			ctx.ui.notify(result.text, "info");
		},
	});

	/**
	 * /init — codex port. Bails out cleanly if AGENTS.md already exists so it
	 * never clobbers; otherwise submits the codex init prompt as a user message
	 * so the model uses its write/edit tools to create AGENTS.md from its
	 * inspection of the current repo.
	 *
	 * codex source: codex-rs/tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Init)
	 */
	pi.registerCommand("init", {
		description: `Create an ${AGENTS_MD_FILENAME} file with project-specific instructions for the agent (codex port).`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const target = join(ctx.cwd, AGENTS_MD_FILENAME);
			if (existsSync(target)) {
				ctx.ui.notify(
					`${AGENTS_MD_FILENAME} already exists at ${target}. ` +
						`Skipping /init to avoid overwriting it.`,
					"warning",
				);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Agent is busy. Wait until it's idle, then re-run /init.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Asking the agent to draft ${AGENTS_MD_FILENAME} from its inspection of ${ctx.cwd}…`,
				"info",
			);
			pi.sendUserMessage(INIT_PROMPT);
		},
	});
	/**
	 * /review — codex port. Maps codex's popup-based review-target picker to
	 * inline args so it works headless. Submits a faithful copy of codex's
	 * review prompt as a user message.
	 *
	 * codex source: codex-rs/core/src/review_prompts.rs +
	 *               codex-rs/tui/src/chatwidget/review_popups.rs
	 */
	pi.registerCommand("review", {
		description:
			"Review code changes (codex port). Usage: /review | /review base <branch> | /review commit <sha> | /review <custom instructions>",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const resolved = await resolveReviewRequest(ctx.cwd, rawArgs);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Agent is busy. Wait until it's idle, then re-run /review.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(`Reviewing ${resolved.hint}…`, "info");
			pi.sendUserMessage(resolved.prompt);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const opts = [
				{ value: "base", description: "review against a base branch" },
				{ value: "commit", description: "review a specific commit" },
			];
			const p = prefix.trim().toLowerCase();
			return opts.filter((o) => o.value.startsWith(p));
		},
	});

	/**
	 * /rollout — print the session JSONL rollout path. One-liner port of
	 * codex's `/rollout` (codex-rs/tui/src/chatwidget/slash_dispatch.rs SlashCommand::Rollout).
	 */
	pi.registerCommand("rollout", {
		description: "Print the current session's JSONL file path (codex port).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) {
				ctx.ui.notify(
					"This session is ephemeral (no persisted JSONL file). Send a message to create one, or run pi without --no-session.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(`Rollout: ${file}`, "info");
		},
	});

	/**
	 * /feedback — print where + how to file feedback. Codex's /feedback ships
	 * logs to OpenAI maintainers; pi's equivalent is a documentation pointer
	 * (no maintainer endpoint to ship to). We surface the issue URL + the path
	 * to copy if the user wants to attach a session rollout.
	 *
	 * codex source: codex-rs/feedback/ + tui SlashCommand::Feedback.
	 */
	pi.registerCommand("feedback", {
		description: "Print how to file feedback (with pointers to the right repo and your session rollout).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const rollout = ctx.sessionManager.getSessionFile();
			const lines: string[] = [];
			lines.push("File feedback:");
			lines.push("  • pi runtime issues       https://github.com/earendil-works/pi-coding-agent/issues");
			lines.push("  • your pi-config repo     https://github.com/thundron/pi-config/issues");
			lines.push("");
			lines.push("Attach context:");
			if (rollout) {
				lines.push(`  • this session rollout    ${rollout}`);
			} else {
				lines.push("  • session rollout        (ephemeral — no JSONL to attach)");
			}
			lines.push("  • debug snapshot          /debug-config (introspection.ts)");
			lines.push("  • lifecycle activity      /hooks (introspection.ts)");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	/**
	 * /test-approval — exercise pi's ctx.ui dialog APIs (confirm + select).
	 * Codex's /test-approval triggers an artificial approval-request flow to
	 * verify the dialog rendering path. Pi extensions don't have an "approval
	 * request" concept (tool blocking via tool_call hook is the closest analog),
	 * so this port tests the actual dialog primitives: confirm + select. The
	 * user's choices are echoed back via notify so the round-trip is visible.
	 *
	 * codex source: codex-rs/tui/src/chatwidget/slash_dispatch.rs (SlashCommand::TestApproval)
	 */
	pi.registerCommand("test-approval", {
		description: "Test pi's confirm + select dialog APIs (codex port of /test-approval).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/test-approval requires an interactive UI (skipped in print/rpc mode).", "warning");
				return;
			}
			// In rpc mode, ctx.hasUI is true but if the rpc client doesn't reply
			// to extension_ui_request events for confirm/select, the await hangs
			// forever. Race every dialog against a 30s timeout so /test-approval
			// can't deadlock pi.
			const DIALOG_TIMEOUT_MS = 30_000;
			const timeoutSym = Symbol("dialog-timeout");
			const withTimeout = <T>(p: Promise<T>): Promise<T | typeof timeoutSym> =>
				Promise.race<T | typeof timeoutSym>([
					p,
					new Promise<typeof timeoutSym>((resolve) =>
						setTimeout(() => resolve(timeoutSym), DIALOG_TIMEOUT_MS),
					),
				]);

			const confirmed = await withTimeout(
				ctx.ui.confirm(
					"Test approval",
					"This is a fake approval prompt. Click OK to continue.",
				),
			);
			if (confirmed === timeoutSym) {
				ctx.ui.notify(
					`/test-approval: confirm dialog timed out after ${DIALOG_TIMEOUT_MS / 1000}s. ` +
					`The rpc client may not be handling extension_ui_request — in an interactive TUI this would have shown a dialog.`,
					"warning",
				);
				return;
			}
			if (!confirmed) {
				ctx.ui.notify("Confirm: rejected. Skipping the selector test.", "info");
				return;
			}
			const choice = await withTimeout(
				ctx.ui.select("Test selector", ["alpha", "bravo", "charlie", "(cancel)"]),
			);
			if (choice === timeoutSym) {
				ctx.ui.notify(
					`/test-approval: select dialog timed out after ${DIALOG_TIMEOUT_MS / 1000}s.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Test approval flow complete. confirm=${confirmed} select=${choice ?? "(cancelled)"}`,
				"info",
			);
		},
	});
}
