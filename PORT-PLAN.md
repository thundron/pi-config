# codex → pi port plan

Tracks the sequential porting of OpenAI Codex functionality into pi
extensions (lives in `~/dev/pi-config/agent/extensions/`).

**Methodology**: one port per turn (small) or per session (large). Each
port composes pi's extension primitives — no patches to pi itself.
Provenance (codex source path + git ref if pinned) is captured in each
extension's sidecar README. State persistence prefers session-entry
reconstruction (branch-aware) when possible; sidecar files otherwise.

**Legend**:
- ✅ done (extension shipped, verified end-to-end)
- ▶ in progress
- ◯ todo
- ⊘ skip — won't port (reason explained inline)
- 🚫 already covered by pi built-in

---

## Tier 1 — clear wins (small, high value)

| ✅ | **fleet-citizen → guardian rename + restructure** | `guardian.ts` (+ `fleet-citizen.ts` stub) | n/a (this is the codex-alignment refactor of the legacy fleet-citizen) | M | shipped; renamed to match codex's `core/src/guardian/` namespace. Restructured into 5 codex-shaped sections: identity, agent-role (codex `role.rs`), execpolicy (codex `execpolicy/`), banned-phrases (Lorenzo-specific; no codex equivalent), rituals (`/done` `/halt` `/guardian` `/fleet`). Back-compat: `fleet-citizen.ts` is a 1-line delegating stub so pi-fleet's Python supervisor (which hardcodes that path) keeps working. New `PI_GUARDIAN_*` env vars added; legacy `PI_FLEET_*` aliases honored. |
| Status | Codex feature | Pi target | Codex source | Est | Notes |
|---|---|---|---|---|---|
| ✅ | `/goal` + auto-continuation + `update_goal` tool | `goal-mode.ts` | `core/src/goals.rs` + `core/templates/goals/*.md` | M | shipped |
| ✅ | `multi_agents` tool family + `/subagents` | `subagents.ts` | `core/src/tools/handlers/multi_agents/` + `agent-graph-store/` | L | shipped |
| ✅ | `/diff` — git diff including untracked files | `codex-cli-extras.ts` | `tui/src/get_git_diff.rs` | S | shipped; verified on real repo (128 KB diff), non-repo ("not inside a git repository"), clean repo ("no changes") |
| ✅ | `/init` — generate AGENTS.md via LLM prompt | `codex-cli-extras.ts` | `tui/prompt_for_init_command.md` + `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Init)` | S | shipped; verified skip-if-exists guard + prompt-submission branch |
| ✅ | `/review` — review code changes (uncommitted/base/commit/custom) | `codex-cli-extras.ts` | `core/src/review_prompts.rs` + `tui/src/chatwidget/review_popups.rs` | M | shipped; verified 5 scenarios (uncommitted / base+merge-base / commit+title-fetch / custom / missing-arg). Popup→inline-args mapping per port-design notes. Tool-restriction pattern deferred. |
| ✅ | `/side` + `/btw` + `/return` — ephemeral side conversation in fork | `side-conversation.ts` | `tui/src/app/side.rs` + `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Side/Btw)` | M | shipped; verified 6 scenarios (pre-conv guard / nested-side guard / fork→boundary-prompt→user-msg / footer transitions / clean /return / out-of-side /return no-op). `/return` replaces Ctrl+C. Parent-status badges (NeedsInput etc.) deferred. |
| ✅ | `/plan` + `/execute` — plan mode (read-only tools + codex planning prompt) | `plan-mode.ts` | `collaboration-mode-templates/templates/plan.md` + `tui/src/collaboration_modes.rs` | M | shipped; verified toggle on/off + idempotent guards + tool restriction (9 active → 5 read-mostly) + tool restore + footer transitions + branch-walk persistence for session resume. Uses pi.on('context') to inject codex plan.md before every LLM call. |
| ✅ | `/memories` — persistent cross-session memory (v0: registry + tools + context hint) | `memories.ts` | `memories/read/` + `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Memories)` | M | shipped; verified 6 slash scenarios (empty/add/append-same-section/show/where/clear) + zero ext errors. Tools `memory_recall` + `memory_save` registered for the LLM. Context-injection points the model at the tools when MEMORY.md is non-empty. Deferred: rollout-extraction + consolidation pipelines + citation parsing (documented in extension header). |
| ✅ | `/personality` — communication-style switcher (friendly / pragmatic / off) | `personality.ts` | `core/templates/personalities/{gpt-5.2-codex_friendly,gpt-5.2-codex_pragmatic}.md` + `tui/src/chatwidget/settings_popups.rs (open_personality_popup)` | S | shipped; verified 8 scenarios (list / set / list-with-current / idempotent-set / switch / clear / clear-noop / invalid-name). Templates embedded verbatim; pi.on('context') injects the active preset before every LLM call. |

| ✅ | **codex agent-roles** (typed sub-agents w/ developer instructions) | `guardian.ts` + extended `subagents.ts` | `core/src/agent/builtins/*.toml` + `core/src/agent/role.rs` (apply_role_to_config) | M | shipped (v0); `subagent_spawn({ role })` plumbs `PI_GUARDIAN_ROLE` env var → guardian.ts loads `~/.pi/agent/roles/<role>.json` and layers its `developer_instructions` into the child's before_agent_start system prompt. Sample role `roles/awaiter.json` ported verbatim from codex's `awaiter.toml`. v1 work: load richer fields (model_reasoning_effort, etc.) via pi.setActiveTools/setModel. |
| ✅ | **codex execpolicy** (prefix-rule command-policy blocker) | `guardian.ts` | `core/src/execpolicy/` (PrefixPattern, PatternToken, decision=forbidden/prompt/allow) | L | shipped (v0); JSON-flavored rules (codex's Starlark `prefix_rule(pattern, decision, justification, regex?)` collapsed to JSON). Built-in DEFAULT_EXECPOLICY ports the legacy fleet-citizen bash regexes into the new shape. Users add rules at `~/.pi/agent/execpolicy.json` (sample at `agent/execpolicy.example.json`). Token-prefix matching + per-token alts, plus regex fallback for patterns prefix-rules can't express. Defer: codex's `host_executable()` resolution + `prompt` decision (mid-tool-call approval UI). |

## Tier 2 — useful but more involved

| Status | Codex feature | Pi target | Codex source | Est | Notes |
|---|---|---|---|---|---|
| ✅ | `/ps` + `/stop` + `/bg cleanup` + `bg_register` tool | `background-procs.ts` | `tui/src/chatwidget.rs (add_ps_output, clean_background_terminals)` + `core/src/unified_exec/` | M | shipped; pi has no unified-exec subsystem so the port uses two registration paths: (1) `bg_register` tool the model calls explicitly with a known PID, (2) auto-detect on bash tool_result via well-known 'pid N' patterns gated by a backgrounding-heuristic on the command. /ps shows tracked + live status via `kill -0`, /stop SIGTERMs by tracked id or `all`, /bg cleanup purges dead. Verified 5 slash paths clean + bg_register tool present (15 tools in inventory). |
| ⊘ | `/raw` — toggle raw scrollback for copy-friendly selection | (not portable) | `tui/src/chatwidget/raw_output_mode.rs` | M | **skip with reason**: codex toggles `HistoryRenderMode::Rich ↔ Raw` which is a fundamental rendering-engine setting. Pi's ExtensionUIContext exposes setStatus/setFooter/setHeader/setWidget/setTitle but no history-rendering-mode hook. Would require a pi-runtime patch, not extension-portable. Pi has a built-in `/copy` for the last agent message which covers the most common selection use-case. |
| ✅ | `/hooks` — list lifecycle events + live fire counts | `introspection.ts` | `tui/src/chatwidget/hooks.rs (add_hooks_output)` + `tui/src/slash_command.rs (SlashCommand::Hooks)` | S | shipped; lists all 29 pi lifecycle events grouped by category with per-session fire counts (×N badges). `/hooks all` for full descriptions, `/hooks reset` zeros counts. Verified 3 scenarios. Codex's static hook declarations don't map directly to pi's extension event model; the port surfaces live activity instead. |
| ✅ | `/mcp` (aliased to `/tools`) — list registered tools grouped by source | `introspection.ts` | `tui/src/chatwidget.rs (add_mcp_output)` + `tui/src/slash_command.rs (SlashCommand::Mcp)` | S | shipped; pi treats every registered tool the same regardless of source (MCP vs native vs extension), so /mcp aliases /tools. Verified 14-tool inventory + filter (4/14 for 'subagent'). |
| ✅ | `/title` — configure terminal title via templated placeholders | `terminal-title.ts` | `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Title)` + `tui/src/terminal_title*.rs` | S | shipped; uses `ctx.ui.setTitle()`, supports `{cwd} {fullcwd} {model} {thinking} {provider} {branch} {session}` placeholders, re-renders on turn_end/model_select/thinking_level_select, persists via custom_message entries. Verified 6 scenarios. |
| ⊘ | `/statusline` — configure status bar items | (overlap with pi model) | `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Statusline)` | M | **skip with reason**: codex's /statusline lets the user pick which items appear in the status bar. In pi, each extension already drives its own status bar entry via `ctx.ui.setStatus(key, text)` — there's no central coordinator to configure from a slash command. A meaningful port would require an opt-in "I provide status item X" registration mechanism that extensions don't currently have. |
| ✅ | `/debug-config` — runtime + settings layers + extensions + skills + env | `introspection.ts` | `tui/src/chatwidget.rs (add_debug_config_output)` + `tui/src/debug_config.rs` | S | shipped; dumps model+thinking+cwd+sessionId+sessionFile, settings layer keys (global + project), every loaded extension with its slash commands, and pi/codex-related env vars. |
| ✅ | `/feedback` — print feedback channels + attachable context | `codex-cli-extras.ts` | `codex-rs/feedback/` + `tui SlashCommand::Feedback` | S | shipped; codex's /feedback ships logs to OpenAI maintainers (no equivalent endpoint for pi), so we surface pointers to the right GitHub issue trackers plus the session rollout path and `/debug-config` / `/hooks` for attachment. |

## Tier 3 — niche / fun

| Status | Codex feature | Pi target | Codex source | Est | Notes |
|---|---|---|---|---|---|
| ✅ | `/pets` — animated terminal pet in the footer (dog/cat/fish/snake/hamster) | `pets.ts` | `tui/src/pets/` + `tui/src/chatwidget/pets.rs` | M | shipped; cycles ASCII frames via setInterval into `ctx.ui.setStatus`. Verified animation transitions for cat then dog, off, invalid-name warning. Persists across session resumes. |
| ✅ | `/test-approval` — exercise pi's confirm + select dialog APIs | `codex-cli-extras.ts` | `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::TestApproval)` | S | shipped; pi has no 'approval request' concept (tool_call blocking is the closest analog), so this port tests pi's actual dialog primitives (ctx.ui.confirm + ctx.ui.select). Requires interactive UI to complete the round-trip. |
| ✅ | `/rollout` — print session rollout file path | `codex-cli-extras.ts` | `tui/src/chatwidget/slash_dispatch.rs (SlashCommand::Rollout)` | XS | shipped; one-liner that reads `ctx.sessionManager.getSessionFile()` and surfaces via notify, with a friendly warning for ephemeral sessions. |

## Already covered by pi built-in (no port needed)

| Codex | Pi built-in | Notes |
|---|---|---|
| `/model` | `/model` | 🚫 |
| `/compact` | `/compact` | 🚫 |
| `/new` | `/new` | 🚫 |
| `/resume` | `/resume` | 🚫 |
| `/fork` | `/fork` | 🚫 (no auto-return semantics — see `/side` row above for the missing piece) |
| `/copy` | `/copy` | 🚫 |
| `/rename` | `/name` | 🚫 |
| `/clear` | (pi's own clear semantics) | 🚫 |
| `/logout` | `/logout` | 🚫 |
| `/quit` / `/exit` | `/quit` | 🚫 |
| `/vim` | (pi composer settings) | 🚫 |
| `/skills` | (pi already has skills) | 🚫 (introspection might be worth a small CLI port) |
| `/mention` (@-file) | (pi's `@file` syntax) | 🚫 |
| `/keymap` | (pi keybindings) | 🚫 |
| `/theme` | `/theme` | 🚫 (pi has settings) |
| `/status` | `/session` | 🚫 (pi already has session info) |
| `/experimental` | (pi settings.json) | 🚫 |
| `/permissions` | (pi tool allowlist) | 🚫 (different design; not portable as-is) |

## Won't port — out of scope or requires backend pi doesn't have

| Codex | Why skipped |
|---|---|
| `/realtime` + `/settings` (audio) | ⊘ requires WebRTC + voice-mode backend infrastructure |
| `/ide` | ⊘ requires the codex IDE-extension companion |
| `/apps` | ⊘ ChatGPT-specific (Codex Apps in chatgpt.com) |
| `/plugins` | ⊘ codex plugin system is separate from pi extensions; different concept |
| `/elevate-sandbox` + `/sandbox-add-read-dir` | ⊘ codex-specific sandbox model |
| `/approve` (auto-review approval) | ⊘ couples to codex's review subsystem (which we may port separately) |
| `cloud-tasks` | ⊘ requires ChatGPT cloud agent backend |
| `apply-patch` tool | ⊘ pi already has `edit` / `write`; the codex patch format isn't a win |
| `chatgpt` auth | ⊘ pi has its own auth |

---

## How to extend this plan

Add new rows to the Tier tables as features are discovered. Move
rows between tiers as priorities shift. Mark a row ✅ only after the
extension is shipped AND verified end-to-end (RPC `get_commands` shows
it, tools register, basic flow exercised against `pi -p --mode json`).

For each completed port, the extension's sidecar `*.README.md`
documents the codex source path + behavior mapping (provenance).
`git log` is the audit trail of which were done when.
