/**
 * terminal-title — pi extension that ports codex's `/title` slash command.
 *
 * Sets the terminal window/tab title from a template that can interpolate
 * runtime placeholders (cwd, model, thinking level, provider, session name).
 * Re-renders on every lifecycle event that could change the inputs.
 *
 * codex source mapped:
 *   tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Title → open_terminal_title_setup)
 *   tui/src/terminal_title*.rs (the title rendering)
 *
 * Pi exposes `ctx.ui.setTitle(string)`, which is exactly the primitive we
 * need. State persists via a `custom_message` entry on the branch so the
 * title sticks across session resumes.
 *
 * Usage:
 *   /title                            show current template
 *   /title <template>                 set; supports {cwd} {model} {thinking}
 *                                     {provider} {branch} {session}
 *   /title off                        restore default (clear our custom title)
 *
 * Template examples:
 *   /title pi · {cwd}
 *   /title {model}/{thinking} · {cwd}
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import { basename } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execCb);
const MAX_TERMINAL_TITLE_CHARS = 240;

// ─── State persistence ─────────────────────────────────────────────────────

interface TitleSetEntry {
	/** Template string, or "off" to clear. */
	template: string;
	t: number;
}

function findActiveTemplate(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	let template: string | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "title/set") continue;
		const data = entry.details as TitleSetEntry;
		template = data.template === "off" ? undefined : data.template;
	}
	return template;
}

// ─── Template rendering ────────────────────────────────────────────────────

/**
 * Cached git-branch lookup. Refreshed on session_start (cheap), reused
 * everywhere else so we don't run `git symbolic-ref` on every turn_end.
 */
let cachedBranch: string | undefined;

async function probeGitBranch(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync("git symbolic-ref --short -q HEAD || git rev-parse --short HEAD", {
			cwd,
			timeout: 3000,
		});
		const v = stdout.trim();
		return v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Replace {placeholder} occurrences in the template with current runtime
 * values. Unknown placeholders are left intact so the user notices typos.
 */
function renderTitle(
	template: string,
	values: Record<string, string | undefined>,
): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
		const v = values[key];
		return v === undefined ? whole : v;
	});
}

/**
 * Port of codex-rs/tui/src/terminal_title.rs sanitize_terminal_title().
 * Treats template output as untrusted display text: remove controls and
 * invisible/bidi formatting chars, collapse whitespace runs, and bound title
 * length so tab bars/window managers do not silently truncate arbitrary data.
 */
function sanitizeTerminalTitle(title: string): string {
	let sanitized = "";
	let charsWritten = 0;
	let pendingSpace = false;

	for (const ch of title) {
		// JavaScript treats FEFF as whitespace, but Rust's char::is_whitespace()
		// does not in Codex's sanitizer path. Exclude invisible formatting chars
		// from whitespace collapsing so they are dropped, not converted to spaces.
		if (/\s/u.test(ch) && !isInvisibleFormattingChar(ch)) {
			// Strip leading whitespace without a separate trim pass.
			pendingSpace = sanitized.length > 0;
			continue;
		}

		if (isDisallowedTerminalTitleChar(ch)) continue;

		if (pendingSpace) {
			const remaining = Math.max(0, MAX_TERMINAL_TITLE_CHARS - charsWritten);
			if (remaining > 1) {
				sanitized += " ";
				charsWritten += 1;
				pendingSpace = false;
			}
		}

		if (charsWritten >= MAX_TERMINAL_TITLE_CHARS) break;

		sanitized += ch;
		charsWritten += 1;
	}

	return sanitized;
}

function isDisallowedTerminalTitleChar(ch: string): boolean {
	const cp = ch.codePointAt(0);
	if (cp === undefined) return true;
	// JS strings iterate by code point, so this mirrors Rust char::is_control()
	// for the C0/C1 control ranges relevant to terminal title emission.
	if ((cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return true;
	return isInvisibleFormattingChar(ch);
}

function isInvisibleFormattingChar(ch: string): boolean {
	const cp = ch.codePointAt(0);
	if (cp === undefined) return true;
	return (
		cp === 0x00ad ||
		cp === 0x034f ||
		cp === 0x061c ||
		cp === 0x180e ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0x202a && cp <= 0x202e) ||
		(cp >= 0x2060 && cp <= 0x206f) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		cp === 0xfeff ||
		(cp >= 0xfff9 && cp <= 0xfffb) ||
		(cp >= 0x1bca0 && cp <= 0x1bca3) ||
		(cp >= 0xe0100 && cp <= 0xe01ef)
	);
}

function buildValues(pi: ExtensionAPI, ctx: ExtensionContext): Record<string, string | undefined> {
	const model = ctx.model;
	let thinking: string | undefined;
	try {
		thinking = (pi.getThinkingLevel() ?? undefined) as string | undefined;
	} catch {
		thinking = undefined;
	}
	return {
		cwd: basename(ctx.cwd),
		fullcwd: ctx.cwd,
		model: model?.id,
		provider: model?.provider,
		thinking,
		branch: cachedBranch,
		session: ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId()?.slice(0, 8),
	};
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let activeTemplate: string | undefined;

	const apply = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!activeTemplate) {
			// Restore default — pi has no "unset" semantic for setTitle, so set
			// to a generic "pi" title rather than leaving stale custom text.
			ctx.ui.setTitle("pi");
			return;
		}
		const rendered = sanitizeTerminalTitle(renderTitle(activeTemplate, buildValues(pi, ctx)));
		if (rendered.length === 0) return;
		ctx.ui.setTitle(rendered);
	};

	const recompute = async (ctx: ExtensionContext): Promise<void> => {
		activeTemplate = findActiveTemplate(ctx);
		apply(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		cachedBranch = await probeGitBranch(ctx.cwd);
		await recompute(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => recompute(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		// Restore a generic title so pi doesn't leave stale {cwd} in the terminal.
		if (ctx.hasUI) ctx.ui.setTitle("");
	});

	// Re-render on inputs that change template values
	pi.on("turn_end", async (_event, ctx) => {
		if (activeTemplate) apply(ctx);
	});
	pi.on("model_select", async (_event, ctx) => apply(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => apply(ctx));

	(pi as unknown as { __terminalTitleInternals?: unknown }).__terminalTitleInternals = {
		renderTitle,
		sanitizeTerminalTitle,
		isDisallowedTerminalTitleChar,
		MAX_TERMINAL_TITLE_CHARS,
	};

	pi.registerCommand("title", {
		description:
			"Set the terminal window/tab title template (codex port). Placeholders: {cwd} {fullcwd} {model} {thinking} {provider} {branch} {session}.",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();

			if (!args || args === "show" || args === "view") {
				const lines: string[] = [];
				lines.push(
					activeTemplate
						? `Current title template: ${activeTemplate}`
						: "No custom title set (using pi default).",
				);
				lines.push("");
				lines.push("Placeholders:");
				const values = buildValues(pi, ctx);
				for (const [k, v] of Object.entries(values)) {
					lines.push(`  {${k}}  =  ${v ?? "(unavailable)"}`);
				}
				lines.push("");
				lines.push("Set with: /title <template>     e.g. /title pi · {cwd}");
				lines.push("Clear:    /title off");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (args === "off" || args === "clear" || args === "none") {
				pi.sendMessage<TitleSetEntry>({
					customType: "title/set",
					content: "title cleared",
					display: false,
					details: { template: "off", t: Date.now() },
				});
				activeTemplate = undefined;
				apply(ctx);
				ctx.ui.notify("Terminal title cleared (reset to 'pi').", "info");
				return;
			}

			pi.sendMessage<TitleSetEntry>({
				customType: "title/set",
				content: `title set to ${args}`,
				display: false,
				details: { template: args, t: Date.now() },
			});
			activeTemplate = args;
			apply(ctx);
			const rendered = sanitizeTerminalTitle(renderTitle(args, buildValues(pi, ctx)));
			ctx.ui.notify(
				rendered.length > 0
					? `Terminal title set. Rendered: ${rendered}`
					: "Terminal title set, but it has no visible content after sanitization; current title left unchanged.",
				"info",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "show", description: "show current template + placeholder values" },
				{ value: "off", description: "clear (reset to pi default)" },
			];
			const p = prefix.trim().toLowerCase();
			return subs
				.filter((s) => s.value.startsWith(p))
				.map((s) => ({ value: s.value, label: s.value, description: s.description }));
		},
	});
}
