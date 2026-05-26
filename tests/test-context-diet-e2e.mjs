#!/usr/bin/env node
// End-to-end smoke test for context-diet: spawn a real pi --mode rpc process,
// send a prompt (which triggers the agent loop and `context` event firing),
// then read /context-diet and assert the extension actually ran in-process
// (calls processed > 0). The trimming math itself is covered exhaustively by
// tests/test-context-diet.mjs against the same factory.
// Usage: bun run tests/test-context-diet-e2e.mjs

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const ROOT = mkdtempSync(join(tmpdir(), "ctx-diet-e2e-"));
mkdirSync(join(ROOT, ".pi"), { recursive: true });

const env = { ...process.env, PI_NO_SPOOF: "1", PI_OFFLINE: "1" };
delete env.PI_GUARDIAN_LOADED;

const proc = spawn(
	"pi",
	["--mode", "rpc", "--no-context-files", "--no-tools", "--session-dir", join(ROOT, ".pi")],
	{ env, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
);

let statsDumpText = "";
let buf = "";
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let obj;
		try { obj = JSON.parse(line); } catch { continue; }
		if (obj.method === "notify" && (obj.message || "").includes("calls processed")) {
			statsDumpText = obj.message;
		}
	}
});
proc.stderr.on("data", () => {});

await new Promise((r) => setTimeout(r, 1800)); // warmup
// One prompt → triggers agent loop → context event fires (even in offline mode,
// pi still goes through the agent loop; the LLM call errors out but `context`
// has already fired before that).
proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "hello" }) + "\n");
await new Promise((r) => setTimeout(r, 3000));
proc.stdin.write(JSON.stringify({ id: "p2", type: "prompt", message: "/context-diet" }) + "\n");
await new Promise((r) => setTimeout(r, 1500));
proc.stdin.write(JSON.stringify({ id: "end", type: "abort" }) + "\n");
await new Promise((r) => setTimeout(r, 500));
try { proc.stdin.end(); } catch {}
await new Promise((r) => { proc.on("exit", r); setTimeout(r, 3000); });

console.log("=== /context-diet output captured ===");
console.log(statsDumpText || "(no stats notify captured)");

function pluck(s, key) {
	const m = s.match(new RegExp(`^${key}\\s*[:=]\\s*(.+)$`, "m"));
	return m ? m[1].trim() : "";
}
const callsStr = pluck(statsDumpText, "calls processed");
const calls = parseInt(callsStr, 10);
const tokOrigStr = pluck(statsDumpText, "tokens original");
const ctxWindow = pluck(statsDumpText, "context window");

let pass = 0, fail = 0;
function ok(label, cond, hint = "") {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}  ${hint}`); }
}

console.log("\n=== assertions ===");
ok("status notify captured (extension loaded in real pi)", statsDumpText !== "");
ok("context event fired at least once during the LLM call (calls processed > 0)",
   calls > 0, `calls=${calls}`);
ok("token counter is non-zero (proves estimateTokens import succeeded)",
   tokOrigStr !== "0t" && tokOrigStr !== "", `tokens original="${tokOrigStr}"`);
ok("live context-window value surfaced via ctx.getContextUsage()",
   /\d{1,3}(,\d{3})*\s*tok/.test(ctxWindow), `context window="${ctxWindow}"`);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
