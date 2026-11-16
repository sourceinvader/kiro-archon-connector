# Installing Archon and the Kiro plugin

This guide takes a machine from nothing to a working Kiro node in Archon, on **macOS** or
**Ubuntu 26.04**. You install Kiro CLI and Archon, then add this plugin with one Archon
command. You don't need GitHub credentials, Bun or a copy of this repository unless you
want to [build the plugin yourself](#building-from-source).

It assumes `sourceinvader/kiro-archon-connector` is public and has at least one GitHub
release. [Publishing](README.md#publishing) in the README covers how to create one.

| Step | macOS | Ubuntu 26.04 |
|---|---|---|
| 1. Kiro CLI, signed in | [macOS](#1-macos-kiro-cli) | [Ubuntu](#1-ubuntu-2604-kiro-cli) |
| 2. Archon | [macOS](#2-macos-archon) | [Ubuntu](#2-ubuntu-2604-archon) |
| 3. The plugin: `archon plugin add` | [Add the plugin](#3-add-the-plugin) | same |
| 4. Check it | [Check the install](#4-check-the-install) | same |
| 5. Pick a cheap default model | [Default model](#5-pick-a-default-model) | same |
| 6. First run | [First run](#6-first-run) | same |

> **Kiro CLI version: read this first.** The plugin was built and fully tested against
> **Kiro CLI 2.37.1**. Kiro 3.0 (3 November 2026) made the V3 engine the default and retired
> the classic CLI, and a fresh install now gets **3.3.0**. On 3.3.0 every flag the plugin
> passes still exists, the plugin still detects a signed-out account, and `archon doctor`
> works. A real Kiro turn on 3.x has **not** been run yet. If a node fails on 3.x, see
> [Kiro 3.x](#kiro-3x).

## What was tested

| | macOS (arm64) | Ubuntu 26.04 (arm64, in a container) |
|---|---|---|
| Kiro CLI | 2.37.1, already installed and signed in | 3.3.0 from the official installer, never signed in |
| Archon 0.14.0 | official release binary | official installer, including its `sudo` step |
| `archon plugin add` | Archon 0.14.0's own `plugin add` code, run against a local stand-in for github.com that served this repo's real release assets (built with `release.yml`'s command). The add, `@v0.1.0`, `update` and `remove` forms all worked. | The `linux-arm64` release binary starts and answers Archon's `initialize` (protocol 3, id `kiro`) |
| `archon plugin list`, `archon doctor` | pass | pass with a from-source build, except for "Kiro login", because the container was never signed in |
| A real Kiro run (`kiro-hello`) | pass | not run (needs a Kiro login) |

The stand-in was needed because the repository was still private when this was written.
`plugin add` against the real github.com, once the repository is public, is the one step
that hasn't run. CI also builds the plugin and runs its offline tests on GitHub's Ubuntu
26.04 x64 runner and on macOS, on every push.

---

## 1. macOS: Kiro CLI

Install Kiro CLI from [kiro.dev](https://kiro.dev/docs/cli/) (or run
`curl -fsSL https://cli.kiro.dev/install | bash`), then sign in:

```sh
kiro-cli login                  # opens your browser
kiro-cli whoami                 # shows your account
kiro-cli --version
```

`archon plugin add` uses git, which macOS installs with the Xcode command line tools. If
`git --version` asks you to install them, run `xcode-select --install`.

Next: [macOS Archon](#2-macos-archon).

## 1. Ubuntu 26.04: Kiro CLI

Run these as your normal user (not root). `sudo` asks for your password where it's needed.

**Base packages.** Kiro's installer needs `unzip`, and `archon plugin add` needs `git`.

```sh
sudo apt update
sudo apt install -y curl unzip git ca-certificates
```

**Kiro CLI.** It installs into `~/.local/bin`. Ubuntu's `~/.profile` puts that folder on
`PATH` at your next login, so for the current terminal add it yourself:

```sh
curl -fsSL https://cli.kiro.dev/install | bash
export PATH="$HOME/.local/bin:$PATH"     # this terminal only; new logins get it from ~/.profile
kiro-cli --version                       # kiro-cli 3.3.0 when this was tested
```

Kiro needs glibc 2.34 or newer, and Ubuntu 26.04 has 2.43.

**Sign in.** On a desktop, `kiro-cli login` opens your browser. Over SSH or on a server with
no browser, use the device flow: Kiro prints a URL and a code that you enter in a browser on
any other device.

```sh
kiro-cli login --use-device-flow
kiro-cli whoami                          # shows your account
```

Kiro Pro, Pro+, Pro Max and Power subscribers can create an API key instead and set
`KIRO_API_KEY`. The plugin then skips its sign-in check.

Next: [Ubuntu Archon](#2-ubuntu-2604-archon).

---

## 2. macOS: Archon

The latest release is **0.14.0**. Homebrew's stable formula is still **0.13.2**. The plugin
works on both, because it needs 0.13.2 or newer.

```sh
type -a archon                  # every archon on your PATH; the first one wins
```

**Option A: the official installer (latest, recommended).** If Homebrew installed `archon`
before, remove it first. The installer writes `/usr/local/bin/archon`, and on Apple Silicon
`/opt/homebrew/bin` comes earlier on `PATH`, so an old Homebrew copy would keep running.

```sh
brew uninstall archon           # only if Homebrew installed it
curl -fsSL https://archon.diy/install | bash -s -- --providers=
```

**Option B: Homebrew (0.13.2).**

```sh
brew upgrade archon             # or: brew install coleam00/archon/archon
```

Then check that only one `archon` is on your `PATH` and it's the version you expect:

```sh
type -a archon
archon version                  # Archon CLI v0.14.0 (v0.13.2 with Homebrew)
```

The meaning of `--providers=` is explained [below](#about---providers).
Next: [Add the plugin](#3-add-the-plugin).

## 2. Ubuntu 26.04: Archon

```sh
curl -fsSL https://archon.diy/install | bash -s -- --providers=
archon version                  # Archon CLI v0.14.0, Platform: linux-x64 or linux-arm64
```

The installer downloads the release binary for your CPU, checks it against the release's
`checksums.txt`, and moves it to `/usr/local/bin/archon`. That last step uses `sudo`. To
install without `sudo`, use a folder in your home that's on `PATH`:

```sh
curl -fsSL https://archon.diy/install | INSTALL_DIR=~/.local/bin bash -s -- --providers=
```

On **x64**, the release binary needs a CPU with **AVX2**. Some older CPUs and some virtual
machines hide it. In that case the installer stops before installing anything, and you'd
need to [build Archon from source](https://archon.diy/getting-started/installation/#from-source).
`grep -c avx2 /proc/cpuinfo` prints more than 0 if you have it. Arm64 has no such
requirement.

### About `--providers=`

Archon's release binaries come without AI providers. Its installer offers to add Claude,
Codex or Pi. `--providers=` (empty) adds none, because Kiro comes from this plugin and
doesn't need them. If you also want one of those, name it, for example
`--providers claude`. You can add one later with `archon provider add claude`.

---

## 3. Add the plugin

The same on both systems:

```sh
archon plugin add sourceinvader/kiro-archon-connector
```

```text
Installed sourceinvader/kiro-archon-connector from github.com/sourceinvader/kiro-archon-connector v0.1.0 (commit e3dd4d61…)
  /Users/you/.archon/plugins/archon-provider-kiro  sha256 c18933bb…
  This runs code published by sourceinvader.
```

That one command does all of the following:
- reads the repository's `archon-plugin.json`
- finds the latest GitHub release
- downloads the build for your system
- checks it against the release's `checksums.txt`
- starts it once to confirm it's a Kiro provider speaking Archon's plugin protocol
- records it in `~/.archon/plugins` (or `$ARCHON_HOME/plugins`)

To pin a version, add the tag, for example
`archon plugin add sourceinvader/kiro-archon-connector@v0.1.0`.

Release builds exist for macOS (arm64 and x64), Linux (x64 and arm64) and Windows (x64).
Windows is untested. On any other system, [build from source](#building-from-source).

If `archon serve` is running, restart it. A new CLI command picks up the plugin straight
away.

## 4. Check the install

```sh
archon plugin list
archon doctor
```

Expected:

```text
sourceinvader/kiro-archon-connector  provider  v0.1.0  e3dd4d61a25a  archon >=0.13.2

✓ Installed providers: kiro (0.1.0)
✓ kiro: Kiro CLI: kiro-cli 2.37.1 at kiro-cli
✓ kiro: Kiro login: Signed in (BuilderId)
○ kiro: Kiro model: No model configured; Kiro's default applies
✓ Assistant login: kiro: usable
✓ Provider support: kiro is supported
...
All checks passed.
```

The version, commit and Kiro version will be whatever you have. A `○` line is
information, not a failure. If `Kiro login` shows `✗`, sign in to Kiro (step 1) and run
`archon doctor` again.

## 5. Pick a default model

With no model configured, Kiro uses `auto`, which costs the full credit rate. To use a
cheaper default, add this to `~/.archon/config.yaml` (create the file if it doesn't exist):

```yaml
assistants:
  kiro:
    model: minimax-m2.5      # list models with: kiro-cli chat --list-models
```

A node's own `model:` still wins. To make Kiro the provider for nodes that don't name one,
add `defaultAssistant: kiro`. The other settings are in
[Configuration](README.md#configuration).

## 6. First run

Run this from any git repository. Save the workflow as
`.archon/workflows/kiro-hello.yaml`:

```yaml
name: kiro-hello
description: One Kiro turn on a cheap model, then print the reply.
provider: kiro
model: minimax-m2.5

nodes:
  - id: hello
    prompt: "Reply with exactly: KIRO-ARCHON-OK"

  - id: show
    depends_on: [hello]
    bash: |
      reply=$hello.output
      echo "Kiro replied: $reply"
```

```sh
archon workflow run kiro-hello --no-worktree
```

```text
[hello] Started  (kiro/minimax-m2.5)
[hello] Completed (12.1s)
[show] Started
[show] Completed (24ms)
Kiro replied: KIRO-ARCHON-OK

Workflow completed successfully.
```

`--no-worktree` runs in your checkout as it is. Without it, Archon runs each workflow in its
own git worktree branched from `origin`. That needs a remote, and the run only sees what
you've pushed. In a repository with no remote, Archon also prints a JSON warning line
(`workflow.base_branch_auto_detect_failed … Set worktree.remote`) before the run. It's
harmless with `--no-worktree`.

### More samples

This repository has more sample workflows: MCP servers, skills, Playwright, structured
output, failures and cancellation. To try them, clone it (no credentials needed) and run
them from the clone:

```sh
git clone https://github.com/sourceinvader/kiro-archon-connector.git
cd kiro-archon-connector
archon workflow run kiro-feature-tour --no-worktree
```

[Try the sample workflows](README.md#try-the-sample-workflows) in the README lists them all.
Some need extra tools: Bun for the demo MCP server in `kiro-feature-tour`, and Node.js for
the Playwright ones.

### Your own workflows

Give a node `provider: kiro` (or set `defaultAssistant: kiro`):

```yaml
nodes:
  - id: review
    provider: kiro
    model: minimax-m2.5
    allowed_tools: [read]
    prompt: "Review the changes in this branch and list the risky ones."
```

---

## Updating

**The plugin:**

```sh
archon plugin update sourceinvader/kiro-archon-connector
```

This installs the latest release. Restart `archon serve` if it's running.

**Archon:** rerun the installer from step 2 (or `brew upgrade archon`), then
`archon doctor`. The plugin doesn't need reinstalling for a new Archon release as long as
that release still speaks plugin protocol 3 (0.13.2 and 0.14.0 both do). If a later release
changes the protocol, the plugin will stop serving Kiro nodes until a new plugin release
supports it. Check `archon plugin list` and `archon doctor` after every Archon upgrade.

**Kiro CLI:** `kiro-cli update`. Read [Kiro 3.x](#kiro-3x) before moving from 2.x to 3.x.

## Removing the plugin

```sh
archon plugin remove sourceinvader/kiro-archon-connector
```

## Building from source

Only needed to try unreleased changes, to work on the plugin, or on a system with no
release build. You need git and Bun 1.3 or newer.

**Install Bun.** It installs into `~/.bun/bin` and adds that folder to `PATH` in your shell's
startup file.

```sh
sudo apt install -y unzip                # Ubuntu only: Bun's installer needs it
curl -fsSL https://bun.com/install | bash
source ~/.bashrc                         # Ubuntu; on macOS: exec $SHELL -l
bun --version                            # 1.3.11 (macOS) and 1.4.4 (Ubuntu) were tested
```

**Build and install.** If you added the plugin with `archon plugin add`, remove it first,
because both installs would own the same executable:

```sh
archon plugin remove sourceinvader/kiro-archon-connector     # only if you added it
git clone https://github.com/sourceinvader/kiro-archon-connector.git
cd kiro-archon-connector
bun install
bun run install:local
```

`install:local` compiles `archon-provider-kiro` for your machine and installs it as
`local/kiro-archon-connector`. Set `ARCHON_HOME` or pass `--archon-home /absolute/path` to
use another Archon home. Rebuild after `git pull` by running `bun run install:local` again,
and uninstall with `bun run install:local --remove`.

## Kiro 3.x

The plugin runs `kiro-cli chat --v3 --no-interactive --output-format stream-json` and
expects the event format and agent-file behaviour of 2.37.1. Here's what has been checked
on 3.3.0 so far:

- **Checked, works:** every flag the plugin passes is still accepted (`--v3`,
  `--no-interactive`, `--output-format stream-json`, `--agent`, `--model`, `--effort`,
  `--trust-all-tools`, `--resume-id`, `--list-sessions`, `--list-models`,
  `--require-mcp-startup`). Signed-out `whoami` now exits 1 instead of 0, but the plugin
  reads its JSON, not its exit code, so it still reports "No signed-in Kiro account".
  `archon doctor` reports Kiro 3.3.0 correctly.
- **Not checked yet:**
  - **Event format:** whether the `stream-json` events are unchanged in 3.x.
  - **Agent files:** Kiro 3.x upgrades V2-format agent files in place and leaves a
    `.json.bak` copy. The plugin writes a short-lived `archon-run-*.json` agent into
    `~/.kiro/agents` for each workflow node, so an upgrade there could change the
    restrictions those files set.
  - **Workspace trust:** whether V3's new "Trust this workspace?" prompt affects headless
    runs in folders Kiro hasn't seen, which includes every new worktree.

If a Kiro node fails on 3.x, these are the first things to look at. Run with
`--no-worktree`, and check `~/.kiro/agents` for `archon-run-*.json.bak` files.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `archon version` shows an old version | Another `archon` comes first on `PATH`. Run `type -a archon` and remove the one you don't want (on a Mac, often `brew uninstall archon`). |
| `kiro-cli: command not found` on Ubuntu | `~/.local/bin` isn't on `PATH` in this terminal. Run `export PATH="$HOME/.local/bin:$PATH"`, or log in again. |
| Kiro's installer stops because `unzip` is missing | `sudo apt install -y unzip` |
| `kiro-cli login` can't open a browser (SSH, server) | `kiro-cli login --use-device-flow` |
| The Archon installer stops with an AVX2 message (Ubuntu x64) | The CPU or VM doesn't expose AVX2. Build Archon from source (step 2). |
| `plugin add`: `Could not read refs of https://github.com/…` | git is missing or can't reach GitHub. Install git (step 1) and check your network or proxy settings. |
| `plugin add`: `Could not find the latest release of …` | The repository has no published release yet, or GitHub couldn't be reached. Name a tag that exists (`…@v0.1.0`), or [build from source](#building-from-source). |
| `plugin add`: `Release … has no archon-provider-kiro-<os>-<arch> for this platform` | There's no release build for your system (for example Windows on Arm). [Build from source](#building-from-source). |
| `plugin add`: `… belongs to local/kiro-archon-connector. Remove it first` | A from-source install owns the executable. Run `bun run install:local --remove` in that clone, or the `archon plugin remove` command shown, then add again. |
| `archon doctor`: `kiro: Kiro CLI` fails | `kiro-cli` isn't on the `PATH` Archon sees. This is common when `archon serve` runs as a service, which doesn't read `~/.profile`. Set `assistants.kiro.kiroPath: /home/you/.local/bin/kiro-cli` in `~/.archon/config.yaml`. |
| `archon doctor`: `kiro: Kiro login` fails | Run `kiro-cli login`, then `kiro-cli whoami`. |
| `archon doctor` asks you to run `archon skill add .` | Archon 0.14 expects its `archon-cli` skill in any project that has `.claude/skills`, for example after `playwright-cli install --skills`. Run that command, or ignore it. It doesn't affect Kiro. |
| `Cannot determine git remote … use --no-worktree` | The repository you're running in has no `origin`. Add one, or pass `--no-worktree`. |
| The `kiro-playwright-mcp` sample fails on its first run | Kiro gives an MCP server 30 seconds to start, and the first `npx` download can take longer. Run `npx -y @playwright/mcp@0.0.85 --help` once, then retry. |
| A node fails as `misconfigured` with `InvalidModelError` | The model name is wrong. List valid ones with `kiro-cli chat --list-models`. |
