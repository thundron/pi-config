import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded explicitly by bin/pi; never registered globally.
export default function anthropicPrompt(pi: ExtensionAPI) {
	const file = process.env.PI_PROMPT_FILE;
	if (!file) return;
	const prompt = readFileSync(file, "utf8").replace(/\n+$/, "");
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const options = event.systemPromptOptions;
		if (!options || options.forceSystemPrompt !== undefined) return;
		// Render as --system-prompt would, including appended instructions and
		// project context. Keep the provider-specific preamble out of the shared
		// transcript so it isn't replayed to a different provider after /model.
		const previous = options.customPrompt;
		try {
			options.customPrompt = prompt;
			return { systemPrompt: event.systemPrompt };
		} finally {
			options.customPrompt = previous;
		}
	});
}
