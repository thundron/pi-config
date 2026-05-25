/**
 * memories — pi extension that ports a subset of codex's `/memories` feature.
 *
 * What's ported (v0):
 *   - Persistent registry file at `~/.pi/memories/MEMORY.md`
 *   - Two model-callable tools: `memory_recall` (search) + `memory_save` (append)
 *   - Slash commands: `/memories`, `/memories add <text>`, `/memories clear`,
 *     `/memories where` (print the path)
 *   - Context injection: small developer-style message that points the model
 *     at the tools, fired on every LLM call when MEMORY.md exists
 *
 * What's NOT ported (deferred — these are large background pipelines):
 *   - Phase 1: rollout extraction (per-thread summarization → structured output)
 *   - Phase 2: consolidation (cross-thread merge of extracted summaries)
 *   - Memory citation parsing (<citation_entries> / <rollout_ids> blocks)
 *   - Skills/rollout-summaries folder layout
 *   - MCP-style memory filesystem server (codex's `memories/mcp/` crate)
 *
 * The v0 captures the *user-visible value* (persistent notes + read/write
 * tools + on-demand retrieval) without the considerable infrastructure of
 * codex's full memory pipeline. Future revisions can layer the extraction
 * and consolidation phases on top.
 *
 * codex source mapped:
 *   memories/read/templates/memories/read_path.md → CONTEXT_HINT (paraphrased)
 *   memories/read/src/lib.rs                       → memory_root + tool API
 *   tui/src/chatwidget/slash_dispatch.rs (Memories) → /memories slash command
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ─── Paths ──────────────────────────────────────────────────────────────────

const PI_HOME =
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const MEMORIES_ROOT =
	process.env.PI_MEMORIES_DIR ?? join(homedir(), ".pi", "memories");
const MEMORY_FILE = join(MEMORIES_ROOT, "MEMORY.md");

// ─── Context-injection hint (paraphrased from codex read_path.md) ──────────

/**
 * Short developer-instruction message injected on every LLM call when the
 * memory file exists and is non-empty. Tells the model how to retrieve memory
 * via the tools, without dumping the full file into context.
 *
 * Codex's equivalent is much longer (full layout + retrieval procedure +
 * citation contract). v0 collapses to the essentials.
 *
 * codex source: codex-rs/memories/read/templates/memories/read_path.md
 */
const CONTEXT_HINT = `## Memory

You have access to a persistent cross-session memory registry at ${MEMORY_FILE}.

Decision boundary — use the memory tools when ANY of these are true:
- The user mentions prior context, conventions, or earlier decisions
- The task is ambiguous and could depend on previously-recorded preferences
- A non-trivial task that's likely related to facts other sessions have recorded
- The user references "as we discussed", "remember", "last time", etc.

Hard skip cases (don't use memory): current time/date, simple translation,
one-line shell command, trivial formatting.

How to retrieve:
- Call \`memory_recall({ query })\` to search MEMORY.md for keywords.
- The tool returns matching sections only; the full file is not loaded.

How to record:
- Call \`memory_save({ category, text })\` to add a durable fact, preference, or
  decision. Use short categories like "preferences", "conventions", "facts",
  "tooling", "<project-name>".
- Save sparingly — only persistent facts, not one-off conversation state.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
	if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readMemoryFile(): string {
	if (!existsSync(MEMORY_FILE)) return "";
	try {
		return readFileSync(MEMORY_FILE, "utf8");
	} catch {
		return "";
	}
}

function memoryFileNonEmpty(): boolean {
	return readMemoryFile().trim().length > 0;
}

/**
 * Append a category-grouped entry to MEMORY.md. If the category section
 * doesn't exist, append it. If it does, append under the existing section.
 * Keeps the registry append-only and human-editable.
 */
function appendMemory(category: string, text: string, sessionId?: string): void {
	ensureDir(dirname(MEMORY_FILE));
	const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const bullet =
		`- [${stamp}] ${text}` + (sessionId ? ` _(session ${sessionId.slice(0, 8)})_` : "");
	const header = `## ${category}`;

	if (!existsSync(MEMORY_FILE)) {
		const initial = `# Pi memory\n\nPersistent cross-session memory registry. Edit by hand or via the \`memory_save\` tool.\n\n${header}\n\n${bullet}\n`;
		writeFileSync(MEMORY_FILE, initial);
		return;
	}

	const current = readMemoryFile();
	if (current.includes(`\n${header}\n`) || current.startsWith(`${header}\n`)) {
		// Section exists — append our bullet at the end of the section.
		// Find the next "## " heading (or EOF) and insert before it.
		const headerIdx = current.indexOf(`${header}\n`);
		const afterHeader = headerIdx + header.length + 1;
		const nextSectionIdx = current.indexOf("\n## ", afterHeader);
		if (nextSectionIdx === -1) {
			// Append at EOF, ensuring exactly one trailing newline.
			const trimmed = current.replace(/\n+$/, "");
			writeFileSync(MEMORY_FILE, `${trimmed}\n${bullet}\n`);
		} else {
			// Insert before the next section.
			const before = current.slice(0, nextSectionIdx).replace(/\n+$/, "");
			const after = current.slice(nextSectionIdx);
			writeFileSync(MEMORY_FILE, `${before}\n${bullet}\n${after}`);
		}
		return;
	}

	// New section.
	appendFileSync(MEMORY_FILE, `\n${header}\n\n${bullet}\n`);
}

/**
 * Search the memory file for a query (case-insensitive substring match across
 * lines). Returns matching sections with surrounding context.
 *
 * v0 is dumb substring matching; future versions could add fuzzy match or
 * BM25 ranking like codex's full pipeline.
 */
function recallMemory(query: string): { found: boolean; text: string } {
	const content = readMemoryFile();
	if (!content) return { found: false, text: `${MEMORY_FILE} is empty or missing.` };
	const q = query.trim().toLowerCase();
	if (!q) {
		return { found: true, text: content };
	}

	// Split into "## " sections + a leading preamble.
	const sections = content.split(/^## /m);
	const matches: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		const sec = sections[i];
		if (i === 0) {
			// Preamble: include only if it matches.
			if (sec.toLowerCase().includes(q)) matches.push(sec.trim());
			continue;
		}
		const fullSection = `## ${sec}`;
		if (fullSection.toLowerCase().includes(q)) {
			matches.push(fullSection.trim());
		}
	}

	if (matches.length === 0) {
		return {
			found: false,
			text: `No memory entries matched "${query}".`,
		};
	}
	return { found: true, text: matches.join("\n\n---\n\n") };
}

// ─── Tool schemas ───────────────────────────────────────────────────────────

const MemoryRecallParams = Type.Object({
	query: Type.String({
		description:
			"Keywords / phrase to search for in MEMORY.md (case-insensitive substring match across category sections). Empty string returns the full file.",
	}),
});

const MemorySaveParams = Type.Object({
	category: StringEnum(
		["preferences", "conventions", "facts", "tooling", "decisions", "project", "other"] as const,
		{
			description:
				"Section heading to file the memory under. Pick the most natural; use 'other' if none fits.",
		},
	),
	text: Type.String({
		description:
			"The memory content — a single short, durable sentence. Avoid one-off conversation state; only save persistent facts, preferences, or decisions.",
	}),
});

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	void PI_HOME; // tracked for future skill-folder integration

	// ─── Tools the model can call ──────────────────────────────────────────

	pi.registerTool({
		name: "memory_recall",
		label: "recall memory",
		description:
			"Search the persistent cross-session memory registry (~/.pi/memories/MEMORY.md) for matching category sections. Returns the matched sections only.",
		parameters: MemoryRecallParams,
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const result = recallMemory((params as { query: string }).query);
			return {
				content: [{ type: "text", text: result.text }],
				details: { found: result.found },
			};
		},
	});

	pi.registerTool({
		name: "memory_save",
		label: "save memory",
		description:
			"Append a durable fact / preference / decision to ~/.pi/memories/MEMORY.md under the given category. Use sparingly — only persistent items worth remembering across sessions.",
		parameters: MemorySaveParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { category: string; text: string };
			try {
				appendMemory(p.category, p.text, ctx.sessionManager.getSessionId());
				return {
					content: [
						{
							type: "text",
							text: `Saved to MEMORY.md under ${p.category}:\n  ${p.text}`,
						},
					],
					details: { ok: true, category: p.category, file: MEMORY_FILE },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `memory_save failed: ${err instanceof Error ? err.message : err}`,
						},
					],
					details: { ok: false, error: String(err) },
					isError: true,
				};
			}
		},
	});

	// ─── Context-injection (codex's developer-instructions analog) ─────────

	pi.on("context", async (event, _ctx) => {
		if (!memoryFileNonEmpty()) return; // nothing useful to point the model at
		const memMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: CONTEXT_HINT }],
			timestamp: Date.now(),
		};
		return { messages: [memMessage, ...event.messages] };
	});

	// ─── /memories slash command ───────────────────────────────────────────

	pi.registerCommand("memories", {
		description:
			"View / add / clear persistent cross-session memory (codex port). Usage: /memories | /memories add <text> | /memories where | /memories clear",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim();

			if (!args || args === "show" || args === "view" || args === "ls") {
				if (!existsSync(MEMORY_FILE)) {
					ctx.ui.notify(
						`No memory file yet at ${MEMORY_FILE}.\n` +
							`Add one with: /memories add <text>\n` +
							`Or have the agent save via the memory_save tool.`,
						"info",
					);
					return;
				}
				const content = readMemoryFile();
				ctx.ui.notify(content || "(empty)", "info");
				return;
			}

			const [sub, ...rest] = args.split(/\s+/);
			const tail = rest.join(" ").trim();
			const subLower = sub.toLowerCase();

			if (subLower === "where" || subLower === "path") {
				ctx.ui.notify(MEMORY_FILE, "info");
				return;
			}

			if (subLower === "add" || subLower === "save") {
				if (!tail) {
					ctx.ui.notify("Usage: /memories add <text>", "warning");
					return;
				}
				try {
					appendMemory("other", tail, ctx.sessionManager.getSessionId());
					ctx.ui.notify(`Saved under 'other':\n  ${tail}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`Save failed: ${err instanceof Error ? err.message : err}`,
						"error",
					);
				}
				return;
			}

			if (subLower === "clear" || subLower === "wipe" || subLower === "rm") {
				if (!existsSync(MEMORY_FILE)) {
					ctx.ui.notify("Memory file already absent.", "info");
					return;
				}
				try {
					unlinkSync(MEMORY_FILE);
					ctx.ui.notify(`Deleted ${MEMORY_FILE}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`Delete failed: ${err instanceof Error ? err.message : err}`,
						"error",
					);
				}
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: ${sub}\n\n` +
					`Usage:\n` +
					`  /memories             show MEMORY.md\n` +
					`  /memories add <text>  append to 'other' section\n` +
					`  /memories where       print MEMORY.md path\n` +
					`  /memories clear       delete MEMORY.md`,
				"warning",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const subs = [
				{ value: "add", description: "append a memory entry" },
				{ value: "where", description: "print the MEMORY.md path" },
				{ value: "clear", description: "delete MEMORY.md" },
				{ value: "show", description: "print MEMORY.md content" },
			];
			const p = prefix.trim().toLowerCase();
			return subs.filter((s) => s.value.startsWith(p));
		},
	});
}
