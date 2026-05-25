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
		const rendered = renderTitle(activeTemplate, buildValues(pi, ctx));
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
			const rendered = renderTitle(args, buildValues(pi, ctx));
			ctx.ui.notify(`Terminal title set. Rendered: ${rendered}`, "info");
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "show", description: "show current template + placeholder values" },
				{ value: "off", description: "clear (reset to pi default)" },
			];
			const p = prefix.trim().toLowerCase();
			return subs.filter((s) => s.value.startsWith(p));
		},
	});
}
