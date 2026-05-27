/**
 * pets — pi extension that ports codex's `/pets` terminal pet.
 *
 * Animates a small ASCII pet in the pi footer via `ctx.ui.setStatus`. Pure
 * delight; no functional value. Codex renders pets in a dedicated TUI cell;
 * pi extensions get the footer slot, which is close enough.
 *
 * codex source: codex-rs/tui/src/pets/* + tui/src/chatwidget/pets.rs +
 *               tui/src/slash_command.rs (SlashCommand::Pets)
 *
 * Usage:
 *   /pets               show available pets + current selection
 *   /pets <name>        adopt a pet (one of: dog, cat, fish, snake, hamster)
 *   /pets off           hide the pet
 *
 * Pet state persists across session resumes via `custom_message` entries on
 * the branch (same pattern goal-mode / plan-mode / personality use).
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Pet registry ──────────────────────────────────────────────────────────

type PetName = "dog" | "cat" | "fish" | "snake" | "hamster";

interface Pet {
	name: PetName;
	frames: string[];
	frameMs: number;
	label: string;
}

const PETS: Record<PetName, Pet> = {
	dog: {
		name: "dog",
		label: "Dog",
		frameMs: 600,
		frames: ["🐕 woof", "🐕 wag wag", "🐕‍🦺 sniff", "🐕 woof"],
	},
	cat: {
		name: "cat",
		label: "Cat",
		frameMs: 800,
		frames: ["🐈 purr", "🐈‍⬛ stare", "🐈 (=^.^=)", "🐈 zzz"],
	},
	fish: {
		name: "fish",
		label: "Fish",
		frameMs: 500,
		frames: ["🐠 <)))><", "🐟 ><)))°>", "🐠 ><((((°>", "🐟 <°)))><"],
	},
	snake: {
		name: "snake",
		label: "Snake",
		frameMs: 700,
		frames: ["🐍 ~", "🐍 ~~", "🐍 ~~~", "🐍 ~~"],
	},
	hamster: {
		name: "hamster",
		label: "Hamster",
		frameMs: 400,
		frames: ["🐹 *nibble*", "🐹 *chew*", "🐹 *scurry*", "🐹 *peek*"],
	},
};

// ─── State persistence ─────────────────────────────────────────────────────

interface PetSetEntry {
	name: PetName | "off";
	t: number;
}

const STATUS_KEY = "pets";

function findActivePet(ctx: ExtensionContext): PetName | undefined {
	const branch = ctx.sessionManager.getBranch();
	let active: PetName | "off" | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === "pets/set") {
			active = (entry.details as PetSetEntry).name;
		}
	}
	return active === "off" || active === undefined ? undefined : active;
}

function isPetName(value: string): value is PetName {
	return value in PETS;
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let active: PetName | undefined;
	let frameIdx = 0;
	let timer: NodeJS.Timeout | undefined;

	const stopAnim = (ctx: ExtensionContext): void => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const startAnim = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !active) {
			stopAnim(ctx);
			return;
		}
		const pet = PETS[active];
		frameIdx = 0;
		ctx.ui.setStatus(STATUS_KEY, pet.frames[0]);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (!ctx.hasUI || !active) {
				stopAnim(ctx);
				return;
			}
			frameIdx = (frameIdx + 1) % pet.frames.length;
			ctx.ui.setStatus(STATUS_KEY, pet.frames[frameIdx]);
		}, pet.frameMs);
		// Allow node to exit even when the timer is pending.
		if (typeof timer.unref === "function") timer.unref();
	};

	const recompute = (ctx: ExtensionContext): void => {
		active = findActivePet(ctx);
		if (active) startAnim(ctx);
		else stopAnim(ctx);
	};

	pi.on("session_start", async (_event, ctx) => recompute(ctx));
	pi.on("session_tree", async (_event, ctx) => recompute(ctx));
	pi.on("session_shutdown", async (_event, ctx) => stopAnim(ctx));

	pi.registerCommand("pets", {
		description:
			"Adopt a terminal pet that animates in the pi footer (codex port). Usage: /pets | /pets <name> | /pets off",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs.trim().toLowerCase();

			if (!args || args === "show" || args === "ls" || args === "list") {
				const lines: string[] = [];
				lines.push("Available pets:");
				for (const pet of Object.values(PETS)) {
					const marker = pet.name === active ? "▶" : " ";
					lines.push(`  ${marker} ${pet.name.padEnd(8)} ${pet.frames[0]}`);
				}
				lines.push("");
				lines.push(
					active
						? `Current: ${PETS[active].label}. /pets off to hide.`
						: "Current: (no pet). /pets <name> to adopt.",
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (args === "off" || args === "hide" || args === "none") {
				if (!active) {
					ctx.ui.notify("No pet to hide.", "info");
					return;
				}
				pi.sendMessage<PetSetEntry>({
					customType: "pets/set",
					content: "pet hidden",
					display: false,
					details: { name: "off", t: Date.now() },
				});
				active = undefined;
				stopAnim(ctx);
				ctx.ui.notify("Pet hidden.", "info");
				return;
			}

			if (!isPetName(args)) {
				ctx.ui.notify(
					`Unknown pet "${args}".\n\nAvailable: ${Object.keys(PETS).join(", ")}, off`,
					"warning",
				);
				return;
			}

			if (active === args) {
				ctx.ui.notify(`Already adopting ${PETS[args].label}. ${PETS[args].frames[0]}`, "info");
				return;
			}

			pi.sendMessage<PetSetEntry>({
				customType: "pets/set",
				content: `pet set to ${args}`,
				display: false,
				details: { name: args, t: Date.now() },
			});
			active = args;
			startAnim(ctx);
			ctx.ui.notify(
				`${PETS[args].frames[0]} ${PETS[args].label} is now visiting your footer. /pets off to dismiss.`,
				"info",
			);
		},

		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const opts = [
				...Object.values(PETS).map((p) => ({
					value: p.name,
					description: p.frames[0],
				})),
				{ value: "off", description: "hide the pet" },
				{ value: "show", description: "list available pets" },
			];
			const p = prefix.trim().toLowerCase();
			return opts
				.filter((o) => o.value.startsWith(p))
				.map((o) => ({ value: o.value, label: o.value, description: o.description }));
		},
	});
}
