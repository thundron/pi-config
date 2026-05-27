// --import shim: register the stub-hook so subsequent imports of pi's nested
// workspace packages resolve to harmless stubs instead of ERR_MODULE_NOT_FOUND.
//
// Usage:  node --import ./tests/lib/stub-hook-register.mjs <test>.mjs
import { register, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), "stub-hook.mjs");
const HOOK_URL = pathToFileURL(HOOK_PATH).href;

// Prefer the synchronous registerHooks() API (node 22.13+), which is not
// deprecated. Fall back to register() which works on older node.
if (typeof registerHooks === "function") {
	const mod = await import(HOOK_URL);
	if (typeof mod.resolveSync === "function" && typeof mod.loadSync === "function") {
		registerHooks({ resolve: mod.resolveSync, load: mod.loadSync });
	} else {
		register(HOOK_URL);
	}
} else {
	register(HOOK_URL);
}
