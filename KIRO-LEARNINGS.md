# Kiro CLI: field notes

What was learned about Kiro CLI while building the Archon connector in this repository
(November 2026, `kiro-cli 2.37.1`, macOS arm64, Builder ID login). It covers headless
mode, the stream-json event format, custom agents, tools and permissions, MCP, skills,
steering, sessions, errors, processes, and the tricks the connector relies on.

Every claim carries a tag saying how we know it:

| Tag | Meaning |
|---|---|
| **[Tested]** | Reproduced in this session with a real `kiro-cli` run and a check of the outcome |
| **[Seen]** | Observed in real output, but not deliberately tested |
| **[Docs]** | From kiro.dev documentation, not independently checked |
| **[Source]** | Read from the strings of Kiro's bundled agent server (`@kiro/agent`) |
| **[Unverified]** | Inference or assumption; treat as a hypothesis |

Kiro changes quickly: the documentation already describes CLI 3.x behaviour that 2.37.1
does not show (see [Tool trust](#tool-trust-does-not-restrict-tools)). Re-test before
relying on anything here with a different version.

---

## 1. Installation and moving parts

- `kiro-cli` on PATH is `~/.local/bin/kiro-cli`, a symlink into
  `/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli` (a universal Mach-O binary). The
  same folder holds `kiro-cli-chat`, `kiro-cli-term` and `kiro_cli_desktop`.
  `~/.local/bin` also gets `bash`, `fish`, `nu`, `zsh` copies of `kiro-cli-term` for shell
  integration. **[Seen]**
- A chat run starts a process tree: `kiro-cli` → `kiro-cli-chat chat` → a bundled `bun`
  running `tui.js` → a bundled `node` running the **Kiro Agent Server (KAS)**,
  `~/Library/Application Support/kiro-cli/kas/<version-hash>/node_modules/@kiro/agent/dist/server/acp-server.js --transport=stdio --auth=acp-callback`.
  KAS was version 0.66.70. **[Seen]**
- KAS is where the agent logic lives: tools, MCP, skills, permissions, agent loading. Its
  bundled JavaScript (under `.../@kiro/agent/dist`) is readable with `grep`, and that is how
  several facts below were found. **[Seen]**
- Login data: `~/Library/Application Support/kiro-cli/data.sqlite3`. Settings:
  `~/.kiro/settings/cli.json`. `~/.kiro` also holds `argv.json`, `extensions`, `logs`,
  `powers`, `session-index`, `sessions`, `settings`, `workspace-roots`. **[Seen]**
- Logs go to `$TMPDIR/kiro-log/kiro-chat.log` on macOS; `KIRO_LOG_LEVEL` sets verbosity.
  **[Docs]**
- Every chat run writes `[INFO] kas.server.starting …`, `[INFO] [KiroAgent] MCP subsystem
  initialized` and an `[ERROR] (node:…) ExperimentalWarning: SQLite is an experimental
  feature` line to **stderr**. They are noise, not errors. Never parse or surface stderr:
  it can carry account details. **[Seen]**

### Environment variables found in the binary

Found by `strings` on `kiro-cli-chat` **[Source]**; only the first is documented and
tested. Semantics of the rest are guesses from their names. **[Unverified]**

`KIRO_API_KEY` (headless API key **[Docs]**), `KIRO_HOME` (presumably relocates `~/.kiro`),
`KIRO_DATA_DIR`, `KIRO_RUNTIME_DIR`, `KIRO_LOG_LEVEL`, `KIRO_LOG_NO_COLOR`,
`KIRO_SESSION_ID`, `KIRO_MODE`, `KIRO_MOCK_CHAT_RESPONSE` (possibly useful for offline
tests), `KIRO_KAS_NODE_PATH`, `KIRO_KAS_SERVER_PATH`, `KIRO_CLI_ACP_CLI`,
`KIRO_ENABLED_FEATURES`, `KIRO_FEATURE_BACKGROUND_EXECUTION_ENABLED`,
`KIRO_FEATURE_CLOUD_CONFIG_ENABLED`, `KIRO_SUBAGENT_STALL_TIMEOUT_MS`,
`KIRO_TRUST_CLASSIFIER_MODE`, `KIRO_TRUST_CLASSIFIER_SHADOW`, `KIRO_AUTH_PORTAL_URL`,
`KIRO_BUNDLED_FEED_FILE`, `KIRO_INFRA_SAFETY_ROLLOUT_ENABLED`, `KIRO_NO_REMOTE_CHANGELOG`,
`KIRO_ROUTER_VERBOSE`, `KIRO_ROUTER_VERSION`, `KIRO_TERMINAL_THEME`,
`KIRO_TUI_TELEMETRY_KEY_FILE`. Documented but not in that list:
`KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS` (default 21600). **[Docs]**

---

## 2. Small commands that never start a model session

| Command | Output | Notes |
|---|---|---|
| `kiro-cli --version` | `kiro-cli 2.37.1` | **[Tested]** |
| `kiro-cli whoami --format json` | `{"accountType":"BuilderId","email":…,"region":"us-east-1","startUrl":…}` | Signed out: `{"account":null}` with **exit 0**. Takes about 1.3 s. Also `plain` and `json-pretty` formats. **[Tested]** |
| `kiro-cli chat --list-models --format json` | `{"models":[{"model_name","description","model_id","context_window_tokens","rate_multiplier","rate_unit":"Credit"}],"default_model":"auto"}` | **[Tested]** |
| `kiro-cli chat --list-sessions --format json` | `[{"cwd","sessions":[{"sessionId","source":"v3","title","updatedAt","executionTarget":"local","status":"idle"}],"complete":true}]` | Scoped to the **current directory**. `--all-cwds` returned `[]` in our test. **[Tested]** |
| `kiro-cli agent list` | Workspace and global agent folders plus built-ins `kiro_default` (default), `kiro_help`, `kiro_planner` | Also `agent create`, `edit`, `validate --path`, `migrate`, `upgrade`, `set-default`. **[Seen]** |
| `kiro-cli --help-all` | Every subcommand: `debug settings setup update diagnostic init theme issue login logout whoami profile user doctor launch quit restart integrations translate dashboard chat crew mcp powers inline agent acp` | **[Seen]** |

Models offered to the test account, with credit multipliers **[Tested]**: `auto` 1.0,
`claude-sonnet-4.5` 1.3, `glm-5` 0.5, `claude-haiku-4.5` 0.4, `deepseek-3.2` 0.25,
`minimax-m2.5` 0.25, `minimax-m2.1` 0.15 (experimental), `qwen3-coder-next` 0.05
(experimental). `minimax-m2.5` was the cheap, stable model used for every test.

---

## 3. Headless mode

```sh
kiro-cli chat --v3 --no-interactive --output-format stream-json \
  --model minimax-m2.5 --trust-all-tools < prompt.txt
```

- The instruction can be a positional argument or **piped on stdin**; stdin is read only
  when there is no positional argument. Multi-line stdin prompts work. **[Tested]** Prefer
  stdin: no argv length limit, and the prompt never shows in `ps`.
- `--output-format stream-json` prints "the run's ACP events as JSON Lines" and implies
  `--no-interactive`. Passing `--no-interactive` as well is harmless. **[Tested]**
- Every run we made reported `"engine":"v3"`, even without `--v3`, although the docs say a
  local headless run defaults to V2. Pass `--v3` explicitly. **[Seen]** **[Docs]**
- The docs say headless mode needs `KIRO_API_KEY` (Pro tiers only). In practice a normal
  Builder ID login works locally. **[Tested]**
- Useful flags: `--model`, `--agent <name>`, `--effort low|medium|high|xhigh|max`,
  `--resume-id <session>`, `--trust-all-tools`, `--trust-tools`, `--require-mcp-startup`,
  `--sandbox`, `--mode default|spec`, `--cloud`/`--repo`, `--wrap`, `--delete-session`,
  `--list-sessions`, `--list-models`. **[Docs]** / **[Seen]** in `--help`
- An unsupported effort is a warning, not an error: stderr
  `[warn] failed to set effort 'low': model 'minimax-m2.5' offers no effort levels`, and the
  run continues. **[Tested]**
- Kiro waits for its own background "workflows" before exiting, up to
  `KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS`. **[Docs]**

### Signed out = surprise browser login

**A signed-out headless `kiro-cli chat` does not fail. It opens a browser and starts an
interactive login** ("Opening browser… Logging in… Logged in successfully"). **[Tested]**
(accidentally, with a throwaway `HOME`). Anything that runs Kiro unattended must check
`kiro-cli whoami --format json` first and stop on `{"account":null}`.

A throwaway `HOME` is not a good way to simulate "signed out": `kiro-cli-chat` then fails to
launch, because it is found through `~/.local/bin`. **[Tested]**

---

## 4. The stream-json format

### Envelope (one JSON object per line)

```jsonc
{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v3"}}
{"type":"sessionUpdate","data":{"sessionId":"sess_…","update":{"sessionUpdate":"…", …}}}
{"type":"runFinished","data":{"sessionId":"sess_…","status":"success","stopReason":"end_turn","finalText":"…","finalTextTruncated":false}}
{"type":"runError","data":{"sessionId":"sess_…"|null,"stage":"init"|"prompt"|"interrupted","message":"…"}}
```
**[Tested]**

- `finalText` starts with several blank lines (`"\n\n\n\nDONE"`). Trim blank lines before
  using it. **[Seen]**
- A run ends with exactly one of `runFinished` or `runError`. **[Seen]**

### `sessionUpdate` kinds

| `update.sessionUpdate` | Content | Notes |
|---|---|---|
| `agent_message_chunk` | `content: {type:"text", text}` | **Token deltas**, not whole blocks. `_meta.kiro` has `executionId`, `turnId`, `replayId` (one `replayId` per reply message). **[Tested]** |
| `agent_thought_chunk` | `content: {type:"text", text}` | Reasoning. `minimax-m2.5` emits it. **[Seen]** |
| `tool_call` | `toolCallId`, `title`, `kind` (`read`, `execute`, `edit`, …), `locations`, `rawInput`, sometimes `status`, `_meta.kiro.toolOrigin` (`default` or `acp`), `serverName`, `toolId` | **[Tested]** |
| `tool_call_update` | `status` (`pending`, `in_progress`, `completed`, `failed`), `content: [{type:"content", content:{type:"text", text}}]`, `rawOutput: {output, exitCode, message}` | Several `in_progress` updates per call. **[Tested]** |
| `available_commands_update` | Slash commands: custom agents (`general-task-execution`, `context-gatherer`, the active agent) and **skills**, typed by `_meta.kiro.type` (`custom-agent`, `skill`) | Huge; contains long descriptions. **[Seen]** |
| `config_option_update` | Modes: `vibe` (Default), `spec`, `quick-spec`, `bug-fix`, … | **[Seen]** |
| `session_info_update` | Typed by `_meta.kiro.kind` (next table) | **[Seen]** |

`session_info_update` kinds **[Seen]**:

| `_meta.kiro.kind` | Fields |
|---|---|
| `context_usage` | `usagePercentage`, `summarizationThreshold`, `breakdown` (tools, prompts, files, memory, …) |
| `user_message_id_assigned` | `userMessageId` |
| `focus_update` | `title`, `status` (`in_progress`, `idle`, `failed`), `activity: {turnActive, runningWorkflows, pausedWorkflows}` |
| `turn_start` | `executionId`, `turnId`, `timestamp`, `boundarySource` |
| `turn_completion` | `promptTurnSummaries: [{unit:"credit", usage, usedTools}]`, `elapsedTime`, `status` (`success`/`failed`), `requestIds` |
| `turn_end` | `turnEnd: {stopReason}` (`end_turn`, `error`, …) |
| `display_error` | `displayError: {message, errorType, retryErrorType}` |

### Things a stream consumer must handle

- **Coalesce deltas** into whole blocks; flush at a tool call, at a switch between reply
  and reasoning, at a new `replayId`, and at the end. **[Tested]**
- **Parallel tool calls overlap**: a second `tool_call` can start before the first
  completes. **[Tested]**
- **A `tool_call_update` can arrive with no `tool_call` before it.** Kiro's deferred-tool
  loader (used before the first MCP call) does this. Synthesize a start. **[Tested]**
- **A tool call can be left open forever**: with one model, a call to a tool the agent did
  not have (`run_shell_command`) stayed `in_progress` with no closing update. With
  `minimax-m2.5`, the same situation closed as `failed` with output
  `Tool "bash" is not available.` Close leftovers yourself at the end of the turn.
  **[Tested]**
- Tool names: `kind` is the stable programmatic label; `title` is human text ("Read File",
  "Write \"probe\" to out.txt", "@secret/get_secret"). `usedTools` in turn summaries uses
  internal names (`read_file`, `execute_bash`). Tool call ids look like `tooluse_…` or
  `run_command_tooluse_…`. **[Seen]**
- **No token counts anywhere.** Usage is in credits (`turn_completion` → `usage`), and
  `context_usage` gives only percentages. **[Seen]**

---

## 5. Errors and exit codes

| Situation | What Kiro emits | Exit |
|---|---|---|
| Unknown model | `display_error` with `errorType: "InvalidModelError"`, `retryErrorType: "CLIENT_ERROR"`; `runError` stage `prompt`, message `… (code -32000): {"errorType":"InvalidModelError","retryErrorType":"CLIENT_ERROR","requestId":"…"}` | 1 **[Tested]** |
| `--resume-id` for a missing session | `runError` stage `init`, `sessionId: null`, `Session '…' not found`; stderr `error: ACP load_session failed` | 1 **[Tested]** |
| `--agent` name not found | `runError` stage `init`, `agent "…" not found, stopping (exit 4)` | 4 **[Tested]** |
| MCP server fails to start with `--require-mcp-startup` | `display_error` `errorType: "mcp_connection_error"` (`MCP server "secret" failed to connect: Connection closed`); `runError` stage `init`, `these servers failed to start: secret: Connection closed (--require-mcp-startup enabled)` | 3 **[Tested]** |
| SIGTERM to the process group | `runError` stage `interrupted`, `the run was ended by a signal` | killed by signal **[Tested]** |
| Success | `runFinished` status `success` | 0 **[Tested]** |

- The JSON after `(code -32000):` in a run error is a serialized structured payload. Parse
  it as JSON instead of matching the prose. **[Tested]**
- `errorType` values found in KAS **[Source]**: `AccessDeniedException`,
  `ThrottlingException`, `ServiceQuotaExceededException`, `ServiceUnavailableException`,
  `ExpiredTokenException`, `UnauthorizedException`, `UnauthorizedClientException`,
  `AuthorizationPendingException`, `ForbiddenException`, `SpaceLimitExceededException`,
  `ProviderConnectionExpiredException`, `LimitExceededException`, `TokenProviderError`,
  `InvalidAccessError`, `InsufficientCapabilitiesException`, `UsageLimitReachedError`,
  `ContextWindowExceededError`, `ConcurrentResourcesLimitExceededException`,
  `UnauthorizedError`, `QuotaExceededError`, `OverageLimitReachedError`,
  `ModelThrottleError`, `ServiceThrottleError`, `ClientThrottleError`, `ThrottledException`,
  `RequestThrottledException`, `InvalidModelError`, `InsufficientModelCapacityError`,
  `ContextOverflowError`, `TokenExpiredError`, `TokenInvalidError`,
  `InvalidIdentityTokenException`, `OAuthError`, `NewUserAccessPausedError`,
  `ModelRegistryUnauthenticatedError`, `ModelRegistryAccessDeniedError`,
  `ModelRefreshTimeoutError`, `ProxyAuthenticationRequiredError`,
  `ModelRoutingConfigParseError`, `ConnectionResetError`, `MalformedResponse`,
  `ErrorResponse`, `AbortedError`, plus `mcp_connection_error` **[Tested]**.
- `retryErrorType` values **[Source]**: `CLIENT_ERROR`, `TRANSIENT`, `SERVER_ERROR`,
  `THROTTLING`, `HOURLY_REQUEST_COUNT`, `DAILY_REQUEST_COUNT`, `WEEKLY_REQUEST_COUNT`, and
  network codes (`ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, `ECONNABORTED`, `ENETUNREACH`,
  `EHOSTUNREACH`, `EAI_AGAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
- Only `InvalidModelError` and `mcp_connection_error` were actually triggered. Throttling,
  quota, auth-denial and capacity errors are assumed to arrive in the same shape. **[Unverified]**

---

## 6. Processes and cancellation

- **Kiro ignores SIGINT when it has no terminal.** A SIGINT to `kiro-cli` let a 30-second
  `sleep` finish. **[Tested]**
- **SIGTERM to the whole process group works**: spawn with `detached: true`, then
  `process.kill(-pid, 'SIGTERM')`. Kiro writes the `interrupted` run error and exits within
  about 1.5 s, and tool children such as `sleep` die too. Follow with SIGKILL after a grace
  period. **[Tested]**
- Watching a tool's process: Kiro runs shell commands through a shell, and a single command
  is exec'd, so `sleep 240 # marker` shows up as `sleep 240` and the comment is invisible to
  `pgrep -f`. Use a command whose own argv is distinctive (`sleep 237 && echo done`) and
  match `pgrep -f "sleep 237"`. **[Tested]**

---

## 7. Sessions and resume

- Session ids look like `sess_<uuid>`. Sessions are stored per working directory
  (`~/.kiro/sessions`). **[Seen]**
- `--resume-id <id>` restores the conversation and keeps the same session id in
  `runFinished`. The model recalled a code word from the previous turn. **[Tested]**
- Resume also works when the next turn runs on a **different agent** (`--agent`). The
  conversation carries over while the new agent's tools and skills apply: a turn on an
  ephemeral agent with a skill, then a resumed turn on another ephemeral agent restricted
  to `read`, recalled the code word. This was tested through Archon
  (`kiro-session-probe`, check 2). **[Tested]**
- There is **no fork**: nothing copies a session under a new id while leaving the
  original untouched. `--resume-id` continues the same session. **[Seen]** in `--help`.
- To tell "session gone" from other init failures without reading prose, check
  `chat --list-sessions --format json` in the same cwd: a `complete: true` list without the
  id means it no longer exists. **[Tested]**

---

## 8. Tool trust does not restrict tools

- `--trust-all-tools` approves everything. Headless Kiro cannot ask for approval, so without
  it a tool that needs approval is denied. **[Docs]** In practice, without
  `--trust-all-tools`, both `read_file` and the shell tool ran inside the workspace, so
  Kiro's default permissions already allowed them there. **[Tested]** What is denied
  without the flag (outside the workspace, hooks, sub-agents) was not explored.
- **In 2.37.1, `--trust-tools` does not limit which tools run.** With `--trust-tools=`
  (empty), `read_file` still ran. With `--trust-tools=read_file`, the shell tool still ran
  and created a file. **[Tested]** The docs describe richer `--trust-tools` matching in CLI
  3.3.0+; it is not a restriction mechanism here.
- The way to restrict tools is the **agent's `tools` list**: tools not in it do not exist
  for the session (see section 9). **[Tested]**
- Denying `shell` alone does not stop file writes: with `excludedTools: ["shell"]` the model
  used the Write File tool instead. Deny `write` too, or allow only `read`. **[Tested]**

### Tool vocabulary

- Tags usable in `tools` and `excludedTools`: `read`, `write`, `shell`, `web`, `subagent`,
  `@builtin`, `@mcp`, `@<server>`, `@<server>/<tool>`, `*`. **[Docs]** `read`, `shell`,
  `@builtin`, `@<server>` and `*` were **[Tested]**.
- Internal tool names found in KAS **[Source]**: `read_file`, `list_directory`,
  `file_search`, `grep_search`, `fs_write`, `str_replace`, `execute_bash`, `execute_pwsh`,
  `get_process_output`, `control_process`, `web_fetch`, `web_search`, `remote_web_search`,
  `invoke_sub_agent`, `delegate`, `disclose_context`, `kiro_powers`, `knowledge`,
  `introspect`, `code`, `run_workflow`, `send_message`, `subagent_response`,
  `report_progress`, `tool_load`, `load_resource`, `tool_call`, `create_hook`,
  `create_diagram`, `analyze_requirements`, `get_learnings`, `create_feedback_learning`.
- Tool → **capability** mapping found in KAS **[Source]**: `execute_bash` and
  `control_process` → `shell`; `web_fetch` → `web_fetch`; `web_search` and
  `remote_web_search` → `web_search`; `invoke_sub_agent` and `delegate` → `subagent`;
  **`disclose_context` → `skill`**; learnings and steering helpers → `context`.
- Capability names in KAS **[Source]**: `fs_read`, `fs_write`, `shell`, `web_fetch`,
  `web_search`, `mcp`, `subagent`, `skill`, `power`, `context`, `diagnostics`, `workflow`,
  `sandbox_network`.

---

## 9. Custom agents

- **Locations**: workspace `.kiro/agents/`, global `~/.kiro/agents/`. JSON, or Markdown
  with YAML front matter whose body is the prompt. **[Docs]** JSON **[Tested]**.
- **`--agent` takes a name, never a path.** `--agent /abs/path/agent.json` fails with exit 4
  (`agent "…" not found`). **[Tested]**
- Creating `~/.kiro/agents` made Kiro add an `agent_config.json.example` file. **[Seen]**
- A V3 custom agent still loads `AGENTS.md` and `inclusion: always` steering. **[Tested]**
- An agent's `prompt` takes effect (a "end every reply with PINEAPPLE-7" prompt was
  obeyed). **[Tested]** Whether it adds to or replaces Kiro's own base prompt is
  **[Unverified]** (it behaves as an addition).
- Custom agents show up in `available_commands_update` as `custom-agent`. **[Seen]**

### Fields

| Field | Meaning | Status |
|---|---|---|
| `name`, `description` | Identity; `name` defaults to the file name | **[Docs]** |
| `prompt` | Inline text or `file://` (relative to the agent file) | inline **[Tested]**, `file://` **[Docs]** |
| `model`, `effortLevel` | Defaults for the agent | **[Docs]** / **[Source]** |
| `tools` | Everything the agent can see and call. String `"*"` or a list | **[Tested]** |
| `excludedTools` | Removed even when `tools` allows them | **[Tested]** |
| `permissions` | `{rules: [{capability, match, effect: allow\|ask\|deny, exclude}]}`; a deny anywhere beats allows | `capability` + `deny` **[Tested]** |
| `mcpServers` | `{name: {command, args, env}}` or `{name: {url, headers}}` (also `timeout`, `requestTimeout`, `oauth`, `oauthScopes`) | stdio **[Tested]**, remote **[Docs]** |
| `includeMcpJson` | Add the tools of `mcp.json` servers on top of `tools`. **Default false** in the schema | semantics **[Source]** + **[Tested]**, see section 10 |
| `includePowers` | Add power tools. Default false | **[Source]** |
| `resources` | `file://…` (loaded at startup), `skill://…` (metadata at startup, content on demand), `knowledgeBase` entries | `file://`, `skill://` **[Tested]** |
| `hooks` | Array of hook documents, PascalCase triggers in V3 | **[Docs]** |
| `welcomeMessage`, `dispatchKind`, `includePowers` | Misc | **[Source]** |
| `allowedTools`, `toolsSettings`, `toolAliases`, `keyboardShortcut` | CLI 2.x legacy; V3 skips a 2.x profile with `allowedTools`/`toolsSettings` but no `permissions` | **[Docs]** |

### How KAS turns an agent into a tool list

The filter in KAS **[Source]** (confirmed by tests):

1. Start with the tools matching the agent's `tools` patterns (`*` matches **every** tool,
   including tools of MCP servers the agent did not declare).
2. If `includeMcpJson` is true, add all MCP-tagged tools.
3. Always add the "MCP disclosure" tools (the deferred-tool loader).
4. If `includePowers` is true, add power tools.

So `includeMcpJson: false` does **not** hide `mcp.json` servers when `tools` contains `*`.
Use `@builtin` instead of `*` to get all built-in tools and no foreign MCP tools.
**[Tested]**

---

## 10. MCP

- An agent's `mcpServers` entry `{command, args, env}` starts a stdio server. A tiny
  newline-delimited JSON-RPC server (`initialize`, `tools/list`, `tools/call`, `ping`) is
  enough; see `test/fixtures/mcp/secret-server.ts`. **[Tested]**
- MCP tool calls appear as `title: "@secret/get_secret"`,
  `rawInput: {tool_id: "secret::get_secret", arguments: {}}`,
  `_meta.kiro.serverName: "secret"`. **[Tested]**
- MCP tools are **deferred**: before the first call the model uses a loader tool ("I need to
  load the secret tool first since it's a deferred tool"), which shows up as an update
  without a start. **[Tested]**
- A relative path in `args` resolved against the session's working directory (a checkout
  or worktree). **[Tested]** via the sample `.archon/mcp/secret.json`.
- **Kiro also loads the workspace `.kiro/settings/mcp.json`** for every session, whatever
  the agent says: a custom agent with `includeMcpJson: false` and `tools: ["*"]` called a
  server declared only there. **[Tested]** The global `~/.kiro/settings/mcp.json` presumably
  behaves the same **[Unverified]**. KAS's MCP loader reads workspace config only when the
  workspace is trusted **[Source]**, and headless runs in fresh temp directories counted as
  trusted **[Tested]**. With `tools: ["@builtin", "@declared"]`, those servers' tools are not
  callable. **[Tested]**
- **`--require-mcp-startup`** makes Kiro wait for the agent's servers before submitting the
  instruction and exit 3 if one fails (30-second limit **[Docs]**). A *broken server in
  the workspace `mcp.json`* did **not** fail the run; only the agent's own servers are
  gated. **[Tested]**
- Without `--require-mcp-startup`, Kiro logs MCP startup problems and continues. **[Docs]**
- **Playwright MCP works**: `npx -y @playwright/mcp@0.0.85 --headless --isolated` exposed
  `browser_navigate`, `browser_snapshot`, `browser_evaluate`, `browser_close`; a navigate +
  snapshot + close turn took about 30 s with your installed Chrome. **[Tested]** On a cold
  npx cache, the 30-second startup limit could be hit. **[Unverified]**

---

## 11. Skills

- A skill is a folder with `SKILL.md` (front matter `name` matching the folder, lowercase
  letters, digits and hyphens, at most 64 characters; `description` at most 1024
  characters; optional `license`, `compatibility`, `metadata`), plus optional `scripts/`,
  `references/`, `assets/`. **[Docs]**
- **Discovery: `.kiro/skills/` (workspace) and `~/.kiro/skills/` (global) only**; workspace
  wins on a name clash. Kiro does **not** discover `.claude/skills` or `.agents/skills`.
  **[Docs]** + **[Tested]** (a `.claude/skills` skill was never listed).
- The default agent loads all discovered skills. Custom agents load only those in
  `resources` as `skill://` URIs (globs and `~` allowed). **[Docs]**
- **An absolute `skill:///abs/path/SKILL.md` URI works.** **[Tested]**
- Progressive loading: names and descriptions at startup; the full `SKILL.md` on activation
  through the **`disclose_context`** tool (title `Load skill: <name>`,
  `toolOrigin: "acp"`), whose output starts `Skill directory: <dir>` / "Relative paths in this
  skill…". **[Tested]**
- Skills also appear as slash commands (`_meta.kiro.type: "skill"`) in
  `available_commands_update`, even for a custom agent that did not select them. **[Seen]**
  Whether a headless prompt starting with `/name` invokes one is **[Unverified]**.

### The skill leak, and how to close it

1. A custom agent **does not advertise** unselected skills: asked for a skill's secret
   phrase without naming the skill, the model answered "UNKNOWN". **[Tested]**
2. But **`disclose_context` will load any discovered `.kiro/skills` skill by name**, whatever
   the agent's `resources` say. "Load the other-skill skill" worked for an agent that
   selected a different skill, and for one that selected none. **[Tested]**
3. `excludedTools: ["disclose_context"]` and `excludedTools: ["skill"]` **do not** stop it:
   the tool comes from the harness (`toolOrigin: "acp"`), not the agent's tool list.
   **[Tested]**
4. **A permissions rule does**: `disclose_context` belongs to the `skill` capability, and
   ```json
   "permissions": { "rules": [{ "capability": "skill", "effect": "deny" }] }
   ```
   made the model answer "NO-OTHER-SKILL". **[Tested]**
5. With the loader denied, deliver wanted skills as **`file://<abs>/SKILL.md` resources**,
   which load up front (the model then knew the declared skill's phrase). **[Tested]** Add
   a line telling the model each skill's directory, so its relative references (scripts,
   reference files) resolve, since `disclose_context` no longer prints it.

The skill content is not hidden from the filesystem: a session with read tools can still
open a `SKILL.md` directly. That follows from the mechanism and was not tried
**[Unverified]**. The feature tour's exactness step removes all tools so this cannot mask
its result; the live exactness test only tells the model not to read files.

### Playwright CLI skill

`npx @playwright/cli install --skills` (package `@playwright/cli`, binary
`playwright-cli`) writes `.claude/skills/playwright-cli/` with a 493-line `SKILL.md` and
ten reference files, and adds `.playwright-cli/` to `.gitignore`. The skill expects
`playwright-cli` on PATH (`npm i -g @playwright/cli`). Loaded as a `file://` resource, it
let Kiro open a page and read its title through shell commands. **[Tested]** The skill's
front matter carries a Claude-style `allowed-tools: Bash(playwright-cli:*) …` line, which
Kiro ignores. **[Seen]**

---

## 12. Steering and project guidance

- **`AGENTS.md`** in the workspace is followed, by the default agent and by custom agents.
  **[Tested]**
- **`.kiro/steering/*.md` with `inclusion: always`** front matter is followed, by default and
  custom agents, and with the `skill` capability denied. **[Tested]**
- Other inclusion modes (on-demand, file-match, manual) were **not tested**. KAS describes
  `disclose_context` as the tool "for skills and progressive steering" **[Source]**, so
  denying the `skill` capability presumably also blocks steering that Kiro loads on demand.
  **[Unverified]**
- Powers can carry steering and MCP servers; `includePowers: false` should drop both.
  **[Unverified]**

---

## 13. ACP server (`kiro-cli acp`), for reference

Not used by the connector (it wraps stream-json instead), but surveyed: **[Docs]** /
**[Seen]** in `--help`

- Hidden subcommand; defaults to the V2 engine unless `--agent-engine v3` or
  `acp.agentEngine` says otherwise.
- `--auth-method cli|client` (V3): `cli` uses the CLI login, `client` answers the engine's
  `_kiro/auth/getAccessToken` requests.
- `--agent`, `--model`, `--effort`, `--trust-all-tools`, `--trust-tools` are V2-only and
  rejected with V3.
- Methods: `initialize` (advertises `loadSession` and image prompts), `session/new`,
  `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_model` (V2) / `session/set_config_option` (V3).
- Extensions use the `_kiro.dev/` prefix (`commands/execute|options|available`,
  `mcp/oauth_request`, `mcp/server_initialized`, `compaction/status`, `clear/status`,
  `_session/terminate`); V3 negotiates them through `agentCapabilities._meta.kiro.extensionMethods`.
- V2 ends a turn with a `TurnEnd` update; V3 from the `session/prompt` response. Stop
  reasons documented: `end_turn`, `refusal`.

---

## 14. Settings that affect headless runs

`kiro-cli settings <name> <value>` (`--delete`, `--workspace`) **[Docs]**:
`chat.defaultAgent`, `chat.defaultModel`, `chat.disableAutoCompaction`,
`compaction.excludeMessages`, `compaction.excludeContextWindowPercent`,
`toolSearch.enabled`, `toolSearch.minPct`, `toolSearch.minTokens`, `chat.enableKnowledge`,
`chat.enableCodeIntelligence` (both on by default in V3 headless), `acp.agentEngine`.

---

## 15. Tricks the connector relies on

1. **Ephemeral agents** as the only way to pass a system prompt, a tool list, MCP servers
   or skills: write `~/.kiro/agents/archon-run-<random>.json` (mode 600, created
   exclusively), pass `--agent archon-run-…`, delete it when the turn ends, sweep
   `archon-run-*` files older than six hours. Never write the workspace `.kiro/agents`.
2. **Isolated agent recipe** for a workflow node:
   ```json
   {
     "name": "archon-run-…",
     "tools": ["@builtin", "@playwright"],
     "includeMcpJson": false,
     "includePowers": false,
     "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.85", "--headless", "--isolated"] } },
     "resources": ["file:///abs/.claude/skills/playwright-cli/SKILL.md"],
     "permissions": { "rules": [{ "capability": "skill", "effect": "deny" }] },
     "prompt": "…skills note with each skill's directory…"
   }
   ```
   plus `--require-mcp-startup` when servers are declared.
3. **Login preflight** with `whoami --format json` before every turn, unless `KIRO_API_KEY`
   is set.
4. **Prompt on stdin**, never argv.
5. **Process-group SIGTERM** for cancellation, SIGKILL after five seconds.
6. **Classify failures** from `errorType` / `retryErrorType` / `stage` / documented exit
   codes (3, 4), never from message text.
7. **Missing-session check** with `--list-sessions` before claiming a resume target is gone.
8. **Pin a cheap model** (`minimax-m2.5`) for every test run; `auto` costs 4× more.

## 16. Kiro CLI 3.x and Linux (checked 16 November 2026)

Kiro CLI 3.0.0 (3 November 2026) made the V3 engine the default and retired the classic CLI
and the desktop app's bundled CLI. 3.3.0 (12 November) is current. Releases since 2.37.1:
3.0.0, 3.1.0, 3.2.0, 3.2.1, 3.3.0. **[Docs]**

Checked on **3.3.0** in an Ubuntu 26.04 arm64 container (glibc 2.43), signed out. No model
turn was run.

- **Install:** `curl -fsSL https://cli.kiro.dev/install | bash` downloads a single
  ~200 MB `kiro-cli` binary into `~/.local/bin` and prints a PATH hint. It doesn't change
  shell files. Ubuntu's stock `~/.profile` adds `~/.local/bin` at the next login.
  **[Tested]** Linux needs glibc 2.34+, with a musl build for older systems. **[Docs]**
- **Signed-out `whoami --format json`** still prints `{"account":null}`, but now **exits 1**
  (2.37.1 exited 0). The connector parses stdout and ignores the exit code, so
  `archon doctor` still reports "No signed-in Kiro account". **[Tested]**
- **Every flag the connector passes still exists:** `--v3`, `--no-interactive`,
  `--output-format stream-json` ("JSON Lines on stdout", implies `--no-interactive`),
  `--agent`, `--model`, `--effort`, `--trust-all-tools`, `--resume-id`, `--list-sessions`,
  `--list-models`, `--require-mcp-startup`, `whoami --format`. **[Seen]** in `--help`
- **Engine selection** (from `--help`): with no setting, interactive chat uses V3, while
  `--no-interactive` or piped stdin uses **V2**, unless `--trust-all-tools` is passed, which
  selects V3. `--agent-engine v1|v2|v3` and `chat.agentEngine` override that. The connector
  always passes `--v3`. **[Seen]**
- **`--trust-tools` help in 3.3.0** describes the richer matching the docs promised: tool
  names, `@server`, `@server/tool`, `@builtin` and `*`/`?` patterns, with `--trust-tools=`
  trusting nothing. **[Seen]** Whether an untrusted tool is now refused in a headless run
  (unlike 2.37.1, [section 8](#8-tool-trust-does-not-restrict-tools)) is **[Unverified]**.
  The connector doesn't depend on it, because it restricts tools through the agent's
  `tools` list.
- **New `--trust-workspace`:** "Skip the 'Trust this workspace?' prompt for this launch only
  (V3 only). Hooks, agents, MCP servers and workflows from this folder load without asking."
  How an untrusted folder behaves headless (for example a fresh Archon worktree) is
  **[Unverified]**.
- **Agent files:** 3.x "upgrades custom agents still in the V2 format", rewriting each file
  in place after saving a `.json.bak`. Whether that touches the connector's ephemeral
  `archon-run-*.json` agents is **[Unverified]**. **[Docs]**
- **Headless sign-in:** `kiro-cli login --use-device-flow` prints a URL and a code to enter
  in any browser. Other options are `--license free|pro`, `--identity-provider`, `--region`
  and `--social google|github`. **[Seen]** 3.2.1 "fixes sign-in on Linux hosts with no
  graphical session". **[Docs]** `KIRO_API_KEY` is for Pro, Pro+, Pro Max and Power
  subscribers only. **[Docs]**

## 17. Open questions

- Does denying the `skill` capability also block on-demand steering, and anything else
  `disclose_context` serves?
- Can a headless prompt starting with `/skill-name` invoke an unselected skill?
- Do throttling, quota and auth errors look exactly like the recorded `InvalidModelError`?
- Does `KIRO_HOME` move `~/.kiro` (agents, sessions, settings) completely?
- Does `includePowers: false` remove power-provided steering?
- Remote (`url`) and SSE MCP servers in an agent's `mcpServers` were never tried.
- Behaviour on Linux and Windows (process groups, paths) is untested with a real turn.
- Does a real turn on Kiro 3.x still produce the stream-json events in section 4, and do the
  connector's ephemeral agents survive 3.x's V2-to-V3 agent upgrade unchanged?
- Does V3's workspace-trust check change what loads in a headless run in a new folder?
