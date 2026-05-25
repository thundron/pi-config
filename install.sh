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

# Resolve a path's canonical form on either GNU or BSD coreutils.
# Returns $1 unchanged if neither realpath nor readlink -f is available.
canon() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1" 2>/dev/null || printf '%s\n' "$1"
  elif readlink -f -- "$1" >/dev/null 2>&1; then
    readlink -f -- "$1"
  else
    case "$1" in
      /*) printf '%s\n' "$1" ;;
      *)  printf '%s/%s\n' "$(cd "$(dirname "$1")" 2>/dev/null && pwd)" "$(basename "$1")" ;;
    esac
  fi
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

# Copy-sync (NOT symlink) a live path to a repo file. Use for files pi
# rewrites at runtime (settings.json). Warns on drift; never clobbers.
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

  # Both exist
  if [ -e "$live" ] && [ -e "$repo_file" ]; then
    if cmp -s "$live" "$repo_file"; then
      printf '  ok:       %s (copy in sync)\n' "$live"
    else
      printf '  DRIFT:    %s differs from %s\n' "$live" "$repo_file" >&2
      printf '            reconcile by hand:\n' >&2
      printf '              cp "%s" "%s"   # live → repo\n' "$live" "$repo_file" >&2
      printf '              cp "%s" "%s"   # repo → live\n' "$repo_file" "$live" >&2
    fi
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
link "$HOME/.pi/agent/skills/claude-code/SKILL.md"        "agent/skills/claude-code/SKILL.md"
link "$HOME/.pi/agent/skills/subagents/SKILL.md"         "agent/skills/subagents/SKILL.md"
link "$HOME/.pi/agent/roles/awaiter.json"                 "agent/roles/awaiter.json"
link "$HOME/.pi/agent/execpolicy.example.json"            "agent/execpolicy.example.json"

printf '\n[copies — pi rewrites these]\n'
copy_synced "$HOME/.pi/agent/settings.json"               "agent/settings.json"

printf '\ndone.\n'
printf '\nNext: ensure $HOME/.local/bin is in your PATH ahead of the real pi binary.\n'
printf '  WSL/Linux: export PATH="$HOME/.local/bin:$PATH"   (in ~/.bashrc or ~/.zshrc)\n'
printf '  macOS:     export PATH="$HOME/.local/bin:$PATH"   (in ~/.zshrc — note macOS does not\n'
printf '             ship a ~/.local/bin entry on PATH by default)\n'
