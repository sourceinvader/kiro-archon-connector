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
macOS arm64. See [Testing](#testing) for what is covered. Linux builds run the offline
suites in CI; the Windows build compiles but is untested, and its cancellation falls back
to signalling only the `kiro-cli` process (process groups are POSIX).

## Quick start

1. **Archon 0.13.2 or newer.** Provider plugins need plugin protocol 3, which arrived in
   Archon 0.13.2 (`brew upgrade archon`, or a binary from the
   [releases page](https://github.com/coleam00/Archon/releases)).
2. **Kiro CLI, signed in.** `kiro-cli login` (or set `KIRO_API_KEY` for a headless account),
   then check with `kiro-cli whoami`.
3. **Bun 1.3+** to build the plugin.
4. Build and install into your Archon home (`$ARCHON_HOME`, default `~/.archon`):

   ```sh
   bun install
   bun run install:local
   archon plugin list      # local/kiro-archon-connector  provider  v0.1.0 ...
   archon doctor           # ✓ kiro: Kiro CLI / Kiro login / Kiro model
   ```

   `bun run install:local --remove` uninstalls it. Restart a running `archon serve`
   after installing or removing it.

### Try the sample workflows

This repository carries ready-to-run workflows in `.archon/workflows/`. Each one pins the
cheap `minimax-m2.5` model. Run them from this directory:

| Workflow | What it shows | Expected result |
|---|---|---|
| `kiro-hello` | One Kiro turn, reply printed by a bash node | completes, prints `KIRO-ARCHON-OK` |
| `kiro-feature-tour` | Plain reply, session recall (`context: shared`), structured output, tool use, `allowed_tools`, `systemPrompt`; each step checked by a bash node | completes; every check node passes |
| `kiro-repo-summary` | A read-only node (`allowed_tools: [read]`) with `output_format` summarising the repository | completes, prints purpose and language |
| `kiro-bad-model` | How a configuration error surfaces | **fails** as `misconfigured` with Kiro's `InvalidModelError`, no retry |
| `kiro-cancel-demo` | Cancelling a running node kills Kiro and its commands | see the steps in the workflow's description |

```sh
archon workflow run kiro-hello --no-worktree
archon workflow run kiro-feature-tour --no-worktree
archon workflow run kiro-repo-summary --no-worktree
archon workflow run kiro-bad-model --no-worktree        # expected to fail

archon workflow run kiro-cancel-demo --no-worktree --detach
pgrep -fl "sleep 237"                                    # Kiro's command is running
archon workflow runs                                     # find the run id
archon workflow cancel <run-id>
pgrep -fl "sleep 237"                                    # nothing: it died with Kiro
```

`--no-worktree` is needed while this repository has no git remote: Archon only creates
worktrees for a repository with one. With a remote, drop the flag and each run gets its own
worktree. The feature tour writes `kiro-made.txt` and removes it in its last node.

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
per-node MCP servers, skills, hooks, inline sub-agents, Archon native tools, container
execution, session fork (named `context: { resume: node }`), spend limits, fallback models.

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

Kiro has no flag for a system prompt or a tool list, and `--agent` accepts only a name.
For a node that needs one, the plugin writes an ephemeral agent
`archon-run-<random>.json` into Kiro's global agent directory (`$KIRO_HOME/agents`, else
`~/.kiro/agents`), passes `--agent archon-run-…`, and deletes the file when the turn ends,
whether it succeeds, fails or is cancelled. Leftovers from a crash are swept after six hours.
The workspace's `.kiro/agents` is never written, so nothing appears in the run's diff.

From scratch, the ephemeral agent mirrors Kiro's default agent (all tools, your `mcp.json`
servers and powers); project guidance such as `AGENTS.md` and `.kiro/steering` still loads.
With `assistants.kiro.agent` set, the plugin copies that agent's JSON definition
(workspace `.kiro/agents/` first, then global) and applies the node on top. A Markdown-only
or built-in agent other than `kiro_default` cannot be combined with restrictions; the node
fails as `misconfigured` before Kiro starts.

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

- **Unit** (`test/unit`, 103 tests): the stream mapper on recorded Kiro streams, failure
  classification, config schemas, the ephemeral agent, structured-output parsing, and the
  provider driving a fake `kiro-cli`. The fake replays recorded streams through the real
  process, stdin, line and exit-code paths, including a hang scenario with a real
  grandchild process to prove that cancellation kills the whole group.
- **Conformance** (`test/conformance`, 13 tests): Archon's own `runProviderConformance` and
  `checkCredentialStatuses` against the provider in process, as a plugin process over stdio,
  and as the compiled executable, plus the handshake and RPC diagnostics.
- **Live** (`test/live`, 12 tests): plain reply, tools, resume, missing session,
  `allowed_tools` and `denied_tools` actually enforced, system prompt, structured output,
  effort, an unknown model, mid-tool cancellation (the command is seen running, then gone),
  and credential, model and diagnostic checks.
- **End to end** (`e2e/run.ts`, 30 checks): builds and installs the plugin into an isolated
  `ARCHON_HOME`, then has the real Archon CLI list it, run `doctor`, validate every sample
  workflow, run `kiro-hello` and `kiro-feature-tour` (in a worktree), run `kiro-bad-model`,
  and cancel `kiro-cancel-demo` mid-command.

Test fixtures in `test/fixtures` are real Kiro streams recorded with
`bun scripts/record-fixtures.ts` (paths replaced by `{{CWD}}`/`{{HOME}}`). Throttling,
quota, auth-denial and capacity cases cannot be triggered on demand; they are synthesized
from the recorded invalid-model failure by swapping its typed error fields, and marked
`synthesized` in their `.meta.json`.

## Publishing

Archon installs provider plugins from GitHub releases. Push this repository to GitHub, add
the `archon-plugin` topic to list it on archon.diy, and push a tag:

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

## Layout

```
archon-plugin.json        provider manifest (executable archon-provider-kiro)
src/main.ts               plugin entry: serveProvider over stdio
src/provider.ts           IAgentProvider: turns, credentials, models, diagnostics
src/stream.ts             Kiro stream-json → Archon provider events
src/failure.ts            Kiro error identity → failure class
src/agent-file.ts         ephemeral Kiro agents for restrictions and system prompts
src/process.ts            one kiro-cli process per turn, process-group cancellation
src/kiro-cli.ts           whoami, --list-models, --list-sessions, --version
src/structured-output.ts  best-effort JSON (adapted from Archon, MIT)
src/config.ts             assistants.kiro schemas (install / run / snapshot)
src/descriptor.ts         descriptor and capabilities
vendor/provider-contract  Archon's provider contract v0.14.0, vendored (not on npm yet)
.archon/workflows/        sample workflows
scripts/                  build, local install, fixture recording
e2e/                      real-Archon end-to-end driver
test/                     unit, conformance and live suites, fixtures, fake kiro-cli
```

## License

MIT. `vendor/provider-contract` and `src/structured-output.ts` derive from Archon
(MIT, Copyright (c) 2025-2026 Cole Medin).
