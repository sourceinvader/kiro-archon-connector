# Installing Archon and the Kiro plugin

This guide installs the latest Archon and this plugin from the private repository
`sourceinvader/kiro-archon-connector`, then checks both with a first run.

Every step below was run on 16 November 2026 (macOS arm64, Archon 0.14.0, Kiro CLI 2.37.1,
Bun 1.3.11), starting from a fresh clone of the private repository and a fresh Archon home.
Linux uses the same commands but has not been tried with real Kiro yet.

## What you need

| | Why | Check |
|---|---|---|
| Read access to `sourceinvader/kiro-archon-connector` | The plugin is built from a clone | `gh repo view sourceinvader/kiro-archon-connector` |
| [Kiro CLI](https://kiro.dev/docs/cli/), signed in | Runs every Kiro node | `kiro-cli whoami` shows your account |
| [Bun](https://bun.sh) 1.3 or newer | Builds the plugin | `bun --version` |
| git | Cloning, and the worktrees Archon makes for runs | `git --version` |

Sign in to Kiro with `kiro-cli login`. A headless account can set `KIRO_API_KEY` instead.
Do this before installing the plugin: a signed-out `kiro-cli` opens a browser login window,
so the plugin checks `whoami` first and fails the node rather than waiting on a browser.

Install Bun with `curl -fsSL https://bun.sh/install | bash` if you don't have it.

## 1. Install the latest Archon

At the time of writing the latest release is **0.14.0**, but Homebrew's stable formula is
still **0.13.2**. The plugin works on both (it needs 0.13.2 or newer), so pick one.

First see what you have:

```sh
type -a archon        # every archon on your PATH, first one wins
archon version
```

### Option A: the official installer (latest release, recommended)

If Homebrew already installed `archon`, remove it first. The installer writes
`/usr/local/bin/archon`, and on Apple Silicon `/opt/homebrew/bin` usually comes earlier on
`PATH`, so an old Homebrew copy would keep winning.

```sh
brew uninstall archon                                    # only if Homebrew installed it
curl -fsSL https://archon.diy/install | bash -s -- --providers=
```

`--providers=` (empty) adds none of Archon's built-in providers (Claude, Codex, Pi). Kiro
comes from this plugin. To use those providers as well, list them:
`--providers claude,codex`. The installer checks the download against the release's
`checksums.txt`, and asks for `sudo` if it can't write to `/usr/local/bin`. To install
without `sudo`, run `curl -fsSL https://archon.diy/install | INSTALL_DIR=~/.local/bin bash -s -- --providers=`
and make sure `~/.local/bin` is on your `PATH`.

On Linux x64 the release binary needs a CPU with AVX2. Arm64 has no such requirement.

### Option B: Homebrew (0.13.2 today)

```sh
brew upgrade archon                     # or: brew install coleam00/archon/archon
```

### Check it

```sh
type -a archon        # exactly one archon
archon version        # Archon CLI v0.14.0 (or v0.13.2 with Homebrew)
```

## 2. Install the plugin from the private repository

```sh
gh repo clone sourceinvader/kiro-archon-connector
cd kiro-archon-connector
bun install
bun run install:local
```

`gh repo clone` uses your GitHub CLI login. A plain
`git clone https://github.com/sourceinvader/kiro-archon-connector.git` also works if git has
your GitHub credentials.

`install:local` compiles `archon-provider-kiro` for your machine and installs it into your
Archon home (`$ARCHON_HOME`, or `~/.archon` by default), the same way `archon plugin add`
would. The last lines look like this:

```text
Installed local/kiro-archon-connector (provider 'kiro', v0.1.0) into /Users/you/.archon
  executable: /Users/you/.archon/plugins/archon-provider-kiro
  receipt:    /Users/you/.archon/plugins/installed/local/kiro-archon-connector/receipt.json
Check it with: archon plugin list && archon doctor
```

To install into another Archon home, set `ARCHON_HOME` or pass
`--archon-home /absolute/path`. If `archon serve` is running, restart it. A new CLI command
picks up the plugin straight away.

### Why not `archon plugin add`?

Archon's normal route, `archon plugin add owner/repo`, cannot install from a private
repository. It reads `archon-plugin.json` from `raw.githubusercontent.com` without
credentials, and Archon's own source says "a private repository cannot be installed". Tried
against this repository, it fails like this:

```text
Error: No archon-plugin.json for sourceinvader/kiro-archon-connector at commit cbc8d79…
(https://raw.githubusercontent.com/sourceinvader/kiro-archon-connector/…/archon-plugin.json returned 404)
```

It also needs a GitHub release with prebuilt binaries, which this repository doesn't have
yet. If the repository is made public and a `v*` tag is pushed (see
[Publishing](README.md#publishing)), anyone can install it with
`archon plugin add sourceinvader/kiro-archon-connector`. Run `bun run install:local --remove`
first, because both installs would own the same executable.

## 3. Check the install

```sh
archon plugin list
archon doctor
```

Expected:

```text
local/kiro-archon-connector  provider  v0.1.0  cbc8d79fa3c6  archon >=0.13.2

✓ Installed providers: kiro (0.1.0)
✓ kiro: Kiro CLI: kiro-cli 2.37.1 at kiro-cli
✓ kiro: Kiro login: Signed in (BuilderId)
○ kiro: Kiro model: No model configured; Kiro's default applies
✓ Assistant login: kiro: usable
✓ Provider support: kiro is supported
...
All checks passed.
```

The commit in `plugin list` is whatever you built from. A `○` line is information, not a
failure.

## 4. Pick a default model (recommended)

With no model configured, Kiro uses `auto`, which costs the full credit rate. To set a
cheaper default, add this to `~/.archon/config.yaml` (create the file if it doesn't exist):

```yaml
assistants:
  kiro:
    model: minimax-m2.5      # see `kiro-cli chat --list-models`
```

A node's own `model:` still wins. All of the sample workflows pin `minimax-m2.5` anyway. To
make Kiro the provider for nodes that don't name one, add `defaultAssistant: kiro`. The
other settings are in [Configuration](README.md#configuration).

## 5. First run

From the clone:

```sh
archon workflow run kiro-hello
```

```text
[hello] Started  (kiro/minimax-m2.5)
KIRO-ARCHON-OK
[hello] Completed (10.2s)
...
Kiro replied: KIRO-ARCHON-OK

Workflow completed successfully.
```

By default each run gets its own git worktree, branched from `origin/main`. So it sees what
you have **pushed**, not your uncommitted or unpushed changes. To run against your checkout
as it is, add `--no-worktree`.

The rest of the samples are listed in [Try the sample workflows](README.md#try-the-sample-workflows).
`kiro-playwright-cli` needs `--no-worktree`, because `playwright-cli install --skills`
writes the skill into your checkout as an untracked file, and a worktree doesn't include
untracked files.

To use Kiro in your own project, give a node `provider: kiro` (or set `defaultAssistant`):

```yaml
nodes:
  - id: review
    provider: kiro
    model: minimax-m2.5
    allowed_tools: [read]
    prompt: "Review the changes in this branch and list the risky ones."
```

## Updating

**The plugin:**

```sh
cd kiro-archon-connector
git pull
bun install
bun run install:local      # rebuilds and replaces the installed copy
```

Restart `archon serve` if it's running.

**Archon:** rerun the installer from step 1 (or `brew upgrade archon`), then run
`archon doctor`. The plugin doesn't need a rebuild for a new Archon release as long as that
release still speaks plugin protocol 3 (0.13.2 and 0.14.0 both do). If a future release
changes the protocol, the plugin will stop serving Kiro nodes until it's updated. Check
`archon plugin list` and `archon doctor` after every Archon upgrade.

## Removing the plugin

```sh
cd kiro-archon-connector
bun run install:local --remove
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `archon version` still shows an old version | Another `archon` comes first on `PATH`. Run `type -a archon` and remove the one you don't want (often `brew uninstall archon`). |
| `archon plugin add sourceinvader/kiro-archon-connector` fails with `returned 404` | The repository is private. Use `bun run install:local` (step 2). |
| `archon-provider-kiro is already installed by …` | Another install (for example `archon plugin add`) owns the executable. Remove it with the `archon plugin remove …` command shown, then install again. |
| `archon doctor`: `kiro: Kiro login` fails | Run `kiro-cli login`, then `kiro-cli whoami`. |
| `archon doctor`: `kiro: Kiro CLI` fails | `kiro-cli` isn't on `PATH`. Fix `PATH`, or set `assistants.kiro.kiroPath` in `~/.archon/config.yaml`. |
| `archon doctor` asks you to run `archon skill add .` | Archon 0.14 expects its `archon-cli` skill in any project that has `.claude/skills`, for example after `playwright-cli install --skills`. Run that command, or ignore it. It doesn't affect Kiro. |
| `Cannot determine git remote … use --no-worktree` | You're running in a repository with no `origin`. Add a remote, or pass `--no-worktree`. |
| The `kiro-playwright-mcp` node fails on its first run | Kiro gives an MCP server 30 seconds to start, and the first `npx` download can take longer. Run `npx -y @playwright/mcp@0.0.85 --help` once, then retry. |
| A node fails as `misconfigured` with `InvalidModelError` | The model name is wrong. List valid ones with `kiro-cli chat --list-models`. |
