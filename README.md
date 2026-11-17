# kiro-archon-connector

An [Archon](https://github.com/coleam00/Archon) provider plugin that runs workflow nodes on
[Kiro CLI](https://kiro.dev/docs/cli/) in headless mode. Once installed, any node can say
`provider: kiro`:

```yaml
nodes:
  - id: review
    provider: kiro
    model: minimax-m2.5
    allowed_tools: [read]
    prompt: "Review the changes in this branch and list the risky ones."
```

Each node turn runs one `kiro-cli chat --v3 --no-interactive --output-format stream-json`
process. The plugin translates Kiro's ACP event stream into Archon's provider contract
(protocol 3), so the node gets streaming text, reasoning, tool calls, structured output,
typed failures and session resume.

**Tested with** Archon 0.13.2 and 0.14.0 (official release binaries), Kiro CLI 2.37.1, on
macOS arm64. See [Testing](#testing) for what is covered. On Ubuntu 26.04 the full install
works (see [INSTALL.md](INSTALL.md)), and CI runs the offline suites on Ubuntu 26.04 x64,
but no real Kiro turn has been run on Linux. The Windows build compiles but is untested, and
its cancellation falls back to signalling only the `kiro-cli` process (process groups are
POSIX).

**Kiro CLI 3.x** (3.0 shipped 3 November 2026; 3.3.0 is current) has not been tested with a
real turn. The plugin's flags and sign-in check work on 3.3.0. See
[INSTALL.md](INSTALL.md#kiro-3x) for what is still open.

## Quick start

**[INSTALL.md](INSTALL.md)** walks through installing Kiro CLI, the latest Archon and this
plugin on **macOS** or **Ubuntu 26.04**, with the expected output of each step and
troubleshooting. The short version:

1. **Kiro CLI, signed in.** `kiro-cli login` (`--use-device-flow` without a browser, or set
   `KIRO_API_KEY`), then check with `kiro-cli whoami`.
2. **Archon 0.13.2 or newer.** The plugin speaks plugin protocol 3. 0.13.0 used protocol 2,
   and 0.13.2 is the oldest release tested (`brew upgrade archon` gives 0.13.2; the
   [installer](https://archon.diy/getting-started/installation/) gives the latest).
3. **Add the plugin** from its latest GitHub release:

   ```sh
   archon plugin add sourceinvader/kiro-archon-connector
   archon plugin list      # sourceinvader/kiro-archon-connector  provider  v0.1.0 ...
   archon doctor           # ✓ kiro: Kiro CLI / Kiro login
   ```

   Restart a running `archon serve` afterwards. `archon plugin update …` and
   `archon plugin remove …` manage it from then on.

To run unreleased changes, build from a clone with Bun 1.3+ instead: `bun install && bun run
install:local` (see [Building from source](INSTALL.md#building-from-source)).

### Try the sample workflows

This repository carries ready-to-run workflows in `.archon/workflows/`. Each one pins the
cheap `minimax-m2.5` model, except `kiro-gherkin-playwright-loop`, which pins the cheaper
`minimax-m2.1`. Run them from this directory:

| Workflow | What it shows | Expected result |
|---|---|---|
| `kiro-hello` | One Kiro turn, reply printed by a bash node | completes, prints `KIRO-ARCHON-OK` |
| `kiro-feature-tour` | Plain reply, session recall (`context: shared`), structured output, tool use, `allowed_tools`, `systemPrompt`, a per-node MCP server, a per-node skill, and skill exactness; each step checked by a bash node | completes; every check node passes |
| `kiro-playwright-mcp` | A browser-only node (`mcp: .archon/mcp/playwright.json`, `allowed_tools: []`) opens example.com and returns its title | completes, title `Example Domain` |
| `kiro-playwright-cli` | A node with `skills: [playwright-cli]` drives the browser through `playwright-cli` shell commands | completes, title `Example Domain` (needs the setup below) |
| `kiro-gherkin-playwright-loop` | A `loop_group`: each round Kiro probes a site with `playwright-cli`, writes one or two Gherkin scenarios and turns them into Playwright tests, then a bash node runs them; failures send the run back to the probe (3 rounds at most). Pins `minimax-m2.1`; needs Archon 0.14.0, Node.js and the Playwright CLI setup below | completes, prints `GHERKIN-LOOP-PASS` and where the feature file and tests are |
| `kiro-repo-summary` | A read-only node (`allowed_tools: [read]`) with `output_format` summarising the repository | completes, prints purpose and language |
| `kiro-session-probe` | Session resume: `context: shared` between plain nodes and between nodes on different ephemeral agents, and a `loop_group` with `fresh_context: false` (round 2 remembers round 1) against `fresh_context: true` (it forgets). Needs Archon 0.14.0 | completes; prints `SESSION-SHARED-PASS`, `SESSION-CROSS-AGENT-PASS`, `SESSION-LOOP-PASS`, `SESSION-LOOP-FRESH-PASS` |
| `kiro-bad-model` | How a configuration error surfaces | **fails** as `misconfigured` with Kiro's `InvalidModelError`, no retry |
| `kiro-cancel-demo` | Cancelling a running node kills Kiro and its commands | see the steps in the workflow's description |

```sh
archon workflow run kiro-hello --no-worktree
archon workflow run kiro-feature-tour --no-worktree      # needs bun on PATH (demo MCP server)
archon workflow run kiro-playwright-mcp --no-worktree
archon workflow run kiro-repo-summary --no-worktree
archon workflow run kiro-session-probe --no-worktree       # needs Archon 0.14.0
archon workflow run kiro-bad-model --no-worktree        # expected to fail

# Playwright CLI: one-time setup in this repository, then run
npm install -g @playwright/cli@latest
playwright-cli install --skills                          # writes .claude/skills/playwright-cli
archon workflow run kiro-playwright-cli --no-worktree
archon workflow run kiro-gherkin-playwright-loop --no-worktree               # TodoMVC demo
archon workflow run kiro-gherkin-playwright-loop --no-worktree https://the-internet.herokuapp.com/challenging_dom

archon workflow run kiro-cancel-demo --no-worktree --detach
pgrep -fl "sleep 237"                                    # Kiro's command is running
archon workflow runs                                     # find the run id
archon workflow cancel <run-id>
pgrep -fl "sleep 237"                                    # nothing: it died with Kiro
```

With `--no-worktree` a run uses your checkout as it is, including uncommitted changes.
Without the flag, each run gets its own worktree branched from `origin/main` (tested with
`kiro-hello`), so it only sees what you have pushed. `kiro-playwright-cli` and
`kiro-gherkin-playwright-loop` always need `--no-worktree`: the skill is an untracked file
in your checkout, and a worktree doesn't include untracked files. The feature tour writes
`kiro-made.txt` and removes it in its last node. The Gherkin loop writes into the run's
artifacts directory, not your checkout.

## Configuration

Optional defaults in `~/.archon/config.yaml` (or a project's `.archon/config.yaml`):

```yaml
defaultAssistant: kiro        # optional: make Kiro the default provider
assistants:
  kiro:
    model: minimax-m2.5       # kiro-cli chat --list-models; unset = Kiro's default ("auto")
    agent: my-reviewer        # a Kiro agent name; unset = Kiro's default agent
    effort: medium            # low | medium | high | xhigh | max (models without levels ignore it)
    trustAllTools: true       # default true; see "Tools and approval" below
    kiroPath: /opt/bin/kiro-cli   # only when kiro-cli is not on PATH (install-only setting)
```

Unknown or misspelled keys are rejected when Archon loads the config. A node's `model:`
and `effort:` override these defaults; `kiro/<model>` also works as a model reference.
The plugin also honours `KIRO_CLI_PATH` and `KIRO_API_KEY` from the environment.

## What the plugin supports

| Archon feature | Kiro mapping | Declared capability |
|---|---|---|
| Streaming reply and reasoning | ACP `agent_message_chunk` / `agent_thought_chunk`, coalesced into blocks | — |
| Tool calls | ACP `tool_call` / `tool_call_update`; every call gets exactly one closing update | — |
| Per-node MCP servers (`mcp:`) | The file's servers become the node's only MCP servers; `--require-mcp-startup` fails the node as `misconfigured` before any model work if one does not start; each is reported as `mcp_server_status` | `mcp: true` |
| Per-node skills (`skills:`) | Exactly the named skills, loaded from `.kiro/skills`, `.agents/skills` or `.claude/skills` (project, then home); none when omitted | `skills: true`, `skillDiscovery` |
| Session resume (`context: shared`, `persist_session`) | `--resume-id`; a session Kiro no longer has is confirmed via `--list-sessions` and reported as `sessionNotFound` | `sessionResume: true` |
| `model:` | `--model` | — |
| `effort:` | `--effort`, Archon rungs clamped down to Kiro's five levels | `effortControl: true` |
| `allowed_tools` / `denied_tools` | `tools` / `excludedTools` of an ephemeral Kiro agent, which removes the tools from the session | `toolRestrictions: true` |
| `systemPrompt` | `prompt` of an ephemeral Kiro agent | — |
| `output_format` | Schema appended to the prompt, JSON parsed in tiers (with repair); Archon validates and re-asks | `structuredOutput: 'best-effort'` |
| Failures | Kiro's typed `errorType` / `retryErrorType` → `auth`, `quota_exhausted`, `rate_limited`, `overloaded`, `misconfigured`, `transient`, `unknown`. Never classified from prose. | — |
| Cancellation | SIGTERM to Kiro's whole process group (Kiro ignores SIGINT without a terminal), SIGKILL after 5 s | — |
| `archon doctor` | CLI version, login, configured model | `diagnose`, `listModels` |
| Credential preflight | `kiro-cli whoami --format json`; `KIRO_API_KEY` counts as usable | native auth only |
| Per-turn environment | Archon's request env is passed to `kiro-cli` | `envInjection: true` |

Not supported (declared `false`, so Archon warns or refuses before spending anything):
hooks, inline sub-agents, Archon's chat tools (`invoke_workflow`, `manage_run`; Archon's
chat falls back to running `archon` commands through the shell), container execution,
session fork (named `context: { resume: node }`), spend limits, fallback models.

Without fork, a workflow with a named `context: { resume: node }` fails to load (`archon
validate` names the node). That includes a `loop_group`'s named owner sessions. Plain
resume covers the rest. `context: shared` works between any two Kiro nodes, even ones with
different skills or tools. A `loop_group` with `fresh_context: false` (the default) keeps
one Kiro session across rounds, so round 2 remembers round 1. `kiro-session-probe` checks
all of this.

### MCP servers and skills in workflow nodes

Archon's rule is exact selection: a workflow node gets the MCP servers in its `mcp:` file
and the skills in its `skills:` list, and nothing else of yours. So every workflow node
runs on an ephemeral Kiro agent (see below) that

- lists only the declared servers in `mcpServers`, and starts them with
  `--require-mcp-startup`;
- uses Kiro's built-in tools (`@builtin`) plus `@<server>` for each declared server,
  instead of `*`. Kiro still starts the servers in your own `~/.kiro/settings/mcp.json` and
  workspace `.kiro/settings/mcp.json` in the background, but their tools are not available
  to the node, and one that fails to start does not fail it;
- turns off powers (`includePowers: false`);
- denies Kiro's on-demand skill loader (its `skill` capability), which would otherwise load
  any `.kiro/skills` skill the conversation names, and delivers each declared skill's
  `SKILL.md` up front instead, with a note giving the skill's directory so its relative
  references resolve. `AGENTS.md` and always-included steering still load; steering that
  Kiro would load on demand does not.

MCP config files use Archon's format (`{ "name": { "command", "args", "env" } }`, `type:
"http"`/`"sse"` with `url` and `headers`, or the `{ "mcpServers": {...} }` wrapper).
`$VAR` and `${VAR}` in `env` and `headers` values are expanded from the run's environment;
an undefined one becomes empty and the node gets a `kiro.mcp_env_vars_missing` warning.
`allowed_tools: []` plus `mcp:` makes an MCP-only node. A missing or malformed file, or a
skill that is not installed, fails the node as `misconfigured` before Kiro starts, and
`archon validate workflows` reports a missing skill with the folders it searched.

Archon's chat (no workflow node) keeps Kiro's native behaviour: your default agent, your
MCP servers and your skills.

### Playwright

Both routes are tested end to end:

- **MCP server**: `.archon/mcp/playwright.json` runs `npx -y @playwright/mcp@0.0.85
  --headless --isolated`. Kiro waits at most 30 seconds for a server to start, so if the
  first run times out while npx downloads the package, run
  `npx -y @playwright/mcp@0.0.85 --help` once and retry.
- **CLI with its skill**: `npm install -g @playwright/cli@latest`, then
  `playwright-cli install --skills` in the repository, and give the node
  `skills: [playwright-cli]`. The skill teaches Kiro the CLI; Kiro runs it with its shell
  tool, so do not deny `shell` on that node. Playwright's CLI authors recommend this route
  for coding agents because it costs fewer tokens than MCP tool schemas and page snapshots.

Both use your installed Google Chrome (or Playwright's Chromium) and need network access.

### Tools and approval

Headless Kiro cannot ask for tool approval, so without `--trust-all-tools` any tool that
needs one is denied. Workflow nodes are autonomous on Archon's other providers too, so the
default is `trustAllTools: true`. To limit a node, restrict which tools *exist* with
`allowed_tools` / `denied_tools`, using Kiro V3 tool names or tags: `read`, `write`,
`shell`, `web`, `subagent`, `@builtin`, `@server`, `@server/tool`, `*`.

Denying `shell` does not stop file writes: Kiro will use its `write` tool instead. Deny
both, or use `allowed_tools: [read]`, for a read-only node. `allowed_tools: []` leaves the
node with no tools at all.

### How restrictions and system prompts reach Kiro

Kiro has no flag for a system prompt, a tool list, per-run MCP servers or skills, and
`--agent` accepts only a name. So every workflow node (and a chat turn with a system prompt)
runs on an ephemeral agent `archon-run-<random>.json` written into Kiro's global agent
directory (`$KIRO_HOME/agents`, else `~/.kiro/agents`), passed as `--agent archon-run-…`,
and deleted when the turn ends, whether it succeeds, fails or is cancelled. Leftovers from a
crash are swept after six hours. The workspace's `.kiro/agents` is never written, so nothing
appears in the run's diff.

With `assistants.kiro.agent` set, the plugin copies that agent's JSON definition
(workspace `.kiro/agents/` first, then global) and applies the node on top; in a workflow
node the agent's own MCP servers and `skill://` resources are replaced by the node's. A
Markdown-only agent, or a built-in agent other than `kiro_default`, cannot be copied, so
workflow nodes fail as `misconfigured` before Kiro starts.

### Authentication

Signed-out headless Kiro starts an interactive browser login instead of failing. The plugin
runs `kiro-cli whoami --format json` before every turn (unless `KIRO_API_KEY` is set) and
fails the node as `auth` when no account is signed in, so a workflow never opens a browser.

### Cost reporting

Kiro reports usage in credits, not money, and no token counts. Archon therefore shows
`Cost: unknown` for Kiro nodes. Pick a cheap model with `kiro-cli chat --list-models`
(the `rate_multiplier` column).

## Testing

```sh
bun run check          # type-check + unit + conformance (no Kiro account needed)
bun run test:live      # real Kiro, spends credits (KIRO_LIVE_MODEL, default minimax-m2.5)
ARCHON_BIN=/path/to/archon bun run e2e   # real Archon + real Kiro, the sample workflows
```

- **Unit** (`test/unit`, 138 tests): the stream mapper on recorded Kiro streams, failure
  classification, config schemas, MCP config loading and translation, skill resolution, the
  ephemeral agent and workflow isolation, structured-output parsing, and the provider
  driving a fake `kiro-cli`. The fake replays recorded streams through the real process,
  stdin, line and exit-code paths, including a hang scenario with a real grandchild process
  to prove that cancellation kills the whole group.
- **Conformance** (`test/conformance`, 13 tests): Archon's own `runProviderConformance` and
  `checkCredentialStatuses` against the provider in process, as a plugin process over stdio,
  and as the compiled executable (rebuilt each run), including MCP and skill turns and their
  failure cases, plus the handshake and RPC diagnostics.
- **Live** (`test/live`, 20 tests): plain reply, tools, resume, missing session,
  `allowed_tools` and `denied_tools` actually enforced, system prompt, structured output,
  effort, an unknown model, mid-tool cancellation (the command is seen running, then gone),
  credential, model and diagnostic checks; an MCP tool really called, an MCP startup
  failure, the workspace's own MCP servers excluded, an MCP-only node, a declared skill
  used, an undeclared `.kiro` skill unloadable even by name, and Playwright through both MCP
  and the CLI skill. The isolation tests each run a control turn without isolation that
  must see the ambient server or skill, so they cannot pass vacuously.
- **End to end** (`e2e/run.ts`, 38 checks): builds and installs the plugin into an isolated
  `ARCHON_HOME`, then has the real Archon CLI list it, run `doctor`, validate every sample
  workflow, run `kiro-hello`, `kiro-feature-tour` (in a worktree), `kiro-playwright-mcp`
  and `kiro-playwright-cli`, run `kiro-bad-model`, and cancel `kiro-cancel-demo`
  mid-command. Passes on Archon 0.13.2 and 0.14.0.

Test fixtures in `test/fixtures` are real Kiro streams recorded with
`bun scripts/record-fixtures.ts` (paths replaced by `{{CWD}}`/`{{HOME}}`). Throttling,
quota, auth-denial and capacity cases cannot be triggered on demand; they are synthesized
from the recorded invalid-model failure by swapping its typed error fields, and marked
`synthesized` in their `.meta.json`.

## Publishing

Archon installs provider plugins from GitHub releases, and only from **public**
repositories: `archon plugin add` reads `archon-plugin.json` from
`raw.githubusercontent.com` without credentials. To publish, make the repository public,
add the `archon-plugin` topic to list it on archon.diy, and push a tag that matches
`package.json`'s version:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds `archon-provider-kiro-<os>-<arch>` for macOS, Linux
and Windows with `checksums.txt` and attaches them to the release. Users then install with:

```sh
archon plugin add <owner>/<repo>
```

Remove a local install first (`bun run install:local --remove`), because both would own the
same executable.

Before the first real release, this path was checked by running Archon 0.14.0's own
`plugin add`, `@tag`, `update` and `remove` code against a local stand-in for github.com
that served assets built by `scripts/build.ts --all`. Archon installed the darwin-arm64
build, verified its checksum and ran `kiro-hello`. The linux-arm64 build also starts and
answers `initialize` on Ubuntu 26.04.

## Layout

```
INSTALL.md                install Archon and this plugin, step by step
KIRO-LEARNINGS.md         field notes on Kiro CLI
ARCHON-LEARNINGS.md       field notes on Archon
archon-plugin.json        provider manifest (executable archon-provider-kiro)
src/main.ts               plugin entry: serveProvider over stdio
src/provider.ts           IAgentProvider: turns, credentials, models, diagnostics
src/stream.ts             Kiro stream-json → Archon provider events
src/failure.ts            Kiro error identity → failure class
src/agent-file.ts         ephemeral Kiro agents: restrictions, prompts, workflow isolation
src/mcp-config.ts         a node's mcp: file → Kiro mcpServers (Archon's format and expansion)
src/skills.ts             a node's skills: names → SKILL.md files in the declared roots
src/process.ts            one kiro-cli process per turn, process-group cancellation
src/kiro-cli.ts           whoami, --list-models, --list-sessions, --version
src/structured-output.ts  best-effort JSON (adapted from Archon, MIT)
src/config.ts             assistants.kiro schemas (install / run / snapshot)
src/descriptor.ts         descriptor and capabilities
vendor/provider-contract  Archon's provider contract v0.14.0, vendored (not on npm yet)
.archon/workflows/        sample workflows
.archon/mcp/              MCP configs the samples use (Playwright, demo secret server)
.kiro/skills/             demo skill used by kiro-feature-tour
scripts/                  build, local install, fixture recording
e2e/                      real-Archon end-to-end driver
test/                     unit, conformance and live suites, fixtures, fake kiro-cli
```

## License

MIT. `vendor/provider-contract` and `src/structured-output.ts` derive from Archon
(MIT, Copyright (c) 2025-2026 Cole Medin).
