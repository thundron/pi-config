// Shared rollout token budget for pi, inspired by Codex's rollout_budget.
//
// Codex sources:
//   codex-rs/core/src/rollout_budget.rs
//   codex-rs/core/src/session/rollout_budget.rs
//   codex-rs/core/src/context/rollout_budget.rs
//
// Codex keeps one in-memory shared budget for a root-thread session tree. Pi
// subagents are separate processes, so this extension implements the missing
// primitive as an append-only JSONL ledger file inherited by children via env:
//
//   PI_ROLLOUT_BUDGET_TOKENS=<N>        enable with total weighted-token limit
//   PI_ROLLOUT_BUDGET_FILE=<path>       optional shared ledger path
//   PI_ROLLOUT_BUDGET_ID=<id>           optional id used when FILE omitted
//   PI_ROLLOUT_PREFILL_TOKEN_WEIGHT=1   input-token weight
//   PI_ROLLOUT_SAMPLING_TOKEN_WEIGHT=1  output-token weight
//   PI_ROLLOUT_REMINDER_INTERVAL=<N>    weighted-token interval for reminders
//
// The parent sets FILE/ID defaults in process.env when enabled, so subagents
// spawned by subagents.ts inherit the same ledger. We cannot abort Codex-style
// before sampling from extension space, but we do inject a clear reminder and
// expose get_rollout_budget so the model can stop safely when exhausted.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "rollout-budget";
const GetRolloutBudgetParams = Type.Object({}, { additionalProperties: false });

interface BudgetConfig {
	enabled: boolean;
	limitTokens: number;
	ledgerPath: string;
	prefillWeight: number;
	samplingWeight: number;
	reminderInterval: number;
}

interface UsageRecord {
	t: number;
	pid: number;
	input: number;
	output: number;
	weighted: number;
}

interface BudgetSnapshot {
	enabled: boolean;
	limit_tokens: number | null;
	used_weighted_tokens: number;
	remaining_weighted_tokens: number | null;
	exhausted: boolean;
	ledger_path?: string;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function makeBudgetId(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${process.pid}`;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
	const limit = parsePositiveNumber(env.PI_ROLLOUT_BUDGET_TOKENS ?? env.PI_ROLLOUT_TOKEN_BUDGET);
	const enabled = limit !== undefined;
	const id = env.PI_ROLLOUT_BUDGET_ID ?? makeBudgetId();
	const ledgerPath = env.PI_ROLLOUT_BUDGET_FILE ?? join(homedir(), ".pi", "rollout-budget", `${id}.jsonl`);
	const prefillWeight = parsePositiveNumber(env.PI_ROLLOUT_PREFILL_TOKEN_WEIGHT) ?? 1;
	const samplingWeight = parsePositiveNumber(env.PI_ROLLOUT_SAMPLING_TOKEN_WEIGHT) ?? 1;
	const reminderInterval = parsePositiveNumber(env.PI_ROLLOUT_REMINDER_INTERVAL) ?? Math.max(1, Math.floor((limit ?? 100_000) / 4));
	return {
		enabled,
		limitTokens: limit ?? 0,
		ledgerPath,
		prefillWeight,
		samplingWeight,
		reminderInterval,
	};
}

function ensureLedger(config: BudgetConfig): void {
	if (!config.enabled) return;
	mkdirSync(dirname(config.ledgerPath), { recursive: true });
	if (!existsSync(config.ledgerPath)) writeFileSync(config.ledgerPath, "");
	process.env.PI_ROLLOUT_BUDGET_FILE = config.ledgerPath;
	process.env.PI_ROLLOUT_BUDGET_TOKENS = String(config.limitTokens);
	if (!process.env.PI_ROLLOUT_BUDGET_ID) process.env.PI_ROLLOUT_BUDGET_ID = config.ledgerPath.split("/").pop()?.replace(/\.jsonl$/, "") ?? "rollout";
}

function usageWeighted(input: number, output: number, config: BudgetConfig): number {
	return Math.max(0, input) * config.prefillWeight + Math.max(0, output) * config.samplingWeight;
}

function appendUsage(config: BudgetConfig, input: number, output: number): void {
	if (!config.enabled) return;
	ensureLedger(config);
	const rec: UsageRecord = {
		t: Date.now(),
		pid: process.pid,
		input: Math.max(0, Math.floor(input)),
		output: Math.max(0, Math.floor(output)),
		weighted: usageWeighted(input, output, config),
	};
	appendFileSync(config.ledgerPath, `${JSON.stringify(rec)}\n`);
}

function readUsedWeightedTokens(config: BudgetConfig): number {
	if (!config.enabled || !existsSync(config.ledgerPath)) return 0;
	let total = 0;
	for (const line of readFileSync(config.ledgerPath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as Partial<UsageRecord>;
			if (typeof rec.weighted === "number" && Number.isFinite(rec.weighted)) total += rec.weighted;
		} catch {
			// Ignore torn/corrupt JSONL lines; the next append remains usable.
		}
	}
	return total;
}

function snapshotBudget(config: BudgetConfig): BudgetSnapshot {
	const used = readUsedWeightedTokens(config);
	if (!config.enabled) {
		return {
			enabled: false,
			limit_tokens: null,
			used_weighted_tokens: used,
			remaining_weighted_tokens: null,
			exhausted: false,
		};
	}
	const remaining = Math.max(0, Math.floor(config.limitTokens - used));
	return {
		enabled: true,
		limit_tokens: config.limitTokens,
		used_weighted_tokens: Math.floor(used),
		remaining_weighted_tokens: remaining,
		exhausted: used >= config.limitTokens,
		ledger_path: config.ledgerPath,
	};
}

function renderBudgetContext(snapshot: BudgetSnapshot): string {
	if (!snapshot.enabled || snapshot.remaining_weighted_tokens === null) {
		return "<rollout_budget>\nNo shared rollout token budget is configured.\n</rollout_budget>";
	}
	const base = `You have ${snapshot.remaining_weighted_tokens} weighted tokens left in the shared session token budget.`;
	return `<rollout_budget>\n${snapshot.exhausted ? `${base}\nThe shared budget is exhausted. Do not start new substantive work; summarize current progress and stop.` : base}\n</rollout_budget>`;
}

function reminderDue(usedWeightedTokens: number, interval: number, lastReminderIndex: number): { due: boolean; index: number } {
	const index = Math.floor(Math.max(0, usedWeightedTokens) / Math.max(1, interval));
	return { due: index > lastReminderIndex, index };
}

function assistantUsage(message: { usage?: { input?: number; output?: number } }): { input: number; output: number } {
	const u = message.usage;
	return { input: u?.input ?? 0, output: u?.output ?? 0 };
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	ensureLedger(config);
	let lastReminderIndex = -1;

	function refreshFooter(ctx: { hasUI?: boolean; ui?: { setStatus(key: string, text: string | undefined): void } }) {
		if (!ctx.hasUI) return;
		const snap = snapshotBudget(config);
		if (!snap.enabled) {
			ctx.ui?.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui?.setStatus(STATUS_KEY, `${snap.exhausted ? "💸" : "🧮"} ${snap.remaining_weighted_tokens}/${snap.limit_tokens}w`);
	}

	pi.registerTool({
		name: "get_rollout_budget",
		label: "get rollout budget",
		description: "Inspect the shared rollout/session weighted-token budget, if configured.",
		parameters: GetRolloutBudgetParams,
		async execute() {
			const snap = snapshotBudget(config);
			return {
				content: [{ type: "text" as const, text: renderBudgetContext(snap) }],
				details: snap,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => refreshFooter(ctx));
	pi.on("session_tree", async (_event, ctx) => {
		lastReminderIndex = -1;
		refreshFooter(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled || event.message?.role !== "assistant") return;
		const { input, output } = assistantUsage(event.message);
		appendUsage(config, input, output);
		refreshFooter(ctx);
	});

	pi.on("context", async (event, _ctx) => {
		if (!config.enabled) return undefined;
		const snap = snapshotBudget(config);
		const due = snap.exhausted
			? { due: true, index: Number.MAX_SAFE_INTEGER }
			: reminderDue(snap.used_weighted_tokens, config.reminderInterval, lastReminderIndex);
		if (!due.due) return undefined;
		lastReminderIndex = due.index;
		return {
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: renderBudgetContext(snap) }],
					timestamp: Date.now(),
				},
				...event.messages,
			],
		};
	});

	(pi as unknown as { __rolloutBudgetInternals?: unknown }).__rolloutBudgetInternals = {
		loadConfig,
		usageWeighted,
		appendUsage,
		readUsedWeightedTokens,
		snapshotBudget,
		renderBudgetContext,
		reminderDue,
		assistantUsage,
	};
}
