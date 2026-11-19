import { describe, expect, test } from 'bun:test';
import { providerCapabilitiesSchema } from '@archon/provider-contract';
import { PROVIDER_PLUGIN_PROTOCOL, providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import manifest from '../../archon-plugin.json';
import {
  configJsonSchemas,
  installConfigSchema,
  kiroEffort,
  readAssistantConfig,
  runConfigSchema,
  snapshotSchema,
} from '../../src/config';
import { descriptor, KIRO_CAPABILITIES } from '../../src/descriptor';

describe('descriptor', () => {
  test('parses, speaks the current protocol and matches the manifest executable', () => {
    expect(providerPluginDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor.protocol).toBe(PROVIDER_PLUGIN_PROTOCOL);
    expect(manifest.executable).toBe(`archon-provider-${descriptor.id}`);
    expect(manifest.kind).toBe('provider');
  });

  test('capabilities are complete and declare only what is implemented', () => {
    expect(providerCapabilitiesSchema.safeParse(KIRO_CAPABILITIES).success).toBe(true);
    expect(KIRO_CAPABILITIES).toMatchObject({
      sessionResume: true,
      sessionFork: false,
      toolRestrictions: true,
      structuredOutput: 'best-effort',
      effortControl: true,
      envInjection: true,
      mcp: true,
      skills: true,
      hooks: false,
      nativeTools: false,
      containerExec: false,
      costControl: true,
      costReporting: true,
      tokenReporting: false,
    });
  });

  test('uses native auth only', () => {
    expect(descriptor.credentials).toEqual({ kind: 'static', specs: [] });
  });

  test('declares the skill roots it loads from, Kiro first', () => {
    expect(descriptor.skillDiscovery).toEqual({
      project: ['.kiro/skills', '.agents/skills', '.claude/skills'],
      user: ['.kiro/skills', '.agents/skills', '.claude/skills'],
    });
  });
});

describe('config schemas', () => {
  test('install accepts every documented key and trims strings', () => {
    expect(
      installConfigSchema.parse({ model: ' minimax-m2.5 ', agent: 'reviewer', effort: 'high', trustAllTools: false, kiroPath: '/opt/kiro-cli' })
    ).toEqual({ model: 'minimax-m2.5', agent: 'reviewer', effort: 'high', trustAllTools: false, kiroPath: '/opt/kiro-cli' });
  });

  test('budget settings: positive dollar amounts, layerable per run', () => {
    expect(installConfigSchema.parse({ creditPriceUsd: 0.05, runBudgetUsd: 2 })).toEqual({ creditPriceUsd: 0.05, runBudgetUsd: 2 });
    expect(runConfigSchema.parse({ runBudgetUsd: 0.5 })).toEqual({ runBudgetUsd: 0.5 });
    for (const bad of [0, -1, '2']) {
      expect(installConfigSchema.safeParse({ runBudgetUsd: bad }).success).toBe(false);
      expect(installConfigSchema.safeParse({ creditPriceUsd: bad }).success).toBe(false);
    }
  });

  test('typos and wrong types are rejected instead of silently dropped', () => {
    expect(installConfigSchema.safeParse({ modle: 'x' }).success).toBe(false);
    expect(installConfigSchema.safeParse({ effort: 'ultra' }).success).toBe(false);
    expect(installConfigSchema.safeParse({ trustAllTools: 'yes' }).success).toBe(false);
    expect(installConfigSchema.safeParse({ model: '' }).success).toBe(false);
  });

  test('kiroPath is install-only: refused per run, dropped from snapshots', () => {
    expect(runConfigSchema.safeParse({ kiroPath: '/x' }).success).toBe(false);
    expect(snapshotSchema.parse({ model: 'auto', kiroPath: '/x' })).toEqual({ model: 'auto' });
  });

  test('JSON Schemas are generated for each scope', () => {
    expect(configJsonSchemas.install).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(configJsonSchemas.run.properties as object).sort()).toEqual([
      'agent',
      'creditPriceUsd',
      'effort',
      'model',
      'runBudgetUsd',
      'trustAllTools',
    ]);
    expect(JSON.stringify(configJsonSchemas.install)).toContain('x-archon-normalize');
  });

  test('readAssistantConfig keeps valid fields of a partly invalid block', () => {
    expect(readAssistantConfig(undefined)).toEqual({});
    expect(readAssistantConfig({ model: 'auto', effort: 'bogus' })).toEqual({ model: 'auto' });
  });
});

describe('kiroEffort', () => {
  test('maps Archon rungs onto Kiro levels, clamping down first', () => {
    expect(kiroEffort('low')).toBe('low');
    expect(kiroEffort('max')).toBe('max');
    expect(kiroEffort('ultra')).toBe('max');
    expect(kiroEffort('persistent')).toBe('max');
    expect(kiroEffort('minimal')).toBe('low'); // nothing weaker exists, so the next one up
    expect(kiroEffort('nonsense')).toBeUndefined();
    expect(kiroEffort(undefined)).toBeUndefined();
  });
});
