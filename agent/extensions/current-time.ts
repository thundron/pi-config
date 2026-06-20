// Current-time tool/reminder aligned with Codex's clock current-time feature.
//
// Codex sources:
//   codex-rs/core/src/current_time.rs
//   codex-rs/core/src/context/current_time_reminder.rs
//   codex-rs/core/src/session/time_reminder.rs
//   codex-rs/core/src/tools/handlers/current_time.rs
//
// Codex exposes a namespaced `clock.curr_time` tool and optional periodic
// developer reminders. Pi tools are plain names in this extension layer, so we
// expose `current_time` with the same output shape and text fragment:
//   { current_time: "YYYY-MM-DD HH:MM:SS UTC" }
//   It is YYYY-MM-DD HH:MM:SS UTC.
//
// Reminder injection is opt-in to avoid adding clock noise to every request:
//   PI_CURRENT_TIME_REMINDER_INTERVAL=0   disabled (default)
//   PI_CURRENT_TIME_REMINDER_INTERVAL=N   inject on first request and every N
//                                         model requests thereafter.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CurrentTimeParams = Type.Object({}, { additionalProperties: false });

export function formatUtcTime(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function renderCurrentTimeReminder(currentTime: string): string {
	return `It is ${currentTime}.`;
}

export function parseReminderInterval(raw: string | undefined): number {
	if (!raw) return 0;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(10_000, n);
}

export function reminderDue(requestsSinceDelivery: number, interval: number): boolean {
	if (interval <= 0) return false;
	// Inject on the first request after session start/resume, then every N.
	return requestsSinceDelivery === 0 || requestsSinceDelivery >= interval;
}

export default function (pi: ExtensionAPI) {
	const interval = parseReminderInterval(process.env.PI_CURRENT_TIME_REMINDER_INTERVAL);
	let modelRequestsSinceDelivery = 0;

	pi.registerTool({
		name: "current_time",
		label: "current time",
		description: "Return the current time in UTC.",
		promptSnippet: "current_time: return the current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC.",
		parameters: CurrentTimeParams,
		async execute() {
			const currentTime = formatUtcTime();
			return {
				content: [{ type: "text" as const, text: renderCurrentTimeReminder(currentTime) }],
				details: { current_time: currentTime },
			};
		},
	});

	pi.on("session_start", async () => {
		modelRequestsSinceDelivery = 0;
	});
	pi.on("session_tree", async () => {
		// Treat branch/window changes like Codex treats a new context window: the
		// next model request is eligible for a fresh reminder.
		modelRequestsSinceDelivery = 0;
	});

	pi.on("context", async (event, _ctx: ExtensionContext) => {
		if (interval <= 0) return undefined;
		const due = reminderDue(modelRequestsSinceDelivery, interval);
		modelRequestsSinceDelivery = due ? 1 : modelRequestsSinceDelivery + 1;
		if (!due) return undefined;
		const currentTime = formatUtcTime();
		return {
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: renderCurrentTimeReminder(currentTime) }],
					timestamp: Date.now(),
				},
				...event.messages,
			],
		};
	});

	(pi as unknown as { __currentTimeInternals?: unknown }).__currentTimeInternals = {
		formatUtcTime,
		renderCurrentTimeReminder,
		parseReminderInterval,
		reminderDue,
	};
}
