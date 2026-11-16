# Installing Archon and the Kiro plugin

This guide takes a machine from nothing to a working Kiro node in Archon, on **macOS** or
**Ubuntu 26.04**. You install four tools, then Archon, then this plugin from the private
repository `sourceinvader/kiro-archon-connector`, and finish with a test run.

| Step | macOS | Ubuntu 26.04 |
|---|---|---|
| 1. Tools: git, GitHub CLI, Bun, Kiro CLI | [macOS tools](#1-macos-tools) | [Ubuntu tools](#1-ubuntu-2604-tools) |
| 2. Archon | [macOS Archon](#2-macos-archon) | [Ubuntu Archon](#2-ubuntu-2604-archon) |
| 3. The plugin | [Install the plugin](#3-install-the-plugin) | same |
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
| Tool installs | already installed: Kiro 2.37.1, Bun 1.3.11 | `apt` packages, GitHub CLI 2.104.0, Bun 1.4.4, Kiro CLI 3.3.0, all from the commands below |
| Archon 0.14.0 | official release binary (the installer script was not run on the Mac) | official installer, including its `sudo` step |
| Plugin build and install | fresh `gh repo clone` of the private repo, `install:local` | `install:local` from a copy of the repo (the container had no GitHub login) |
| `archon plugin list`, `archon doctor` | pass | pass, except for "Kiro login", because the container was never signed in |
| A real Kiro run (`kiro-hello`) | pass, including a worktree run | not run (needs a Kiro login) |

The plugin's build and offline test suites also run in CI on GitHub's Ubuntu 26.04 x64
runner and on macOS, on every push.

---

## 1. macOS tools

You need git, the GitHub CLI, Bun 1.3 or newer, and Kiro CLI.

```sh
xcode-select --install          # git, if `git --version` asks for it
brew install gh                 # GitHub CLI
gh auth login                   # sign in with an account that can read the repo
curl -fsSL https://bun.com/install | bash
exec $SHELL -l                  # pick up Bun's PATH change
bun --version
```

Install Kiro CLI from [kiro.dev](https://kiro.dev/docs/cli/), then sign in:

```sh
kiro-cli login
kiro-cli whoami                 # shows your account
kiro-cli --version
```

Next: [macOS Archon](#2-macos-archon).

## 1. Ubuntu 26.04 tools

Run these as your normal user (not root). `sudo` asks for your password where it's needed.

**Base packages.** Bun's installer needs `unzip`.

```sh
sudo apt update
sudo apt install -y curl unzip git ca-certificates
```

**GitHub CLI**, from GitHub's own apt repository. Ubuntu 26.04's own `gh` package is
version 2.46.0, which GitHub's maintainers say is broken, so don't use `apt install gh`
without adding this repository first.

```sh
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y
gh auth login                   # sign in with an account that can read the repo
```

**Bun.** It installs into `~/.bun/bin` and adds that folder to `PATH` in `~/.bashrc`.

```sh
curl -fsSL https://bun.com/install | bash
source ~/.bashrc
bun --version                   # 1.4.4 when this was tested
```

**Kiro CLI.** It installs into `~/.local/bin`. Ubuntu's `~/.profile` puts that folder on
`PATH` at your next login, so for the current terminal add it yourself:

```sh
curl -fsSL https://cli.kiro.dev/install | bash
export PATH="$HOME/.local/bin:$PATH"     # this terminal only; new logins get it from ~/.profile
kiro-cli --version                       # kiro-cli 3.3.0 when this was tested
```

Kiro needs glibc 2.34 or newer, and Ubuntu 26.04 has 2.43.

**Sign in to Kiro.** On a desktop, `kiro-cli login` opens your browser. Over SSH or on a
server with no browser, use the device flow: Kiro prints a URL and a code that you enter in
a browser on any other device.

```sh
kiro-cli login --use-device-flow
kiro-cli whoami                          # shows your account
```

Kiro Pro, Pro+, Pro Max and Power subscribers can create an API key instead and set
`KIRO_API_KEY`. The plugin then skips its sign-in check.

Next: [Ubuntu Archon](#2-ubuntu-2604-archon).

---

## 2. macOS Archon

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
Next: [Install the plugin](#3-install-the-plugin).

## 2. Ubuntu 26.04 Archon

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

## 3. Install the plugin

The same on both systems. You need the GitHub CLI signed in (`gh auth status`) and Bun on
`PATH`.

```sh
gh repo clone sourceinvader/kiro-archon-connector
cd kiro-archon-connector
bun install
bun run install:local
```

`install:local` compiles `archon-provider-kiro` for your machine and installs it into your
Archon home (`$ARCHON_HOME`, or `~/.archon` by default), the same way `archon plugin add`
would. It ends with:

```text
Installed local/kiro-archon-connector (provider 'kiro', v0.1.0) into /home/you/.archon
  executable: /home/you/.archon/plugins/archon-provider-kiro
  receipt:    /home/you/.archon/plugins/installed/local/kiro-archon-connector/receipt.json
Check it with: archon plugin list && archon doctor
```

To install into another Archon home, set `ARCHON_HOME` or pass
`--archon-home /absolute/path`. If `archon serve` is running, restart it. A new CLI command
picks up the plugin straight away.

### Why not `archon plugin add`?

Archon's usual route, `archon plugin add owner/repo`, can't install from a private
repository. It reads `archon-plugin.json` from `raw.githubusercontent.com` without your
credentials, and Archon's own source says "a private repository cannot be installed". On
this repository it fails like this:

```text
Error: No archon-plugin.json for sourceinvader/kiro-archon-connector at commit cbc8d79…
(https://raw.githubusercontent.com/sourceinvader/kiro-archon-connector/…/archon-plugin.json returned 404)
```

It also needs a GitHub release with prebuilt binaries, and this repository doesn't have one
yet. If the repository is made public and a `v*` tag is pushed (see
[Publishing](README.md#publishing)), `archon plugin add sourceinvader/kiro-archon-connector`
will work. Run `bun run install:local --remove` first, because both installs would own the
same executable.

## 4. Check the install

```sh
archon plugin list
archon doctor
```

Expected:

```text
local/kiro-archon-connector  provider  v0.1.0  9293ab7182f0  archon >=0.13.2

✓ Installed providers: kiro (0.1.0)
✓ kiro: Kiro CLI: kiro-cli 2.37.1 at kiro-cli
✓ kiro: Kiro login: Signed in (BuilderId)
○ kiro: Kiro model: No model configured; Kiro's default applies
✓ Assistant login: kiro: usable
✓ Provider support: kiro is supported
...
All checks passed.
```

The commit and the Kiro version will be whatever you have. A `○` line is information, not
a failure. If `Kiro login` shows `✗`, sign in to Kiro (step 1) and run `archon doctor`
again.

## 5. Pick a default model

With no model configured, Kiro uses `auto`, which costs the full credit rate. To use a
cheaper default, add this to `~/.archon/config.yaml` (create the file if it doesn't exist):

```yaml
assistants:
  kiro:
    model: minimax-m2.5      # list models with: kiro-cli chat --list-models
```

A node's own `model:` still wins, and the sample workflows all pin `minimax-m2.5` anyway.
To make Kiro the provider for nodes that don't name one, add `defaultAssistant: kiro`. The
other settings are in [Configuration](README.md#configuration).

## 6. First run

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
you have **pushed**, not your local edits. To run against your checkout as it is, add
`--no-worktree`.

The other samples are in [Try the sample workflows](README.md#try-the-sample-workflows).
`kiro-playwright-cli` needs `--no-worktree`, because its skill is installed into your
checkout as an untracked file, and a worktree doesn't contain untracked files.

To use Kiro in your own project, give a node `provider: kiro` (or set `defaultAssistant`):

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
cd kiro-archon-connector
git pull
bun install
bun run install:local      # rebuilds and replaces the installed copy
```

Restart `archon serve` if it's running.

**Archon:** rerun the installer from step 2 (or `brew upgrade archon`), then
`archon doctor`. The plugin doesn't need rebuilding for a new Archon release as long as
that release still speaks plugin protocol 3 (0.13.2 and 0.14.0 both do). If a later release
changes the protocol, the plugin will stop serving Kiro nodes until it's updated. Check
`archon plugin list` and `archon doctor` after every Archon upgrade.

**Kiro CLI:** `kiro-cli update`. Read [Kiro 3.x](#kiro-3x) before moving from 2.x to 3.x.

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

## Removing the plugin

```sh
cd kiro-archon-connector
bun run install:local --remove
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `archon version` shows an old version | Another `archon` comes first on `PATH`. Run `type -a archon` and remove the one you don't want (on a Mac, often `brew uninstall archon`). |
| `bun: command not found` right after installing Bun | Your shell hasn't reloaded its startup file. Run `source ~/.bashrc` (Ubuntu) or `exec $SHELL -l` (macOS), or open a new terminal. |
| `error: unzip is required to install bun` | `sudo apt install -y unzip` |
| `kiro-cli: command not found` on Ubuntu | `~/.local/bin` isn't on `PATH` in this terminal. Run `export PATH="$HOME/.local/bin:$PATH"`, or log in again. |
| `kiro-cli login` can't open a browser (SSH, server) | `kiro-cli login --use-device-flow` |
| `archon doctor`: `kiro: Kiro CLI` fails | `kiro-cli` isn't on the `PATH` Archon sees. This is common when `archon serve` runs as a service, which doesn't read `~/.profile`. Set `assistants.kiro.kiroPath: /home/you/.local/bin/kiro-cli` in `~/.archon/config.yaml`. |
| `archon doctor`: `kiro: Kiro login` fails | Run `kiro-cli login`, then `kiro-cli whoami`. |
| The Archon installer stops with an AVX2 message (Ubuntu x64) | The CPU or VM doesn't expose AVX2. Build Archon from source (step 2). |
| `archon plugin add sourceinvader/kiro-archon-connector` fails with `returned 404` | The repository is private. Use `bun run install:local` (step 3). |
| `gh repo clone` fails with "Could not resolve to a Repository" | The GitHub account you signed in with can't see the private repository. Check `gh auth status`, and ask the owner to add you as a collaborator. |
| `archon-provider-kiro is already installed by …` | Another install (for example `archon plugin add`) owns the executable. Remove it with the `archon plugin remove …` command shown, then install again. |
| `archon doctor` asks you to run `archon skill add .` | Archon 0.14 expects its `archon-cli` skill in any project that has `.claude/skills`, for example after `playwright-cli install --skills`. Run that command, or ignore it. It doesn't affect Kiro. |
| `Cannot determine git remote … use --no-worktree` | The repository you're running in has no `origin`. Add one, or pass `--no-worktree`. |
| The `kiro-playwright-mcp` node fails on its first run | Kiro gives an MCP server 30 seconds to start, and the first `npx` download can take longer. Run `npx -y @playwright/mcp@0.0.85 --help` once, then retry. |
| A node fails as `misconfigured` with `InvalidModelError` | The model name is wrong. List valid ones with `kiro-cli chat --list-models`. |
