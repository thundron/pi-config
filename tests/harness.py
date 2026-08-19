#!/usr/bin/env python3
# Drives `pi --mode rpc` with slash-command scenarios per extension.
# Three threads per child: writer (feeds prompts), dialog-responder (auto-replies to
# confirm/select/input extension_ui_request so /test-approval etc. don't deadlock),
# main (wait + parse). No skip-list — every registered command must be exercised.
# Usage: python3 tests/harness.py [extension-name ...]

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional


# ─── Tunables ──────────────────────────────────────────────────────────────

WARMUP_BEFORE_FIRST_PROMPT_SEC = 1.5  # let extension session_start finish
DEFAULT_SLEEP_AFTER_PROMPT_SEC = 0.6
PER_EXTENSION_HARD_TIMEOUT_SEC = 30
SUBPROCESS_KILL_GRACE_SEC = 3


# ─── Scenario definitions ────────────────────────────────────────────────


@dataclass
class Scenario:
    name: str
    prompt: str
    sleep: float = DEFAULT_SLEEP_AFTER_PROMPT_SEC
    streaming: Optional[str] = None
    # Substring expected in any notify produced by this scenario; None = don't check.
    expect_notify_contains: Optional[str] = None
    expect_notify_type: Optional[str] = None


@dataclass
class ExtensionTest:
    name: str
    scenarios: List[Scenario]
    extra_flags: List[str] = field(default_factory=list)
    setup: Optional[Callable[[str], None]] = None
    # Override the default "accept everything" dialog answer per method.
    # Map method name → response payload (merged into the response object).
    # Default for unknown methods: see DEFAULT_DIALOG_RESPONSES below.
    dialog_responses: Dict[str, dict] = field(default_factory=dict)


# Canned dialog responses by request method; merged into the response payload.
DEFAULT_DIALOG_RESPONSES: Dict[str, dict] = {
    "confirm": {"confirmed": True},
    "select": {"value": "ok"},  # may be overridden per-extension with a real option value
    "input":   {"value": "harness-input"},
    "editor":  {"value": "harness-editor"},
}


def s_goal_mode() -> ExtensionTest:
    return ExtensionTest(
        name="goal-mode",
        scenarios=[
            Scenario("show empty", "/goal", expect_notify_contains="No active goal"),
            Scenario("set objective", "/goal hardening sanity"),
            Scenario("show after set", "/goal", streaming="steer", expect_notify_contains="hardening sanity"),
            # formatTokens(1000) -> "1.0k"; formatTokens(2_500_000) -> "2500k".
            Scenario("budget 1k", "/goal budget 1k", streaming="steer", expect_notify_contains="1.0k"),
            Scenario("invalid budget", "/goal budget abc", streaming="steer", expect_notify_contains="Invalid budget", expect_notify_type="warning"),
            Scenario("budget 2.5m", "/goal budget 2.5m", streaming="steer", expect_notify_contains="2500k"),
            Scenario("budget clear", "/goal budget none", streaming="steer", expect_notify_contains="cleared"),
            Scenario("budget zero-clears", "/goal budget 0", streaming="steer", expect_notify_contains="cleared"),
            Scenario("budget off", "/goal budget off", streaming="steer", expect_notify_contains="cleared"),
            Scenario("pause", "/goal pause", streaming="steer", expect_notify_contains="paused"),
            Scenario("resume", "/goal resume", streaming="steer", expect_notify_contains="active"),
            Scenario("pause again", "/goal pause", streaming="steer", expect_notify_contains="paused"),
            Scenario("unpause alias", "/goal unpause", streaming="steer", expect_notify_contains="active"),
            Scenario("block alias", "/goal block stuck on X", streaming="steer", expect_notify_contains="blocked"),
            Scenario("resume from block", "/goal resume", streaming="steer", expect_notify_contains="active"),
            Scenario("blocked subcmd", "/goal blocked still stuck", streaming="steer", expect_notify_contains="blocked"),
            Scenario("complete alias", "/goal complete shipped", streaming="steer", expect_notify_contains="complete"),
            # Goal got cleared by 'complete' path? Check by re-setting then 'done'.
            Scenario("set again", "/goal second goal", streaming="steer"),
            Scenario("done", "/goal done shipped", streaming="steer", expect_notify_contains="complete"),
            # Once a goal/set entry exists on the branch, clear is idempotent
            # (reconstructGoal still rebuilds it with status=complete).
            Scenario("set for clear-test", "/goal third goal", streaming="steer"),
            Scenario("remove alias", "/goal remove", streaming="steer", expect_notify_contains="cleared"),
            Scenario("clear idempotent", "/goal clear", streaming="steer", expect_notify_contains="cleared"),
            Scenario("set for delete-test", "/goal fourth", streaming="steer"),
            Scenario("delete alias", "/goal delete", streaming="steer", expect_notify_contains="cleared"),
            Scenario("huge objective", "/goal " + "x" * 5000, expect_notify_contains="too long", expect_notify_type="warning"),
        ],
    )


def s_subagents() -> ExtensionTest:
    return ExtensionTest(
        name="subagents",
        scenarios=[
            Scenario("ls empty", "/subagents", expect_notify_contains="No active sub-agents"),
            Scenario("ls alias", "/subagents ls", expect_notify_contains="No active sub-agents"),
            Scenario("status alias", "/subagents status", expect_notify_contains="No active sub-agents"),
            Scenario("unknown sub", "/subagents notreal", expect_notify_contains="Unknown subcommand"),
            Scenario("cap valid", "/subagents cap 4", expect_notify_contains="4"),
            Scenario("cap zero", "/subagents cap 0", expect_notify_contains="Invalid"),
            Scenario("cap huge", "/subagents cap 999999", expect_notify_contains="Invalid"),
            Scenario("cap non-numeric", "/subagents cap abc", expect_notify_contains="Invalid"),
            Scenario("abort none", "/subagents abort", expect_notify_contains="No matching"),
            Scenario("kill alias none", "/subagents kill", expect_notify_contains="No matching"),
            Scenario("fire missing", "/subagents fire /tmp/does-not-exist.json", expect_notify_contains="failed", expect_notify_type="error"),
            Scenario("fire no path", "/subagents fire", expect_notify_contains="Usage"),
        ],
    )


def s_codex_cli_extras() -> ExtensionTest:
    def setup(cwd: str) -> None:
        # /init checks AGENTS.md — pre-create it to deterministically hit the guard.
        (Path(cwd) / "AGENTS.md").write_text("# pre-existing AGENTS.md (harness)\n")

    return ExtensionTest(
        name="codex-cli-extras",
        scenarios=[
            Scenario("diff non-repo", "/diff", expect_notify_contains="not inside a git repository", expect_notify_type="warning"),
            Scenario("review uncommitted", "/review", expect_notify_contains="current changes"),
            Scenario("review missing branch", "/review base", streaming="steer", expect_notify_contains="Usage"),
            Scenario("review base alias", "/review branch", streaming="steer", expect_notify_contains="Usage"),
            Scenario("review missing commit", "/review commit", streaming="steer", expect_notify_contains="Usage"),
            Scenario("review custom text", "/review look at perf hotspots", streaming="steer", expect_notify_contains="perf hotspots"),
            Scenario("feedback", "/feedback", streaming="steer", expect_notify_contains="feedback"),
            Scenario("rollout no session", "/rollout", expect_notify_contains="Rollout"),
            # AGENTS.md pre-created in setup → hits the "already exists" guard.
            Scenario("init existing", "/init", expect_notify_contains="already exists", expect_notify_type="warning"),
            # dialog-responder auto-confirms + picks "alpha" → final notify is "flow complete".
            Scenario("test-approval", "/test-approval", sleep=2.5, expect_notify_contains="flow complete"),
        ],
        setup=setup,
        dialog_responses={"select": {"value": "alpha"}},
    )


def s_side_conversation() -> ExtensionTest:
    return ExtensionTest(
        name="side-conversation",
        scenarios=[
            Scenario("side before conv", "/side hi", expect_notify_contains="unavailable until the conversation has started", expect_notify_type="warning"),
            Scenario("btw alias before conv", "/btw hi", expect_notify_contains="unavailable until the conversation has started", expect_notify_type="warning"),
            Scenario("return when no side", "/return", expect_notify_contains="Not inside a side conversation"),
        ],
    )


def s_plan_mode() -> ExtensionTest:
    return ExtensionTest(
        name="plan-mode",
        scenarios=[
            Scenario("plan on", "/plan", expect_notify_contains="Plan mode ON"),
            Scenario("plan idempotent", "/plan", expect_notify_contains="Already in plan mode"),
            # /execute is the "execute" collaboration mode since the codex
            # collaboration-modes port: it exits plan mode and restores tools.
            Scenario("execute off", "/execute", expect_notify_contains="Collaboration mode set to execute"),
            Scenario("execute idempotent", "/execute", expect_notify_contains="Tools restored to"),
        ],
    )


def s_memories() -> ExtensionTest:
    def setup(_cwd: str) -> None:
        mp = Path.home() / ".pi" / "memories" / "MEMORY.md"
        if mp.exists():
            mp.unlink()

    return ExtensionTest(
        name="memories",
        scenarios=[
            Scenario("show empty", "/memories", expect_notify_contains="No memory file"),
            Scenario("add", "/memories add test fact alpha", expect_notify_contains="Saved"),
            Scenario("save alias", "/memories save test fact beta", expect_notify_contains="Saved"),
            Scenario("show content", "/memories", expect_notify_contains="test fact alpha"),
            Scenario("show alias", "/memories show", expect_notify_contains="test fact alpha"),
            Scenario("view alias", "/memories view", expect_notify_contains="test fact alpha"),
            Scenario("ls alias", "/memories ls", expect_notify_contains="test fact alpha"),
            Scenario("where", "/memories where", expect_notify_contains="MEMORY.md"),
            Scenario("path alias", "/memories path", expect_notify_contains="MEMORY.md"),
            Scenario("invalid sub", "/memories beep", expect_notify_contains="Unknown subcommand", expect_notify_type="warning"),
            Scenario("add empty", "/memories add", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("save empty alias", "/memories save", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("clear", "/memories clear", expect_notify_contains="Deleted"),
            Scenario("wipe alias noop", "/memories wipe", expect_notify_contains="already absent"),
            Scenario("rm alias noop", "/memories rm", expect_notify_contains="already absent"),
        ],
        setup=setup,
    )


def s_personality() -> ExtensionTest:
    return ExtensionTest(
        name="personality",
        scenarios=[
            Scenario("show empty", "/personality", expect_notify_contains="(none)"),
            Scenario("set friendly", "/personality friendly", expect_notify_contains="Friendly"),
            Scenario("same idempotent", "/personality friendly", expect_notify_contains="Already on"),
            Scenario("set pragmatic", "/personality pragmatic", expect_notify_contains="Pragmatic"),
            Scenario("off", "/personality off", expect_notify_contains="cleared"),
            Scenario("off noop", "/personality off", expect_notify_contains="No personality"),
            Scenario("unknown", "/personality stoic", expect_notify_contains="Unknown", expect_notify_type="warning"),
        ],
    )


def s_introspection() -> ExtensionTest:
    return ExtensionTest(
        name="introspection",
        scenarios=[
            Scenario("hooks default", "/hooks", expect_notify_contains="Lifecycle events"),
            Scenario("hooks all", "/hooks all", expect_notify_contains="Lifecycle events"),
            Scenario("hooks reset", "/hooks reset", expect_notify_contains="reset"),
            Scenario("tools no filter", "/tools", expect_notify_contains="Tools"),
            Scenario("tools filter", "/tools subagent", expect_notify_contains="subagent"),
            Scenario("mcp alias", "/mcp", expect_notify_contains="Tools"),
            Scenario("mcp filter", "/mcp memory", expect_notify_contains="memory"),
            Scenario("debug-config", "/debug-config", expect_notify_contains="runtime"),
        ],
    )


def s_background_procs() -> ExtensionTest:
    return ExtensionTest(
        name="background-procs",
        scenarios=[
            Scenario("ps empty", "/ps", expect_notify_contains="No tracked background processes"),
            Scenario("stop no arg", "/stop", expect_notify_contains="Usage"),
            Scenario("stop unknown", "/stop bg-999", expect_notify_contains="No tracked"),
            Scenario("stop all empty", "/stop all", expect_notify_contains="No tracked"),
            Scenario("bg cleanup", "/bg cleanup", expect_notify_contains="Purged"),
            Scenario("bg prune alias", "/bg prune", expect_notify_contains="Purged"),
            Scenario("bg no sub", "/bg", expect_notify_contains="Usage"),
            Scenario("bg unknown sub", "/bg notreal", expect_notify_contains="Usage"),
        ],
    )


def s_terminal_title() -> ExtensionTest:
    return ExtensionTest(
        name="terminal-title",
        scenarios=[
            Scenario("show empty", "/title", expect_notify_contains="No custom title"),
            Scenario("show alias", "/title show", expect_notify_contains="No custom title"),
            Scenario("set", "/title pi · {cwd}", expect_notify_contains="Rendered"),
            Scenario("show set", "/title", expect_notify_contains="Current title template"),
            Scenario("off", "/title off", expect_notify_contains="cleared"),
            Scenario("clear alias", "/title 2nd", expect_notify_contains="Rendered"),
            Scenario("clear by clear", "/title clear", expect_notify_contains="cleared"),
            Scenario("set again", "/title 3rd", expect_notify_contains="Rendered"),
            Scenario("none alias", "/title none", expect_notify_contains="cleared"),
        ],
    )


def s_pets() -> ExtensionTest:
    return ExtensionTest(
        name="pets",
        scenarios=[
            Scenario("pets list", "/pets", expect_notify_contains="(no pet)"),
            Scenario("pets cat", "/pets cat", expect_notify_contains="Cat"),
            Scenario("pets same", "/pets cat", expect_notify_contains="Already"),
            Scenario("pets dog", "/pets dog", expect_notify_contains="Dog"),
            Scenario("pets fish", "/pets fish", expect_notify_contains="Fish"),
            Scenario("pets snake", "/pets snake", expect_notify_contains="Snake"),
            Scenario("pets hamster", "/pets hamster", expect_notify_contains="Hamster"),
            Scenario("pets off", "/pets off", expect_notify_contains="hidden"),
            Scenario("pets off noop", "/pets off", expect_notify_contains="No pet"),
            Scenario("pets invalid", "/pets dragon", expect_notify_contains="Unknown", expect_notify_type="warning"),
        ],
    )


def s_context_diet() -> ExtensionTest:
    return ExtensionTest(
        name="context-diet",
        scenarios=[
            Scenario("show default", "/context-diet", expect_notify_contains="enabled:           true"),
            Scenario("status alias", "/context-diet status", expect_notify_contains="calls processed"),
            Scenario("off", "/context-diet off", expect_notify_contains="OFF"),
            Scenario("disable alias", "/context-diet disable", expect_notify_contains="OFF"),
            Scenario("on", "/context-diet on", expect_notify_contains="ON"),
            Scenario("enable alias", "/context-diet enable", expect_notify_contains="ON"),
            Scenario("mode tear-out", "/context-diet mode tear-out", expect_notify_contains="mode = tear-out"),
            Scenario("mode compress", "/context-diet mode compress", expect_notify_contains="mode = compress"),
            Scenario("mode invalid", "/context-diet mode wrongthing", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("keep valid", "/context-diet keep 5", expect_notify_contains="keep recent turns = 5"),
            Scenario("keep zero", "/context-diet keep 0", expect_notify_contains="keep recent turns = 0"),
            Scenario("keep invalid", "/context-diet keep abc", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("max valid", "/context-diet max 16384", expect_notify_contains="max result bytes = 16384"),
            Scenario("max too small", "/context-diet max 10", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("head valid", "/context-diet head 1024", expect_notify_contains="head bytes = 1024"),
            Scenario("head invalid", "/context-diet head -5", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("tail valid", "/context-diet tail 512", expect_notify_contains="tail bytes = 512"),
            Scenario("tail invalid", "/context-diet tail xyz", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("errors preserve", "/context-diet errors preserve", expect_notify_contains="preserve errors = true"),
            Scenario("errors keep alias", "/context-diet errors keep", expect_notify_contains="preserve errors = true"),
            Scenario("errors trim", "/context-diet errors trim", expect_notify_contains="preserve errors = false"),
            Scenario("errors compress alias", "/context-diet errors compress", expect_notify_contains="preserve errors = false"),
            Scenario("errors invalid", "/context-diet errors wrong", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("reset stats", "/context-diet reset", expect_notify_contains="reset"),
            Scenario("unknown sub", "/context-diet notreal", expect_notify_contains="Unknown subcommand", expect_notify_type="warning"),
        ],
    )


def s_guardian() -> ExtensionTest:
    return ExtensionTest(
        name="guardian",
        scenarios=[
            Scenario(
                "guardian",
                "/guardian",
                sleep=1.5,  # /guardian calls gitInfoAsync (skipDirty:false) which is slower
                expect_notify_contains="execpolicy",
            ),
            Scenario(
                "fleet alias",
                "/fleet",
                sleep=1.5,
                expect_notify_contains="banned",
            ),
            # /done and /halt always notify; file writes are AGENT_DIR-gated.
            Scenario(
                "done with arg",
                "/done smoke test",
                sleep=1.5,
                expect_notify_contains="smoke test",
            ),
            Scenario(
                "done no arg",
                "/done",
                sleep=1.5,
                expect_notify_contains="dispatch complete",
            ),
            Scenario(
                "halt with arg",
                "/halt smoke",
                sleep=0.8,
                expect_notify_contains="HALT",
                expect_notify_type="warning",
            ),
            Scenario(
                "halt no arg",
                "/halt",
                sleep=0.8,
                expect_notify_contains="HALT",
                expect_notify_type="warning",
            ),
        ],
    )


ALL: dict[str, ExtensionTest] = {
    "goal-mode": s_goal_mode(),
    "subagents": s_subagents(),
    "codex-cli-extras": s_codex_cli_extras(),
    "side-conversation": s_side_conversation(),
    "plan-mode": s_plan_mode(),
    "memories": s_memories(),
    "personality": s_personality(),
    "introspection": s_introspection(),
    "background-procs": s_background_procs(),
    "terminal-title": s_terminal_title(),
    "pets": s_pets(),
    "context-diet": s_context_diet(),
    "guardian": s_guardian(),
}


# ─── Runner ──────────────────────────────────────────────────────────────


def run_extension_test(test: ExtensionTest) -> tuple[bool, List[str], int]:
    """Run one extension's scenarios in a pi --mode rpc subprocess; return (ok, reasons, notify_count)."""

    failures: List[str] = []
    cwd = tempfile.mkdtemp(prefix=f"pi-harden-{test.name}-")
    out_path = Path(cwd) / "rpc.out"

    try:
        if test.setup is not None:
            test.setup(cwd)

        rpc_args = [
            "pi",
            "--mode",
            "rpc",
            "--no-context-files",
            "--no-tools",
            *test.extra_flags,
            "--session-dir",
            f"{cwd}/.pi",
        ]
        # Scrub legacy `PI_GUARDIAN_LOADED` so a nested pi-in-pi can't disable the child's guardian.
        clean_environ = {
            k: v
            for k, v in os.environ.items()
            if k not in ("PI_GUARDIAN_LOADED",)
        }
        env = {
            **clean_environ,
            "PI_NO_SPOOF": "1",
            "PI_OFFLINE": "1",
        }

        proc = subprocess.Popen(
            rpc_args,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            bufsize=0,
        )

        stdin_lock = threading.Lock()  # writer + dialog-responder both write
        captured_lines: List[bytes] = []
        DIALOG_METHODS = {"confirm", "select", "input", "editor"}

        def dialog_responder() -> None:
            assert proc.stdout is not None
            for raw in proc.stdout:
                captured_lines.append(raw)
                if not raw.strip():
                    continue
                try:
                    obj = json.loads(raw.decode("utf-8", errors="replace"))
                except (json.JSONDecodeError, ValueError):
                    continue
                if obj.get("type") != "extension_ui_request":
                    continue
                method = obj.get("method")
                if method not in DIALOG_METHODS:
                    continue
                req_id = obj.get("id")
                if not req_id:
                    continue
                payload = dict(DEFAULT_DIALOG_RESPONSES.get(method, {}))
                payload.update(test.dialog_responses.get(method, {}))
                response = {
                    "type": "extension_ui_response",
                    "id": req_id,
                    **payload,
                }
                line = (json.dumps(response) + "\n").encode()
                with stdin_lock:
                    if proc.stdin and not proc.stdin.closed:
                        try:
                            proc.stdin.write(line)
                            proc.stdin.flush()
                        except (BrokenPipeError, ValueError):
                            pass

        r = threading.Thread(target=dialog_responder, daemon=True)
        r.start()

        # Writer thread feeds scenarios with per-scenario sleeps.
        def writer() -> None:
            try:
                time.sleep(WARMUP_BEFORE_FIRST_PROMPT_SEC)
                for s in test.scenarios:
                    rpc: dict = {"id": s.name, "type": "prompt", "message": s.prompt}
                    if s.streaming is not None:
                        rpc["streamingBehavior"] = s.streaming
                    line = (json.dumps(rpc) + "\n").encode()
                    with stdin_lock:
                        if proc.stdin and not proc.stdin.closed:
                            proc.stdin.write(line)
                            proc.stdin.flush()
                    time.sleep(s.sleep)
                with stdin_lock:
                    if proc.stdin and not proc.stdin.closed:
                        proc.stdin.write(b'{"id":"final-abort","type":"abort"}\n')
                        proc.stdin.flush()
                time.sleep(0.3)
                with stdin_lock:
                    try:
                        if proc.stdin and not proc.stdin.closed:
                            proc.stdin.close()
                    except BrokenPipeError:
                        pass
            except Exception as e:
                failures.append(f"writer exception: {e}")

        w = threading.Thread(target=writer, daemon=True)
        w.start()

        # Budget = warmup + per-scenario sleeps + 2s overhead, clamped to a floor.
        scenario_budget = (
            WARMUP_BEFORE_FIRST_PROMPT_SEC
            + sum(s.sleep for s in test.scenarios)
            + 2.0
        )
        budget = max(PER_EXTENSION_HARD_TIMEOUT_SEC, int(scenario_budget * 1.5))

        try:
            proc.wait(timeout=budget)
        except subprocess.TimeoutExpired:
            failures.append(f"subprocess did not exit within {budget}s; killing")
            try:
                proc.terminate()
                proc.wait(timeout=SUBPROCESS_KILL_GRACE_SEC)
            except subprocess.TimeoutExpired:
                proc.kill()

        r.join(timeout=1.0)  # drain reader
        out_path.write_bytes(b"".join(captured_lines))  # persist for post-mortem
        ext_errors: List[dict] = []
        notifies: List[dict] = []
        for raw in captured_lines:
            try:
                obj = json.loads(raw.decode("utf-8", errors="replace"))
            except (json.JSONDecodeError, ValueError):
                continue
            if obj.get("type") == "extension_error":
                ext_errors.append(obj)
            if obj.get("method") == "notify":
                notifies.append(obj)

        for err in ext_errors:
            failures.append(
                f"extension_error {err.get('extensionPath', '?')}: {err.get('error', '')[:200]}",
            )

        # Each expect_notify_contains must match at least one notify in the stream.
        for s in test.scenarios:
            if s.expect_notify_contains is None:
                continue
            hit = any(
                s.expect_notify_contains in (n.get("message") or "") for n in notifies
            )
            if not hit:
                failures.append(
                    f"scenario {s.name!r}: expected notify containing "
                    f"{s.expect_notify_contains!r} not found",
                )

        return (len(failures) == 0, failures, len(notifies))

    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def main() -> int:
    selected = sys.argv[1:] if len(sys.argv) > 1 else list(ALL.keys())

    pass_count = 0
    fail_count = 0
    failures: List[tuple[str, List[str]]] = []

    for name in selected:
        if name not in ALL:
            print(f"unknown extension: {name}", file=sys.stderr)
            continue
        test = ALL[name]
        print(f"\n=== {test.name} ({len(test.scenarios)} scenarios) ===", flush=True)
        t0 = time.time()
        ok, reasons, notifies = run_extension_test(test)
        dt = time.time() - t0
        if ok:
            pass_count += 1
            print(f"  ✅ PASS  {dt:.1f}s  ({notifies} notifies captured)")
        else:
            fail_count += 1
            failures.append((test.name, reasons))
            print(f"  ❌ FAIL  {dt:.1f}s  ({len(reasons)} issues)")
            for r in reasons:
                print(f"     - {r}")

    print("\n=== summary ===")
    print(f"  passed: {pass_count}")
    print(f"  failed: {fail_count}")
    if fail_count:
        print(f"  failing: {[n for n, _ in failures]}")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
