#!/usr/bin/env python3
"""
Hardening test harness for the pi-config extensions.

Drives `pi --mode rpc` with a battery of slash-command scenarios per extension.
Reports per-extension pass/fail with `extension_error` events surfaced as
failures. Designed to never deadlock:

  * One subprocess per extension (parallel-safe; we run sequentially for
    readability + low resource use).
  * Hard wall-clock timeout per extension (default 15s).
  * Warm-up sleep BEFORE the first prompt so extension session_start handlers
    finish before commands are processed (pi takes ~1.5s to load 13 extensions).
  * Skip-list for scenarios that inherently hang in rpc mode (e.g. /test-approval
    if its timeout is longer than per-scenario tolerance).

Usage:
    python3 tests/harness.py [extension-name ...]

Exits non-zero on any failure.
"""

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
from typing import Callable, List, Optional


# ─── Tunables ──────────────────────────────────────────────────────────────

WARMUP_BEFORE_FIRST_PROMPT_SEC = 1.5  # let extension session_start finish
DEFAULT_SLEEP_AFTER_PROMPT_SEC = 0.6
PER_EXTENSION_HARD_TIMEOUT_SEC = 25
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
            Scenario("pause", "/goal pause", streaming="steer", expect_notify_contains="paused"),
            Scenario("resume", "/goal resume", streaming="steer", expect_notify_contains="active"),
            Scenario("done", "/goal done shipped", streaming="steer", expect_notify_contains="complete"),
            Scenario("clear", "/goal clear", streaming="steer", expect_notify_contains="cleared"),
            Scenario("huge objective", "/goal " + "x" * 5000, expect_notify_contains="too long", expect_notify_type="warning"),
        ],
    )


def s_subagents() -> ExtensionTest:
    return ExtensionTest(
        name="subagents",
        scenarios=[
            Scenario("ls empty", "/subagents", expect_notify_contains="No active sub-agents"),
            Scenario("ls alias", "/subagents ls", expect_notify_contains="No active sub-agents"),
            Scenario("unknown sub", "/subagents notreal", expect_notify_contains="Unknown subcommand"),
            Scenario("cap valid", "/subagents cap 4", expect_notify_contains="4"),
            Scenario("cap zero", "/subagents cap 0", expect_notify_contains="Invalid"),
            Scenario("cap huge", "/subagents cap 999999", expect_notify_contains="Invalid"),
            Scenario("abort none", "/subagents abort", expect_notify_contains="No matching"),
            Scenario("fire missing", "/subagents fire /tmp/does-not-exist.json", expect_notify_contains="failed", expect_notify_type="error"),
        ],
    )


def s_codex_cli_extras() -> ExtensionTest:
    # /test-approval is intentionally SKIPPED here. Its dialog has a 30s
    # internal timeout (verified by the timeout fix); running it in the
    # harness adds 30s to every run with no useful signal.
    return ExtensionTest(
        name="codex-cli-extras",
        scenarios=[
            Scenario("diff non-repo", "/diff", expect_notify_contains="not inside a git repository", expect_notify_type="warning"),
            Scenario("review uncommitted (non-repo prompt-warn)", "/review", expect_notify_contains="current changes"),
            Scenario("review missing branch", "/review base", streaming="steer", expect_notify_contains="Usage"),
            Scenario("feedback", "/feedback", streaming="steer", expect_notify_contains="feedback"),
            Scenario("rollout no session", "/rollout", expect_notify_contains="Rollout"),
        ],
    )


def s_side_conversation() -> ExtensionTest:
    return ExtensionTest(
        name="side-conversation",
        scenarios=[
            Scenario("side before conv", "/side hi", expect_notify_contains="unavailable until the conversation has started", expect_notify_type="warning"),
            Scenario("return when no side", "/return", expect_notify_contains="Not inside a side conversation"),
        ],
    )


def s_plan_mode() -> ExtensionTest:
    return ExtensionTest(
        name="plan-mode",
        scenarios=[
            Scenario("plan on", "/plan", expect_notify_contains="Plan mode ON"),
            Scenario("plan idempotent", "/plan", expect_notify_contains="Already in plan mode"),
            Scenario("execute off", "/execute", expect_notify_contains="Plan mode OFF"),
            Scenario("execute idempotent", "/execute", expect_notify_contains="Not in plan mode"),
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
            Scenario("show content", "/memories", expect_notify_contains="test fact alpha"),
            Scenario("where", "/memories where", expect_notify_contains="MEMORY.md"),
            Scenario("invalid sub", "/memories beep", expect_notify_contains="Unknown subcommand", expect_notify_type="warning"),
            Scenario("add empty", "/memories add", expect_notify_contains="Usage", expect_notify_type="warning"),
            Scenario("clear", "/memories clear", expect_notify_contains="Deleted"),
            Scenario("clear noop", "/memories clear", expect_notify_contains="already absent"),
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
            Scenario("bg cleanup", "/bg cleanup", expect_notify_contains="Purged"),
            Scenario("bg no sub", "/bg", expect_notify_contains="Usage"),
        ],
    )


def s_terminal_title() -> ExtensionTest:
    return ExtensionTest(
        name="terminal-title",
        scenarios=[
            Scenario("show empty", "/title", expect_notify_contains="No custom title"),
            Scenario("set", "/title pi · {cwd}", expect_notify_contains="Rendered"),
            Scenario("show set", "/title", expect_notify_contains="Current title template"),
            Scenario("off", "/title off", expect_notify_contains="cleared"),
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
            Scenario("pets off", "/pets off", expect_notify_contains="hidden"),
            Scenario("pets off noop", "/pets off", expect_notify_contains="No pet"),
            Scenario("pets invalid", "/pets dragon", expect_notify_contains="Unknown", expect_notify_type="warning"),
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
    "guardian": s_guardian(),
}


# ─── Runner ──────────────────────────────────────────────────────────────


def run_extension_test(test: ExtensionTest) -> tuple[bool, List[str], int]:
    """
    Run one extension's scenarios in a single pi --mode rpc subprocess with
    a hard wall-clock timeout. Returns (passed, failure_reasons, notify_count).
    """

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
        env = {
            **os.environ,
            "PI_NO_SPOOF": "1",
            "PI_OFFLINE": "1",
        }

        with open(out_path, "wb") as outf:
            proc = subprocess.Popen(
                rpc_args,
                cwd=cwd,
                stdin=subprocess.PIPE,
                stdout=outf,
                stderr=subprocess.STDOUT,
                env=env,
            )

            # Writer thread feeds scenarios with per-scenario sleeps. Daemon
            # so a hung writer doesn't keep the process alive.
            def writer() -> None:
                try:
                    assert proc.stdin is not None
                    time.sleep(WARMUP_BEFORE_FIRST_PROMPT_SEC)
                    for s in test.scenarios:
                        rpc: dict = {"id": s.name, "type": "prompt", "message": s.prompt}
                        if s.streaming is not None:
                            rpc["streamingBehavior"] = s.streaming
                        proc.stdin.write((json.dumps(rpc) + "\n").encode())
                        proc.stdin.flush()
                        time.sleep(s.sleep)
                    proc.stdin.write(b'{"id":"final-abort","type":"abort"}\n')
                    proc.stdin.flush()
                    time.sleep(0.3)
                    try:
                        proc.stdin.close()
                    except BrokenPipeError:
                        pass
                except Exception as e:
                    failures.append(f"writer exception: {e}")

            w = threading.Thread(target=writer, daemon=True)
            w.start()

            # Compute wall-clock budget: warmup + sum of scenario sleeps + per-scenario overhead.
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

        # Parse captured output
        ext_errors: List[dict] = []
        notifies: List[dict] = []
        with open(out_path, "rb") as inf:
            for line in inf:
                try:
                    obj = json.loads(line.decode("utf-8", errors="replace"))
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

        # Notify-content checks (best-effort: notifies are not 1:1 with scenarios,
        # so we just require that each expectation matches at least one notify
        # somewhere in the captured stream).
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
