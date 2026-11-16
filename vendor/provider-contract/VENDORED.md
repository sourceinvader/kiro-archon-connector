# Vendored: @archon/provider-contract 0.14.0

Archon does not publish its provider contract to npm yet. Its provider-plugin guide says
to vendor the contract package until the versioned SDK ships, so this directory is a copy of
`packages/provider-contract` from https://github.com/coleam00/Archon at tag `v0.14.0`
(commit `8def159a6b2c23e832a5283b4131cfffd9af9344`), MIT licensed (see LICENSE).

Removed from the copy: unit tests (`*.test.ts`), the schema generator script, the
deterministic test-provider fixture, and the ACP schema test fixture (it needs
`@agentclientprotocol/sdk`, a test-only dependency). Nothing else is modified.

To update: re-copy from the new Archon tag, re-apply the same exclusions, bump
`PROVIDER_PLUGIN_PROTOCOL` expectations in this plugin's tests, and rerun `bun run check`.
