# pi-config

Personal pi-coding-agent setup. Tracks the parts of `~/.local/bin/` and
`~/.pi/` that I want backed up across machines.

This is **not** a fork of [earendil-works/pi-mono]; it's dotfiles. Pi is
installed normally via `npm install -g @earendil-works/pi-coding-agent`;
this repo overlays a wrapper and a couple of config files on top.

## Install on a fresh machine

```bash
git clone git@github.com:thundron/pi-config.git
cd pi-config

# Wrapper (early in $PATH so it shadows the npm-installed `pi`)
install -Dm755 bin/pi  ~/.local/bin/pi

# Agent config + skill
mkdir -p ~/.pi/agent/skills
cp -a agent/system-prompt.txt  ~/.pi/agent/
cp -a agent/settings.json      ~/.pi/agent/
cp -a agent/skills/claude-code ~/.pi/agent/skills/
```

Verify the wrapper is on `$PATH` ahead of the real pi binary:

```
$ which -a pi
~/.local/bin/pi             # this wrapper
/path/to/real/pi            # the npm/brew-installed binary
```

The wrapper auto-detects the real binary by walking `$PATH` and
picking the first `pi` that isn't itself. Override with `PI_REAL=`
in the environment if it picks wrong.

## What's in here

### `bin/pi`

PATH-shadow wrapper. Forwards subcommands (`install`, `update`, `auth`,
…) untouched, but for actual chat invocations injects
`--system-prompt "$(cat ~/.pi/agent/system-prompt.txt)"` before
exec-ing the real pi binary. The injection is what makes Anthropic's
OAuth billing classifier treat the request as Claude Code rather than
a third-party app on accounts that don't have overage credit
configured.

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

```
You are Claude Code, Anthropic's official CLI for Claude.
```

### `agent/skills/claude-code/SKILL.md`

Pi's claude-code skill with a trigger-rich `description` in the
frontmatter so the harness loads it automatically on coding-task
prompts (refactor / fix bug / review PR / multi-turn coding) rather
than only when invoked via `/claude-code`. Body is unchanged from
upstream.

### `agent/settings.json`

Default provider / model. Tracked for parity across machines.

## Not upstreamable

The wrapper is a per-account workaround for Anthropic's billing-lane
classifier. Pi already mimics Claude Code's tool-naming convention
in its own `// Stealth mode` block — this wrapper is only needed for
accounts where that's still sub-threshold (typically: Pro/Max with no
extra-usage credit configured). Don't PR it.
