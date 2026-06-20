#!/usr/bin/env bash
# Run every test (execpolicy unit → guardian tool_call → RPC harness).
# Usage: run-all.sh | run-all.sh --quick | run-all.sh harness [names...]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mode="${1:-all}"

# Pick a JS runtime: bun preferred (pi itself uses bun for .ts), node fallback.
if command -v bun >/dev/null 2>&1; then
  JS_RUNTIME="bun run"
elif command -v node >/dev/null 2>&1; then
  JS_RUNTIME="node"
else
  echo "tests/run-all.sh: need bun or node on PATH" >&2
  exit 127
fi

run_step() {
  local label="$1"
  shift
  printf '\n══ %s ══\n' "$label"
  "$@"
}

case "$mode" in
  --help|-h)
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --quick)
    run_step "typecheck"              $JS_RUNTIME tests/test-typecheck.mjs
    run_step "autocomplete contract"  $JS_RUNTIME tests/test-autocomplete.mjs
    run_step "execpolicy drift"       $JS_RUNTIME tests/test-execpolicy-drift.mjs
    run_step "execpolicy unit"        $JS_RUNTIME tests/test-execpolicy.mjs
    run_step "guardian tool_call"     $JS_RUNTIME tests/test-guardian-toolcall.mjs
    run_step "goal runtime race"      $JS_RUNTIME tests/test-goal-mode-runtime-race.mjs
    run_step "goal-mode tools"        $JS_RUNTIME tests/test-goal-mode-tools.mjs
    run_step "plan-mode prompt"       $JS_RUNTIME tests/test-plan-mode-prompt.mjs
    run_step "terminal-title"         $JS_RUNTIME tests/test-terminal-title.mjs
    run_step "context-tools"          $JS_RUNTIME tests/test-context-tools.mjs
    run_step "subagents mode"         $JS_RUNTIME tests/test-subagents-mode.mjs
    run_step "agent roles"            $JS_RUNTIME tests/test-agent-roles.mjs
    run_step "context-diet unit"      $JS_RUNTIME tests/test-context-diet.mjs
    run_step "compaction-diet unit"   $JS_RUNTIME tests/test-compaction-diet.mjs
    run_step "context-diet e2e"       $JS_RUNTIME tests/test-context-diet-e2e.mjs
    run_step "tool-pairing-guard"     $JS_RUNTIME tests/test-tool-pairing-guard.mjs
    ;;
  harness)
    shift || true
    run_step "harness ($*)"           python3 tests/harness.py "$@"
    ;;
  all|"")
    run_step "typecheck"              $JS_RUNTIME tests/test-typecheck.mjs
    run_step "autocomplete contract"  $JS_RUNTIME tests/test-autocomplete.mjs
    run_step "execpolicy drift"       $JS_RUNTIME tests/test-execpolicy-drift.mjs
    run_step "execpolicy unit"        $JS_RUNTIME tests/test-execpolicy.mjs
    run_step "guardian tool_call"     $JS_RUNTIME tests/test-guardian-toolcall.mjs
    run_step "goal runtime race"      $JS_RUNTIME tests/test-goal-mode-runtime-race.mjs
    run_step "goal-mode tools"        $JS_RUNTIME tests/test-goal-mode-tools.mjs
    run_step "plan-mode prompt"       $JS_RUNTIME tests/test-plan-mode-prompt.mjs
    run_step "terminal-title"         $JS_RUNTIME tests/test-terminal-title.mjs
    run_step "context-tools"          $JS_RUNTIME tests/test-context-tools.mjs
    run_step "subagents mode"         $JS_RUNTIME tests/test-subagents-mode.mjs
    run_step "agent roles"            $JS_RUNTIME tests/test-agent-roles.mjs
    run_step "context-diet unit"      $JS_RUNTIME tests/test-context-diet.mjs
    run_step "compaction-diet unit"   $JS_RUNTIME tests/test-compaction-diet.mjs
    run_step "context-diet e2e"       $JS_RUNTIME tests/test-context-diet-e2e.mjs
    run_step "tool-pairing-guard"     $JS_RUNTIME tests/test-tool-pairing-guard.mjs
    run_step "harness (all)"          python3 tests/harness.py
    ;;
  *)
    echo "unknown mode: $mode (try --help)" >&2
    exit 2
    ;;
esac

printf '\nAll tests passed.\n'
