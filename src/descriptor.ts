import type { ProviderCapabilities } from '@archon/provider-contract';
import {
  PROVIDER_PLUGIN_PROTOCOL,
  providerPluginDescriptorSchema,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';
import packageJson from '../package.json' with { type: 'json' };
import { configJsonSchemas } from './config';
import { KIRO_SKILL_DISCOVERY } from './skills';

export const PROVIDER_ID = 'kiro';

/**
 * What this plugin enforces end to end. Every `true` here is exercised by the unit,
 * conformance and live suites; anything the plugin cannot enforce is `false`, so the
 * engine warns or refuses before spend instead of running a node without what it asked for.
 */
export const KIRO_CAPABILITIES: ProviderCapabilities = {
  // A turn is one `kiro-cli chat` process. Kiro waits for its own workflows before it
  // exits, but a shell command started with `run_in_background` has no lifecycle in the
  // stream, so work may outlive the turn without being observable.
  backgroundWork: 'unobserved',
  // `--resume-id <session>`; a missing session is confirmed through `--list-sessions`.
  sessionResume: true,
  sessionFork: false,
  // A workflow node's `mcp:` servers become the ephemeral agent's `mcpServers`, with the
  // user's mcp.json and powers excluded; `--require-mcp-startup` fails the node as
  // misconfigured before any model work when one does not start.
  mcp: true,
  hooks: false,
  // A workflow node's `skills:` are loaded as `file://` resources, and Kiro's own skill
  // loader is denied, so the node sees exactly the skills it names (none when omitted).
  skills: true,
  plugins: false,
  agents: false,
  // `allowed_tools` / `denied_tools` become `tools` / `excludedTools` of an ephemeral
  // Kiro agent, which removes the tools from the session rather than only refusing approval.
  toolRestrictions: true,
  // Prompt augmentation + tiered JSON parse; the engine validates and re-asks on a miss.
  structuredOutput: 'best-effort',
  requiresAllPropertiesRequired: false,
  envInjection: true,
  // A node's `maxBudgetUsd` and `assistants.kiro.runBudgetUsd` are checked before each turn
  // against the credits earlier turns used (src/budget.ts); over a cap, the turn is refused
  // as `budget_exceeded`. Kiro reports credits only when a turn ends, so a turn already
  // running is not stopped, and the turn that crosses a cap finishes with a warning.
  costControl: true,
  // Kiro reports credits per turn; the result's `cost` is credits × `creditPriceUsd`.
  costReporting: true,
  // Kiro reports no token counts.
  tokenReporting: false,
  stopReasonReporting: true,
  turnCountReporting: false,
  resolvedModelReporting: false,
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};

export const descriptor: ProviderPluginDescriptor = providerPluginDescriptorSchema.parse({
  protocol: PROVIDER_PLUGIN_PROTOCOL,
  id: PROVIDER_ID,
  displayName: 'Kiro CLI',
  version: packageJson.version,
  capabilities: KIRO_CAPABILITIES,
  // Kiro authenticates itself (`kiro-cli login`, or KIRO_API_KEY for headless accounts).
  credentials: { kind: 'static', specs: [] },
  configSchema: configJsonSchemas.install,
  config: { ...configJsonSchemas, stripUnknownKeys: true },
  skillDiscovery: KIRO_SKILL_DISCOVERY,
});
