# pi-config

Personal pi-coding-agent setup. Tracks the parts of `~/.local/bin/` and
`~/.pi/` that I want backed up across machines.

This is **not** a fork of [earendil-works/pi-mono]; it's dotfiles. Pi is
installed normally via `npm install -g @earendil-works/pi-coding-agent`
(or `brew install`); this repo overlays a wrapper, a couple of config
files, and my personal extensions on top.

## Install on a fresh machine

```bash
git clone git@github.com:thundron/pi-config.git ~/dev/pi-config
~/dev/pi-config/install.sh
```

The installer is **idempotent and cross-platform** (macOS, Linux, WSL).
It symlinks each tracked file into its expected location, backing up any
pre-existing real file to `*.pre-symlink.<ts>` first. Re-running it is
always safe — already-correct links report `ok`.

After install, ensure `~/.local/bin` is on `$PATH` ahead of the real pi
binary:

```bash
# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Verify the wrapper is in front:

```text
$ which -a pi
~/.local/bin/pi             ← this wrapper (symlink into ~/dev/pi-config/bin/pi)
/path/to/real/pi            ← the npm/brew-installed binary
```

The wrapper auto-detects the real binary by walking `$PATH` and picking
the first `pi` that isn't itself. Override with `PI_REAL=...` if it
picks wrong.

Optional fleet tooling (separate project, install only if you use it):

```bash
# pip / pipx / etc — see https://github.com/thundron/pi-fleet
```

The `fleet-citizen.ts` extension and `pi-fleet` skill tracked here are
useful only once `pi-fleet` itself is installed.

## What's tracked, where it lives, and how it's synced

### Symlinks (edit either side, it's the same file)

| Live path                                            | → | Repo path                                  |
| ---------------------------------------------------- | --- | ---------------------------------------- |
| `~/.local/bin/pi`                                    | → | `bin/pi`                                 |
| `~/.pi/agent/system-prompt.txt`                      | → | `agent/system-prompt.txt`                |
| `~/.pi/agent/extensions/fleet-citizen.ts`            | → | `agent/extensions/fleet-citizen.ts`      |
| `~/.pi/agent/extensions/goal-mode.ts`                | → | `agent/extensions/goal-mode.ts`          |
| `~/.pi/agent/extensions/goal-mode.README.md`         | → | `agent/extensions/goal-mode.README.md`   |
| `~/.pi/agent/skills/claude-code/SKILL.md`            | → | `agent/skills/claude-code/SKILL.md`      |
| `~/.pi/agent/skills/pi-fleet/SKILL.md`               | → | `agent/skills/pi-fleet/SKILL.md`         |

### Copy (pi rewrites it at runtime; cannot be a symlink)

| Live path                          | ↔ | Repo path              | Notes                       |
| ---------------------------------- | --- | -------------------- | ------------------------- |
| `~/.pi/agent/settings.json`        | ↔ | `agent/settings.json`  | pi bumps `lastChangelogVersion` on its own; sync manually when you change a real setting |

The installer warns on drift for the copy case (it never clobbers).
Reconcile by hand: `cp <live> <repo>` or the other direction, depending
on which side is canonical.

## What's in here

### `bin/pi`

PATH-shadow wrapper. Forwards subcommands (`install`, `update`, `auth`,
…) untouched, but for actual chat invocations injects
`--system-prompt "$(cat ~/.pi/agent/system-prompt.txt)"` before
exec-ing the real pi binary. The injection is what makes Anthropic's
OAuth billing classifier treat the request as Claude Code rather than
a third-party app on accounts that don't have overage credit
configured.

Auto-detects the real `pi` binary by walking `$PATH` and skipping
itself, so it's portable across `/home/linuxbrew/.linuxbrew/bin/pi`
(WSL/Linuxbrew), `/opt/homebrew/bin/pi` (Apple Silicon), and
`/usr/local/bin/pi` (Intel macOS / npm install).

Escape hatches:

- `PI_NO_SPOOF=1 pi …` — one-off bypass.
- `PI_REAL=/path/to/pi pi …` — override the auto-detected real binary.
- `rm ~/.local/bin/pi` — permanent disable; falls back to the real
  binary.
- Edit `~/.pi/agent/system-prompt.txt` if Anthropic ever rotates the
  fingerprint.

The wrapper also steps aside automatically when you pass your own
`--system-prompt` or `--system-prompt-file`.

### `agent/system-prompt.txt`

The one line the wrapper injects:

```text
You are Claude Code, Anthropic's official CLI for Claude.
```

### `agent/extensions/fleet-citizen.ts`

Required by [pi-fleet][pi-fleet]: footer status, banned-phrase guard,
dangerous-bash blocker, `/done` + `/halt` slash commands. `pi-fleet`'s
supervisor only reads this file; it never writes or installs it, so
keeping it under version control here is the right ownership.

[pi-fleet]: https://github.com/thundron/pi-fleet

### `agent/extensions/goal-mode.ts` (+ README)

Ports OpenAI Codex's `/goal` primitive to pi as a pure extension. A
"goal" is a persistent objective that survives across turns: after each
agent loop settles, pi automatically re-engages the assistant with the
objective + remaining token budget so it keeps making progress without
the user typing "continue". The model can mark itself complete or
blocked via the registered `update_goal` tool, and a token budget
protects against runaway cost. See the sidecar README for the full
slash-command surface and design notes.

### `agent/skills/claude-code/SKILL.md`

Pi's claude-code skill with a trigger-rich `description` in the
frontmatter so the harness loads it automatically on coding-task
prompts (refactor / fix bug / review PR / multi-turn coding) rather
than only when invoked via `/claude-code`. Body is unchanged from
upstream.

### `agent/skills/pi-fleet/SKILL.md`

Pi's pi-fleet skill — instructs the agent on how to dispatch and steer
parallel pi agents via the pi-fleet orchestrator. Mirrors the
`fleet-citizen.ts` extension above.

### `agent/settings.json`

Default provider / model / thinking level. Tracked for parity across
machines. Pi rewrites this at runtime (e.g. bumps
`lastChangelogVersion` on version updates), so it stays a copy rather
than a symlink — see the table above.

## Updating the repo from a machine you've been working on

Symlinked files are already the repo's files; just commit:

```bash
cd ~/dev/pi-config
git status
git add -A
git commit -m "describe what changed"
git push
```

For `settings.json` (the copy), sync explicitly when you've changed a
real setting:

```bash
cp ~/.pi/agent/settings.json ~/dev/pi-config/agent/settings.json
git diff agent/settings.json   # ignore lastChangelogVersion-only diffs
```

## Not upstreamable

The wrapper is a per-account workaround for Anthropic's billing-lane
classifier. Pi already mimics Claude Code's tool-naming convention in
its own `// Stealth mode` block — this wrapper is only needed for
accounts where that's still sub-threshold (typically: Pro/Max with no
extra-usage credit configured). Don't PR it.
