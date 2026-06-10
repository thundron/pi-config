#!/usr/bin/env node
// End-to-end smoke test for context-diet: spawn a real pi --mode rpc process,
// send a prompt (which triggers the agent loop and `context` event firing),
// then read /context-diet and assert the extension actually ran in-process
// (calls processed > 0). The trimming math itself is covered exhaustively by
// tests/test-context-diet.mjs against the same factory.
//
// Driven by RPC events, not fixed sleeps: it waits for pi to signal readiness,
// for the prompt's turn to end, and for the stats notify to arrive. That keeps
// it deterministic even when the machine is busy (e.g. running in the full
// suite right after the typecheck/tsc step), where a fixed warmup would race
// pi's startup and the prompt would land before the agent loop is ready.
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

// ─── event-driven RPC reader ───────────────────────────────────────────────
// Collect every parsed RPC object; waitFor() resolves against already-seen
// objects or the next one that matches, and rejects after a generous timeout.

const events = [];
const waiters = [];
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
		events.push(obj);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(obj)) {
				clearTimeout(waiters[i].timer);
				waiters[i].resolve(obj);
				waiters.splice(i, 1);
			}
		}
	}
});
proc.stderr.on("data", () => {});

function waitFor(pred, timeoutMs, label) {
	const existing = events.find(pred);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const idx = waiters.findIndex((w) => w.timer === timer);
			if (idx >= 0) waiters.splice(idx, 1);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`));
		}, timeoutMs);
		waiters.push({ pred, resolve, timer });
	});
}

function send(msg) {
	proc.stdin.write(JSON.stringify(msg) + "\n");
}

const isStatus = (key) => (o) => o.method === "setStatus" && o.statusKey === key;
const isAgentEnd = (o) => o.type === "agent_end";
const isStatsNotify = (o) => o.method === "notify" && typeof o.message === "string" && o.message.includes("calls processed");

let statsDumpText = "";
let setupError = "";
try {
	// 1. Extensions loaded → context-diet emits its initial footer status.
	await waitFor(isStatus("context-diet"), 20000, "context-diet extension to load");
	// 2. One prompt → agent loop runs → `context` fires before the (offline) LLM
	//    call errors out. agent_end marks the turn complete.
	send({ id: "p1", type: "prompt", message: "hello" });
	await waitFor(isAgentEnd, 30000, "p1 turn to end (agent_end)");
	// 3. Ask the extension to dump its stats and wait for the notify.
	send({ id: "p2", type: "prompt", message: "/context-diet" });
	const notify = await waitFor(isStatsNotify, 20000, "/context-diet stats notify");
	statsDumpText = notify.message;
} catch (e) {
	setupError = e instanceof Error ? e.message : String(e);
}

send({ id: "end", type: "abort" });
try { proc.stdin.end(); } catch {}
await new Promise((r) => {
	proc.on("exit", r);
	setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} r(); }, 3000);
});

console.log("=== /context-diet output captured ===");
console.log(statsDumpText || `(no stats notify captured${setupError ? `: ${setupError}` : ""})`);

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
ok("status notify captured (extension loaded in real pi)", statsDumpText !== "", setupError);
ok("context event fired at least once during the LLM call (calls processed > 0)",
   calls > 0, `calls=${calls}`);
ok("token counter is non-zero (proves estimateTokens import succeeded)",
   tokOrigStr !== "0t" && tokOrigStr !== "", `tokens original="${tokOrigStr}"`);
ok("live context-window value surfaced via ctx.getContextUsage()",
   /\d{1,3}(,\d{3})*\s*tok/.test(ctxWindow), `context window="${ctxWindow}"`);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
