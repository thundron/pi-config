#!/usr/bin/env bash
# install.sh — idempotent installer for the pi-config dotfiles repo.
#
# Symlinks tracked files into ~/.local/bin and ~/.pi so edits in either
# location are the same file. For settings.json (which pi rewrites at
# runtime), keeps a plain copy and warns on drift instead of clobbering.
#
# Cross-platform: macOS (default BSD coreutils, bash 3.2) and Linux/WSL.
# Safe to re-run: existing real files get backed up to *.pre-symlink.<ts>
# before being replaced.
#
# Behavior:
#   - repo has file but live doesn't  → install (symlink or copy)
#   - live has file but repo doesn't  → seed the repo from live
#   - both exist and match            → no-op
#   - both exist and differ
#       symlink targets → repoint
#       copy targets    → warn, ask user to reconcile
#
# Usage:  ~/dev/pi-config/install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ts="$(date +%s)"

# ── helpers ────────────────────────────────────────────────────────────────

# Portable canonical-path resolver (realpath → readlink -f → while-symlink fallback).
canon() {
  local src="$1"
  [ -z "$src" ] && return 1
  if command -v realpath >/dev/null 2>&1; then
    realpath -- "$src" 2>/dev/null && return 0
  fi
  if readlink -f -- "$src" >/dev/null 2>&1; then
    readlink -f -- "$src"
    return 0
  fi
  local dir
  while [ -L "$src" ]; do
    dir=$(cd -P "$(dirname -- "$src")" 2>/dev/null && pwd) || break
    src=$(readlink -- "$src") || break
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
  done
  if [ -e "$src" ] || [ -L "$src" ]; then
    dir=$(cd -P "$(dirname -- "$src")" 2>/dev/null && pwd)
    if [ -n "$dir" ]; then
      printf '%s/%s\n' "$dir" "$(basename -- "$src")"
      return 0
    fi
  fi
  case "$src" in
    /*) printf '%s\n' "$src" ;;
    *)  printf '%s/%s\n' "$(pwd)" "$src" ;;
  esac
}

# Symlink a live path to a repo file.
#   $1 = live path (absolute, $HOME-expanded)
#   $2 = repo-relative path
link() {
  local live="$1"
  local repo_rel="$2"
  local repo_file="$REPO_ROOT/$repo_rel"

  # Seed the repo from live if the repo file doesn't exist yet.
  if [ ! -e "$repo_file" ] && [ -e "$live" ] && [ ! -L "$live" ]; then
    mkdir -p "$(dirname "$repo_file")"
    cp -p "$live" "$repo_file"
    printf '  seeded:   %s ← %s\n' "$repo_rel" "$live"
  fi

  if [ ! -e "$repo_file" ]; then
    printf '  SKIP:     %s (missing in repo and no live file to seed from)\n' "$repo_rel" >&2
    return 0
  fi

  # Already correctly linked?
  if [ -L "$live" ]; then
    local cur tgt
    cur="$(canon "$live")"
    tgt="$(canon "$repo_file")"
    if [ "$cur" = "$tgt" ]; then
      printf '  ok:       %s\n' "$live"
      return 0
    fi
  fi

  # Replace whatever is there.
  if [ -e "$live" ] && [ ! -L "$live" ]; then
    local backup="${live}.pre-symlink.${ts}"
    mv "$live" "$backup"
    printf '  backup:   %s → %s\n' "$live" "$backup"
  elif [ -L "$live" ]; then
    rm -f "$live"
  fi

  mkdir -p "$(dirname "$live")"
  ln -s "$repo_file" "$live"
  printf '  linked:   %s → %s\n' "$live" "$repo_file"
}

# Strip pi-self-mutated fields (lastChangelogVersion) before drift compare.
_settings_normalize() {
  grep -v '"lastChangelogVersion"' -- "$1" 2>/dev/null || true
}

# Copy-sync a live file to/from the repo. Warns on meaningful drift; never clobbers.
copy_synced() {
  local live="$1"
  local repo_rel="$2"
  local repo_file="$REPO_ROOT/$repo_rel"

  # Repo has it, live doesn't → install initial copy from repo
  if [ ! -e "$live" ] && [ -e "$repo_file" ]; then
    mkdir -p "$(dirname "$live")"
    cp -p "$repo_file" "$live"
    printf '  copied:   %s ← %s (initial)\n' "$live" "$repo_rel"
    return 0
  fi

  # Live has it, repo doesn't → seed repo
  if [ -e "$live" ] && [ ! -e "$repo_file" ]; then
    mkdir -p "$(dirname "$repo_file")"
    cp -p "$live" "$repo_file"
    printf '  seeded:   %s ← %s\n' "$repo_rel" "$live"
    return 0
  fi

  # Both exist: byte-equal OR equal-after-normalize → in sync.
  if [ -e "$live" ] && [ -e "$repo_file" ]; then
    if cmp -s "$live" "$repo_file"; then
      printf '  ok:       %s (copy in sync)\n' "$live"
      return 0
    fi
    if diff -q <(_settings_normalize "$live") <(_settings_normalize "$repo_file") >/dev/null 2>&1; then
      printf '  ok:       %s (in sync ignoring pi-managed fields)\n' "$live"
      return 0
    fi
    printf '  DRIFT:    %s differs from %s\n' "$live" "$repo_file" >&2
    printf '            reconcile by hand:\n' >&2
    printf '              cp "%s" "%s"   # live → repo\n' "$live" "$repo_file" >&2
    printf '              cp "%s" "%s"   # repo → live\n' "$repo_file" "$live" >&2
    return 0
  fi

  printf '  SKIP:     %s (no source on either side)\n' "$repo_rel" >&2
}

# ── tracked files ──────────────────────────────────────────────────────────

printf 'pi-config install (%s)\n' "$(uname -s)"
printf 'repo: %s\n\n' "$REPO_ROOT"

printf '[symlinks]\n'
link "$HOME/.local/bin/pi"                                "bin/pi"
link "$HOME/.pi/agent/system-prompt.txt"                  "agent/system-prompt.txt"
link "$HOME/.pi/agent/extensions/guardian.ts"            "agent/extensions/guardian.ts"
link "$HOME/.pi/agent/extensions/fleet-citizen.ts"        "agent/extensions/fleet-citizen.ts"
link "$HOME/.pi/agent/extensions/goal-mode.ts"            "agent/extensions/goal-mode.ts"
link "$HOME/.pi/agent/extensions/goal-mode.README.md"     "agent/extensions/goal-mode.README.md"
link "$HOME/.pi/agent/extensions/subagents.ts"            "agent/extensions/subagents.ts"
link "$HOME/.pi/agent/extensions/subagents.README.md"     "agent/extensions/subagents.README.md"
link "$HOME/.pi/agent/extensions/codex-cli-extras.ts"     "agent/extensions/codex-cli-extras.ts"
link "$HOME/.pi/agent/extensions/side-conversation.ts"    "agent/extensions/side-conversation.ts"
link "$HOME/.pi/agent/extensions/plan-mode.ts"            "agent/extensions/plan-mode.ts"
link "$HOME/.pi/agent/extensions/memories.ts"             "agent/extensions/memories.ts"
link "$HOME/.pi/agent/extensions/personality.ts"          "agent/extensions/personality.ts"
link "$HOME/.pi/agent/extensions/introspection.ts"        "agent/extensions/introspection.ts"
link "$HOME/.pi/agent/extensions/background-procs.ts"     "agent/extensions/background-procs.ts"
link "$HOME/.pi/agent/extensions/terminal-title.ts"       "agent/extensions/terminal-title.ts"
link "$HOME/.pi/agent/extensions/pets.ts"                 "agent/extensions/pets.ts"
link "$HOME/.pi/agent/extensions/context-tools.ts"        "agent/extensions/context-tools.ts"
link "$HOME/.pi/agent/extensions/current-time.ts"         "agent/extensions/current-time.ts"
link "$HOME/.pi/agent/extensions/context-diet.ts"         "agent/extensions/context-diet.ts"
link "$HOME/.pi/agent/extensions/context-diet.README.md"  "agent/extensions/context-diet.README.md"
link "$HOME/.pi/agent/extensions/compaction-diet.ts"      "agent/extensions/compaction-diet.ts"
link "$HOME/.pi/agent/extensions/compaction-diet.README.md" "agent/extensions/compaction-diet.README.md"
link "$HOME/.pi/agent/extensions/tool-pairing-guard.ts"   "agent/extensions/tool-pairing-guard.ts"
link "$HOME/.pi/agent/extensions/tool-pairing-guard.README.md" "agent/extensions/tool-pairing-guard.README.md"
link "$HOME/.pi/agent/skills/claude-code/SKILL.md"        "agent/skills/claude-code/SKILL.md"
link "$HOME/.pi/agent/skills/subagents/SKILL.md"         "agent/skills/subagents/SKILL.md"
link "$HOME/.pi/agent/roles/awaiter.json"                 "agent/roles/awaiter.json"
link "$HOME/.pi/agent/roles/explorer.json"                "agent/roles/explorer.json"
link "$HOME/.pi/agent/roles/worker.json"                  "agent/roles/worker.json"
link "$HOME/.pi/agent/execpolicy.example.json"            "agent/execpolicy.example.json"

printf '\n[copies — pi rewrites these]\n'
copy_synced "$HOME/.pi/agent/settings.json"               "agent/settings.json"

printf '\ndone.\n'
printf '\nNext: ensure $HOME/.local/bin is in your PATH ahead of the real pi binary.\n'
printf '  WSL/Linux: export PATH="$HOME/.local/bin:$PATH"   (in ~/.bashrc or ~/.zshrc)\n'
printf '  macOS:     export PATH="$HOME/.local/bin:$PATH"   (in ~/.zshrc — note macOS does not\n'
printf '             ship a ~/.local/bin entry on PATH by default)\n'
