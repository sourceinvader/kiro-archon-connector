# Archon: field notes

What was learned about [Archon](https://github.com/coleam00/Archon) while building and
testing the Kiro provider plugin in this repository (November 2026). It covers the CLI,
workflows and nodes, the rules the engine enforces, the provider contract, the plugin
system, and how to build, install and test a provider connector. Companion to
[KIRO-LEARNINGS.md](KIRO-LEARNINGS.md).

Every claim carries a tag saying how we know it:

| Tag | Meaning |
|---|---|
| **[Tested]** | Reproduced in this session against a real Archon binary or the contract code |
| **[Seen]** | Observed in real output, but not deliberately tested |
| **[Docs]** | From Archon's documentation (`packages/docs-web`, v0.14.0) |
| **[Source]** | Read in Archon's source at tag v0.14.0 |
| **[Unverified]** | Inference or assumption |

---

## 1. Versions and what changed

| Version | Notes |
|---|---|
| 0.5.0 | What Homebrew had installed. No provider plugins. Ran bash-only workflows fine. **[Tested]** |
| 0.11.1 | The local `~/Desktop/Archon` checkout was here, 957 commits behind `dev`; it already had `provider-contract/src/plugin` and a community-provider template. Its plugin protocol number was not checked. **[Seen]** |
| 0.13.0 | `PROVIDER_PLUGIN_PROTOCOL = 2`. **[Source]** |
| 0.13.2 | Protocol **3**. Current Homebrew stable (`brew upgrade archon`). The Kiro plugin passes its full end-to-end suite here. **[Tested]** |
| 0.14.0 | Protocol 3. Latest release (commit `8def159a`, 2026-11-07). Between 0.13.2 and 0.14.0 the provider contract only changed `strict-output-schema` (Codex). Kiro plugin passes its full end-to-end suite here. **[Tested]** |

- In 0.13+ the maintained providers (Claude, Codex, Pi) are themselves **plugins**
  (`plugins/provider-claude` etc.). Release binaries ship without them; `archon provider add
  claude codex pi` installs them, and they must match the CLI version. **[Docs]**
- OpenCode and Copilot are still bundled but deprecated (no maintainer). **[Docs]**
- Release assets per platform: `archon-<os>-<arch>`, `archon-server-…`,
  `archon-provider-{claude,codex,pi}-…`, `archon-forge-github-…`, `archon-chat-slack-…`, and
  `checksums.txt` (`sha256sum` format). **[Seen]**
- License: MIT, Copyright (c) 2025-2026 Cole Medin. **[Seen]**

---

## 2. CLI essentials

- **Archon only runs inside a git repository** (or with `--cwd <repo>`). **[Tested]**
- Core commands: `archon workflow list | run <name> [msg] | status | runs | get <id> |
  cancel <id> | abandon <id> | resume`, `archon validate workflows [name]`, `archon doctor`,
  `archon plugin add|list|update|remove`, `archon provider add`, `archon setup`,
  `archon serve`, `archon chat`, `archon skill add`, `archon ai …`. **[Docs]** / **[Seen]**
- `workflow run` options used: `--no-worktree` (run in the live checkout), `--detach`
  (background child, returns a run id), `--branch`, `--json`. `workflow runs --json --limit
  20` lists runs; short run-id prefixes work from the project directory. **[Tested]**
- **`ARCHON_HOME`** relocates `~/.archon` (config, database, plugins, workspaces, logs).
  **It must be absolute**: with a relative one, a plugin node failed with "plugin command
  must be an absolute executable path". **[Tested]**
- `DO_NOT_TRACK=1` turns off the anonymous telemetry that is on by default. **[Docs]**
- Output: the CLI prints JSON log lines (pino: level 30 info, 40 warn, 50 error) mixed with
  human lines such as `[node] Started (kiro/minimax-m2.5)`, `[node] Completed (9.4s)`,
  `[node] Failed: …`, `Workflow completed successfully.` **[Seen]**
- **The stdout of intermediate bash nodes is not printed.** It is in the run transcript,
  `$ARCHON_HOME/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`, whose path the CLI prints
  as `[workflow] Transcript: …`. **[Tested]**
- A detached run's console output goes to `$ARCHON_HOME/logs/detached-run-cli-….log`.
  **[Seen]**
- `archon doctor` checks the provider binary, database, workspace, bundled defaults,
  telemetry, credentials, adapters, and each installed provider's own diagnostics
  (`✓ kiro: Kiro CLI …`). In 0.14 it also fails if a project has `.claude/skills` but not the
  bundled `archon-cli` skill ("Run `archon skill add .`"). Exit 1 on any failure. **[Seen]**

### Worktrees

- By default a run gets its own git worktree. **0.13+/0.14 refuses to create one without a
  git remote**: "Cannot determine git remote … Add one with `git remote add origin URL`,
  or use `--no-worktree`". A local bare repository as `origin` is enough. **[Tested]**
- The base branch comes from `origin/HEAD` or `origin/main`; otherwise set
  `worktree.baseBranch` in `.archon/config.yaml` (0.5.0 only warned). **[Tested]**
- A private GitHub `origin` works: the run branched `archon/task-<workflow>-<n>` from
  `origin/main`, ran in the worktree, and removed the worktree afterwards (the branch
  stays). **[Tested]** Being a git worktree of `origin/main`, it lacks unpushed commits and
  untracked files, for example a skill installed into `.claude/skills` but never committed;
  run such workflows with `--no-worktree`. **[Unverified]** for the skill case.
- A gitignored file reaches a worktree only through `worktree.copyFiles`. **[Docs]**
- A run with `--no-worktree` writes into your checkout; design sample workflows to clean
  up after themselves. **[Tested]**

---

## 3. Configuration

- Global `~/.archon/config.yaml`: `defaultAssistant`, `assistants.<provider>.{…}`, `tiers`
  (`large/medium/small` → provider/model/effort), `aliases`, `streaming`, `concurrency`,
  `botName`. **[Seen]**
- Project `.archon/config.yaml`: `assistant`, `worktree.baseBranch`,
  `worktree.copyFiles`, assistant overrides. **[Docs]** / **[Tested]**
- **Each `assistants.<provider>` block is validated by that provider's own schema** when
  config loads; a misspelled key or wrong type stops the load naming the file, provider and
  key. A `--config` run layer refuses install-only settings (such as a local binary path).
  **[Docs]**
- Default provider: explicit config, then `DEFAULT_AI_ASSISTANT`, then the only registered
  provider. With several providers and no default, a run needing one fails before creating
  a worktree. **[Docs]**

---

## 4. Workflows

### Shape

```yaml
name: kiro-feature-tour
description: |
  Use when: …   Does: …   NOT for: …      # convention used by bundled workflows
provider: kiro           # workflow default; a node can override
model: minimax-m2.5      # or kiro/minimax-m2.5
nodes:
  - id: classify
    prompt: "What is 6 times 7?"
    output_format: { type: object, properties: { answer: { type: number } }, required: [answer] }
  - id: check
    depends_on: [classify]
    bash: |
      answer=$classify.output.answer
      [ "$answer" = "42" ] || exit 1
```

Workflows live in `.archon/workflows/` (project), the Archon home (global), installed
workflow packs, or bundled defaults (20 in 0.5.0, 30 in 0.14.0). **[Seen]**

### Node kinds and keys

A node needs exactly one of `prompt`, `command`, `bash`, `script`, `loop`, `approval`,
`cancel` (validation error otherwise). **[Seen]** Keys used or read about:

| Key | Meaning |
|---|---|
| `depends_on` | Upstream ids. Nodes in one layer run concurrently. **[Docs]** |
| `trigger_rule` | `all_success` (default), `one_success`, `none_failed_min_one_success`, `all_done` (run when every dependency is terminal, even failed). **[Docs]**, `all_done` **[Tested]** |
| `when` | Condition, e.g. `"$classify.output.kind == 'bug'"`. **[Docs]** |
| `context` | `fresh` (new session), `shared` (continue the ambient prior session in a sequential layer; rejected in parallel layers), `{ resume: node-id }` (fork that node's exact session; never falls back to a fresh one). **[Docs]**; `shared` **[Tested]** (the Kiro plugin resumes with `--resume-id`). Presumably `shared` needs `sessionResume` and named resume needs `sessionFork` **[Unverified]** |
| `output_format` | JSON Schema; validated for every provider; best-effort providers are re-asked up to 3×; a node without schema-valid output **fails**. **[Docs]**; **[Tested]** |
| `allowed_tools` / `denied_tools` | Tool allow/deny lists in the provider's vocabulary; `[]` = no tools; deny applies after allow. Not Codex. **[Docs]** |
| `mcp` | Per-node MCP config file (section 6). **[Tested]** |
| `skills` | Exact per-node skill list (section 7). **[Tested]** |
| `systemPrompt` | Per-node system instructions (node only, no workflow default). **[Tested]** |
| `effort` | `minimal low medium high xhigh max ultra persistent`; providers clamp to a weaker supported rung first. **[Docs]** |
| `fallbackModel`, `betas`, `sandbox`, `maxBudgetUsd`, `settingSources`, `idle_timeout`, `agents`, `plugins`, `hooks`, `persist_session`, `always_run`, `mutates_checkout`, `loop`, `approval` | Provider- or engine-specific; providers that lack a capability get a warning or a pre-run refusal. **[Docs]** |

Retired fields: workflow-level `interactive:` (ignored with a warning),
`modelReasoningEffort:` (mapped to `effort:`), the old `steps:` format and `thinking:` (load
errors). **[Docs]**

### Variable substitution rules

- `$nodeId.output` is a node's text output; `$nodeId.output.field` reads a field of an
  `output_format` node. Hyphenated ids work (`$lens-a.output`). **[Docs]** / **[Tested]**
- **Values are injected already shell-quoted into `bash:` nodes.** Assign them unquoted:
  `out=$node.output`, then use `"$out"`. The validator warns on `"$node.output"` (double
  quoting gives the wrong value) and on a bare `$node.output` used directly in a command
  (word-splitting and globbing when a large output spills to a file). **[Tested]**
- Numeric and boolean fields are injected raw. **[Docs]**
- Field access is strict: every path segment must be declared in the producer's schema
  `properties`, or validation fails. **[Docs]**

### Validation

`archon validate workflows [name]` checks structure, substitutions, provider capability
support (warning or error before any spend), MCP files and skills. Results look like
`Results: 1 valid, 0 with errors, 1 with warnings`. **[Tested]**

---

## 5. The exactness rules

The core rule: **a workflow node gets exactly what it declares, and nothing ambient.**

- **Capabilities are promises.** A provider declares only what it enforces. The engine
  warns, or **fails the run before any spend**, when a node asks for something the provider
  lacks: a required `mcp:`, a non-empty `skills:` or `plugins:` list on a provider that
  cannot load them exactly. **[Docs]**
- **MCP**: the node gets the servers in its `mcp:` file and no user, project or plugin
  servers. Claude excludes ambient MCP even when a node has no `mcp:`; Codex turns off every
  other configured server and fails the node if an undeclared one is live. **[Docs]**
- **Skills**: a non-empty `skills:` list is an exact allowlist; **omission and `[]` both
  select none**; installed-but-unlisted skills must not be advertised to the node.
  **[Docs]**
- **Unrelated native configuration and guidance stay**: `CLAUDE.md`/`AGENTS.md`, agents,
  instructions. **[Docs]**
- **Tool restrictions** are a capability too (`toolRestrictions`); Codex does not support
  them. **[Docs]**
- **Failures are typed, never guessed from prose**: a provider classifies with structured
  signals, keeps the vendor text only as evidence, and the engine decides retries from the
  class alone. **[Docs]**
- **Cancellation never fakes completion**: a cancelled turn ends without `settled`.
  **[Docs]**
- **Secrets stay out of diagnostics**: plugin stderr and plugin-chosen log text are withheld
  by the host. **[Docs]**

---

## 6. Per-node MCP servers

- **Declaration**: `mcp: .archon/mcp/github.json` (required), or `mcp: { path: …,
  optional: true }`. **[Docs]**
- **Path resolution is done by the engine**: checkout first, then (home-scoped workflows
  only) the declaring YAML's directory; absolute paths are used as is. The provider receives
  an **absolute path string** in `nodeConfig.mcp`, even for a missing required file (so it
  can report it). **[Source]**
- **Optional** declarations run without the servers when the provider lacks MCP
  (`provider_unsupported`) or the file is missing (`config_missing`); the run records
  `mcp_unavailable` and warns. Once the file loads, its servers are required like any
  other. **[Docs]**
- **File format**: a map of server name → config, or `{ "mcpServers": { … } }` (not mixed
  with other keys). Types: stdio (default; `command`, `args`, `env`), `http` (`url`,
  `headers`), `sse` (`url`, `headers`). **[Docs]** The contract helper `mcpServerMap()`
  unwraps both shapes. **[Source]**
- **Env expansion**: `$VAR` / `${VAR}` (`[A-Z_][A-Z0-9_]*` only) in `env` and `headers`
  values; `command`, `args`, `url` untouched; undefined → empty string plus a warning.
  Done by the provider at execution time. **[Docs]** / **[Source]** (`packages/providers/src/mcp/config.ts`)
- **Connection failure**: every declared server is required; Claude and Codex wait for them
  and fail the node as `misconfigured` before any model call ("Required MCP server "github"
  could not connect (failed): …"). Copilot only warns. **[Docs]**
- Providers report each server with an **`mcp_server_status`** event (`connected`,
  `failed`, `needs_auth`, `pending`, `disabled`). **[Docs]**
- **Tool wiring**: Claude adds `mcp__<server>__*` to `allowed_tools`; `allowed_tools: []`
  plus `mcp:` makes an MCP-only node. **[Docs]**
- Claude-plugin servers can be restated as `plugin:<plugin>:<server>` for http/sse only.
  **[Docs]**

## 7. Per-node skills

- A skill is a folder with `SKILL.md` (`name`, `description` front matter, then
  instructions). Install with `npx skills add owner/repo` (into `.claude/skills`, or
  `~/.claude/skills` with `-g`), `playwright-cli install --skills`, or by hand. **[Docs]**
- **Shared skill roots** (Pi and Copilot): `<cwd>/.agents/skills`, `<cwd>/.claude/skills`,
  `~/.agents/skills`, `~/.claude/skills`, first match wins; names must be plain names (no
  paths). **[Source]** (`packages/paths/src/skills.ts`)
- A provider can declare its own **`skillDiscovery`** (`project` and `user` root lists,
  optional `userDirectory: {env, home}`); validation then resolves names against those
  roots. **[Docs]** The Kiro plugin declares `.kiro/skills`, `.agents/skills`,
  `.claude/skills`; `archon validate` then reported a missing skill as a **WARNING** listing
  exactly those six folders. **[Tested]** (The contract text says a skill that exists but is
  outside the roots is an error; a missing one was a warning.)
- **Per provider**: Claude uses the SDK's exact skill selector and keeps the `Skill` tool
  enabled under `allowed_tools`; Pi and Copilot consume the list through the shared roots;
  **Codex rejects a non-empty `skills:` list** (invoke `$skill-name` in the prompt instead,
  from `.agents/skills`); OpenCode does not implement it. **[Docs]**
- Skills and MCP compose: skills teach the process, MCP provides the capability. **[Docs]**

---

## 8. The provider contract (`@archon/provider-contract`)

Self-contained, Zod-only, **not published to npm**: vendor it (this repo copies
`packages/provider-contract` at v0.14.0 into `vendor/`). **[Docs]**

### `IAgentProvider`

```ts
getType(): string
getCapabilities(): ProviderCapabilities
sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<ProviderChunk>
checkCredential({ env, signal, assistantConfig?, execContext?, cwd?, settingSources?, model? }): Promise<CredentialStatus>
resolveCredentialModel?(…), diagnose?({ signal, assistantConfig }), listModels?({ signal })
```

`SendQueryOptions` carries `model`, `abortSignal`, `systemPrompt` (string or string[]),
`appendSystemPrompt`, `outputFormat: {type: 'json_schema', schema}`, `env`,
`protectedEnvKeys`, `userCredentialEnvKeys`, `maxBudgetUsd`, `fallbackModel`,
`forkSession`, `nativeTools`, `purpose: 'title-generation'`, `onAdmission`,
**`nodeConfig`** (the raw YAML node: `mcp`, `skills`, `allowed_tools`, `denied_tools`,
`effort`, `systemPrompt`, `output_format`, …), `assistantConfig` (merged
`assistants.<id>`), `execContext` (`host` | `container`). **The workflow path passes
`nodeConfig`; Archon's chat path does not** — a useful way to tell them apart. **[Source]**

### Capabilities

`backgroundWork` (`reported` | `none` | `unobserved`), `sessionResume`, `sessionFork`,
`mcp`, `hooks`, `skills`, `plugins`, `agents`, `toolRestrictions`, `knownToolNames`,
`renamedTools`, `structuredOutput` (`enforced` | `best-effort` | `false`),
`requiresAllPropertiesRequired`, `envInjection`, `costControl`, `costReporting`,
`tokenReporting`, `stopReasonReporting`, `turnCountReporting`, `resolvedModelReporting`,
`effortControl`, `fallbackModel`, `sandbox`, `settingSources`, `nativeTools`,
`containerExec`. `sessionFork` requires `sessionResume`. **[Source]**

### Stream events (`ProviderChunk`)

| Chunk | Rules |
|---|---|
| `agent_message_chunk` `{text, continuesPreviousBlock?}` | **A whole block, not a token delta.** Coalesce. |
| `agent_thought_chunk` `{text}` | Whole block of reasoning. |
| `tool_call` `{toolCallId, name, title?, rawInput?}` | Unique id per turn; the provider must invent one if its SDK has none. Displayed as `title` or else `name`. |
| `tool_call_update` `{toolCallId, status, output?, outputTruncated?, exitCode?}` | **Exactly one per call, terminal only** (`completed`, `failed`, `cancelled`), **before the next `result`**. Output capped at 16 384 code points (`truncateToolOutput`). |
| `warning` `{code, message}` | Namespaced code (`kiro.mcp_env_vars_missing`); readers branch on `code`. |
| `mcp_server_status` `{server, status, error?}` | One per configured server. |
| `compaction`, `subtask`, `hook`, `state_update`, `heartbeat` | `heartbeat` resets the idle watchdog without starting a new result phase. |
| `result` | See below. |
| `settled` | **Exactly once, last, after the result**, only when no observed work remains. Also after a failed result. **Never after cancellation.** |

`result` fields: `sessionId` (required on every non-failing turn when `sessionResume`),
`text`, `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`, `cost`),
`tokensUnknown`, `structuredOutput`, **`failure: {class, evidence, retryAfterMs?,
resetAt?}`**, `isError` (still required alongside `failure`), `errorSubtype`, `errors`,
`cost` (USD), `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`,
`cancelled`; omit a native reason with no ACP name), `numTurns`, `resolvedModel`,
`resumed` (only when a resume was requested), `sessionNotFound` (only on a failed resume
proven missing by a structured check, with no model work done; the engine may then retry
once on a fresh session). **[Source]**

### Failure classes and retries

| Class | Meaning | Engine behaviour |
|---|---|---|
| `auth` | Credentials missing, rejected or expired | Never retried |
| `quota_exhausted` | Usage window used up (`resetAt`) | Never retried |
| `budget_exceeded` | Run spend limit hit | Never retried |
| `misconfigured` | Operator must change setup: bad proxy, missing CLI, unknown model, bad config | Never retried ("retrying will not help") |
| `rate_limited` | Vendor throttling | Retried with patient backoff; may pause until `resetAt` |
| `overloaded` | Capacity exhausted | Capped exponential backoff |
| `transient` | Network or process failure | Retried |
| `unknown` | Failed for an unknown reason | Retried only with `on_error: all` |

**[Source]**; `misconfigured` → no retry and the "configuration must be fixed" message
**[Tested]** on a real run.

### Credential status

`usable`, `not_connected`, `unusable` (with evidence), `check_failed` (with evidence),
`not_checked` — each with `source: archon | native`. During run preflight `not_connected`
and `unusable` block the run and `check_failed` warns. Never echo a credential. **[Source]**

### Configuration schemas

A descriptor's `configSchema` (fallback) and optional `config: {install, run, snapshot,
stripUnknownKeys?}` JSON Schemas, generated from Zod with
`z.toJSONSchema(schema, {io: 'input'})`. Helpers: `normalizedConfigString(z.string(),
'trim' | 'slash-separated')` (adds the `x-archon-normalize` annotation),
`snapshotConfigSchema(portable, local)` (local fields `writeOnly`, dropped from
snapshots). `additionalProperties: false` rejects unknown keys. **[Source]**

### Model references

`provider/model` routes to that provider (`kiro/minimax-m2.5`). At most one provider may
set `ownsUnprefixedModelRefs` and receive bare `vendor/model` refs (Pi does). **[Source]**

### Conformance suite (`@archon/provider-contract/conformance`)

`runProviderConformance({capabilities, turns, failureCases, toolTurn?, forkTurn?,
backgroundCases?})` checks **[Source]**:

1. every chunk parses;
2. every `tool_call` has a unique id and exactly one `tool_call_update` before the next
   `result`; no update without a start;
3. every failure case yields exactly one result with a parsable `failure` of the expected
   class whose `evidence` keeps the given vendor text, and `isError: true`;
4. every turn, failed ones included, ends with exactly one `settled`, last, after a current
   result;
5. every result of a non-failing turn names its `sessionId` (when `sessionResume`);
6. the `toolTurn` has at least two tool calls and one closed as `cancelled`;
7. `forkTurn` results report `resumed: true` and a new session id (when `sessionFork`);
8. `reported` background work: subtasks closed only as the runtime reports.

`checkCredentialStatuses` checks state and that the planted secret never appears in the
status. Proven to bite: removing tool updates, misclassifying a failure, or dropping
`settled` each produced violations. **[Tested]**

---

## 9. Plugins

### Manifest (`archon-plugin.json`)

Strict schema, no extra keys. Kinds: `workflow-pack` (`entrypoints`), `forge`,
`provider`, `chat` (all three with `executable`). Optional `compatibility.archon` semver
range, checked at install. **[Docs]**

```json
{ "schemaVersion": 1, "kind": "provider", "name": "provider-kiro",
  "description": "…", "executable": "archon-provider-kiro",
  "compatibility": { "archon": ">=0.13.2" } }
```

### Publishing and installing

- **GitHub is the registry.** `archon plugin add owner/repo[/path][@tag]`; without a tag,
  binary plugins use the latest release. Add the `archon-plugin` topic to be listed on
  archon.diy. **[Docs]**
- **Private repositories cannot be installed with `plugin add`.** Resolution runs
  `git ls-remote` (your git credentials apply, so that step succeeds) but then fetches
  `archon-plugin.json` from `raw.githubusercontent.com` unauthenticated, which 404s:
  "No archon-plugin.json for owner/repo at commit … returned 404". The source says so in
  `packages/cli/src/commands/plugin.ts`. A private plugin has to be built from a clone and
  installed locally (this repo's `bun run install:local`). **[Tested]** on 0.14.0 /
  **[Source]**
- **What `plugin add owner/repo` fetches, in order** (seen against a local stand-in for
  github.com): `<repo>.git/info/refs` and `<repo>.git/HEAD` (`git ls-remote`, so git must be
  installed), `raw/<owner>/<repo>/<commit>/archon-plugin.json`, `<owner>/<repo>/releases/latest`
  (only the redirect's `Location` is read, for the tag), then
  `releases/download/<tag>/<executable>-<os>-<arch>` and `releases/download/<tag>/checksums.txt`.
  It prints "Installed owner/repo from github.com/owner/repo vX (commit …)", the file's
  path and sha256, and "This runs code published by owner". `@tag`, `update` and `remove`
  behaved as documented. The URLs are only overridable in Archon's own tests
  (`PluginEnvironment.githubUrl`/`rawUrl`), so testing before a real release means calling
  `pluginCommand` from Archon's source. **[Tested]** on 0.14.0 source
- Release assets: `<executable>-<os>-<arch>` (`.exe` on Windows; `linux|darwin|windows` ×
  `x64|arm64`) plus `checksums.txt`. **[Docs]** Bun cross-compiles all five targets with
  `bun build --compile --target=bun-<os>-<arch>`. **[Tested]**
- **Install**: verify checksum → stage the executable → start it and run the `initialize`
  handshake → validate the descriptor (id must equal the executable suffix, maintained ids
  `claude|codex|pi` are reserved, no id collision, supported capabilities) → write
  `$ARCHON_HOME/plugins/<executable>` and
  `$ARCHON_HOME/plugins/installed/<owner>/<repo>[/<path>]/receipt.json`. **[Source]**
- **Receipt** (provider): `{schemaVersion: 1, id, manifest, tag, commit (40 hex),
  installedAt, files: [{path, sha256}], descriptor}`. **[Source]**
- The host registers receipts without starting executables, then **checks the live
  descriptor against the receipt on every session**. Restart `archon serve` after
  install/update/remove; a new CLI process sees changes at once. **[Docs]**
- The installer only fetches from GitHub (its `githubUrl`/`rawUrl` overrides are test-only).
  For local testing, mirror its steps and write the receipt yourself; Archon's own
  `archon plugin list`, `doctor` and runs then validate it. **[Tested]**
- Older Archon binaries reject unknown receipt kinds; remove plugins before downgrading.
  **[Docs]**

### Provider plugin wire protocol (protocol 3)

- **Newline-delimited JSON-RPC 2.0 on stdin/stdout. Stdout is RPC only** (route
  `console.log` to stderr). Stderr is withheld by the host. **[Docs]**
- ACP v1 lifecycle: `initialize` (host sends
  `clientCapabilities._meta.archon.protocol`; plugin answers with its descriptor in
  `agentCapabilities._meta.archon`; a protocol mismatch still returns the descriptor but
  serves nothing), `session/new` (`_meta.archon.request` carries the whole request:
  prompt, cwd, resume id, options, node config), `session/prompt`, `session/cancel`.
  **[Source]**
- Archon extensions: `_archon/chunk` (notifications carrying `ProviderChunk`s),
  `_archon/tool_call` (plugin → host, for native tools), `_archon/log` (metadata only;
  the host forwards just `bindings.failureClass` and `bindings.lifecycle`
  (`process_still_exiting`, `process_abnormal_exit`) plus `waitedMs`),
  `_archon/check_credential`, `_archon/resolve_credential_model`, `_archon/diagnose`,
  `_archon/list_models` (answer `-32601` when unsupported). **[Source]**
- `serveProvider({descriptor, create: log => provider})` implements all of it;
  `connectProvider({readable, writable})` is the client side, handy for tests. **[Source]**
- **For host runs, `serveProvider` replaces the request's `env` with the plugin process's
  own environment**; container runs keep the request env. **[Source]**
- Descriptor: `protocol`, `id` (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), `displayName`, `version`,
  `capabilities`, `credentials: {kind: 'static', specs}` (empty = native auth),
  `configSchema`, `config`, `ownsUnprefixedModelRefs`, `skillDiscovery`. Dynamic credential
  catalogs and mid-run permission requests are unsupported. **[Source]**
- The JSON Schema for all wire types is published as
  `packages/provider-contract/schema/provider-contract.schema.json` for non-TypeScript
  plugins. **[Docs]**

### Chat surface and native tools

Archon's chat orchestrator (`archon chat`, web UI, Slack) gives providers with
`nativeTools` three typed tools: **`invoke_workflow`**, **`register_project`**, and in
project chats **`manage_run`**. Without `nativeTools`, chat switches to a `cli` mode where
the model runs `archon …` commands itself. Plugin native tools run in the host through
`_archon/tool_call`. **[Source]**

---

## 10. How existing providers solve common problems

- **Best-effort structured output** (Copilot; reused by Kiro): append "respond with ONLY a
  JSON object matching this schema" plus the schema to the prompt, then parse in tiers
  (trim and strip fences; parse from the first `{`; `jsonrepair` gated on a `:`), objects
  only. **[Source]** (`packages/providers/src/shared/structured-output.ts`)
- **Stale resume** (Claude): its SDK cannot tell "session missing" from a crash, so it marks
  `sessionNotFound` only after a host lookup finds no transcript, with failure class
  `unknown`. **[Source]**
- **Effort**: `clampEffort(value, supported)` clamps to a weaker rung first.
  **[Source]**
- **Claude MCP**: loads the file with `loadMcpConfig`, sets SDK `mcpServers`, adds
  `mcp__name__*` wildcards, warns on missing env vars and on Haiku (no tool search).
  **[Source]**

---

## 11. Building a provider connector: the recipe that worked

1. **Probe the agent CLI first**: record its real event stream for text, tools, parallel
   tools, an interruption, every error you can trigger, resume, structured output. Keep
   the recordings as fixtures (paths replaced by placeholders).
2. **Pick the most structured interface** (here, Kiro's `stream-json` ACP events), and
   classify failures only from structured fields and documented exit codes.
3. **Map to the contract strictly**: coalesce deltas into blocks, give every tool call one
   terminal update (synthesize starts, close leftovers as `failed` or `cancelled`), one
   result, then `settled`; no `settled` on cancellation.
4. **Declare only enforced capabilities**, each backed by a test.
5. **Vendor the contract**, serve with `serveProvider`, keep stdout clean.
6. **Test in layers**:
   - unit tests on the mapper with the recorded fixtures;
   - a **fake CLI** that replays fixtures through the real process, stdin and exit-code
     paths (plus a hang scenario with a real grandchild process for cancellation);
   - `runProviderConformance` **in process, over stdio from source, and against the
     compiled binary** (rebuilt every run; a stale binary once hid a change);
   - a **mutation check** to prove the conformance suite fails when it should;
   - **live tests** against the real CLI, with a non-isolated **control** for every
     isolation claim so a test cannot pass vacuously;
   - **end to end** on official Archon release binaries in an isolated, absolute
     `ARCHON_HOME`, with a throwaway git project that has a local bare `origin` (for
     worktrees), reading bash-node results from the run transcript.
7. **Ship sample workflows** that check themselves with bash nodes and clean up after
   themselves.

---

## 12. Writing workflows that test a provider

- Pair each AI node with a `bash` check node that prints `FEATURE-PASS` or exits 1 with
  `FEATURE-FAIL`; read the markers from the transcript.
- Use `context: fresh` between independent steps and `context: shared` to prove resume.
- Use `output_format` plus a field check for structured output.
- Prove restrictions by checking a side effect that must not happen (a file that must not
  exist), with `allowed_tools: [read]` or `[]`.
- For exactness, give the "must not have it" node `allowed_tools: []` so it cannot read
  the file instead.
- End with a `trigger_rule: all_done` cleanup node.
- For cancellation, start with `--detach`, find the run id with `workflow runs --json`,
  `workflow cancel <id>`, and check the process that was seen running before is gone.
- Pin a cheap model in every test workflow.

## 13. Open questions

- Why `archon validate` reported a missing skill as a warning rather than an error for a
  provider that declares `skillDiscovery`.
- `persist_session`, loops, approvals, interactive waits and `workflow:` sub-runs were not
  exercised with the Kiro provider.
- `archon serve` (web UI, server process) with the plugin was not tested; only the CLI.
- Linux and Windows hosts were not tested.
