/**
 * fleet-citizen.ts — back-compat stub.
 *
 * The fleet-citizen extension was renamed and restructured against codex
 * shapes (agent-role + execpolicy + rituals) → see `guardian.ts` in this
 * directory.
 *
 * This stub stays in the repo because the legacy pi-fleet Python
 * supervisor hardcodes `~/.pi/agent/extensions/fleet-citizen.ts` (see
 * supervisor.py:265). It re-exports the guardian extension factory so old
 * pi-fleet invocations keep loading the same behavior, now under the
 * codex-aligned name.
 *
 * If your install.sh symlinks fleet-citizen.ts (which it should for back-
 * compat), pi will auto-discover it AND `guardian.ts`. Loading both is a
 * no-op duplicate (guardian.ts registers commands; the second registration
 * overwrites the first identically), but to be safe this stub no-ops when
 * a `PI_GUARDIAN_LOADED` env var is set by an earlier guardian invocation.
 *
 * Author: pi self-replication exercise.
 * License: MIT
 */

import guardian from "./guardian.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fleetCitizenLegacyStub(pi: ExtensionAPI): void {
	// Just delegate. guardian() itself owns the load-once sentinel so the
	// invocation order between guardian.ts and fleet-citizen.ts doesn't
	// matter — the first call through wins, the second no-ops.
	guardian(pi);
}
