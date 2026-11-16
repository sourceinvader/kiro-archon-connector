/**
 * Install the compiled plugin into an ARCHON_HOME the way `archon plugin add` does,
 * without a GitHub release: the real installer only fetches from GitHub, so this mirrors
 * its steps (packages/cli/src/commands/plugin-binary.ts, Archon v0.14.0):
 *   1. copy the executable to `<home>/plugins/<manifest.executable>`, mode 755;
 *   2. start it, run the `initialize` handshake, and take the descriptor it reports;
 *   3. check the descriptor id matches `archon-provider-<id>` and is not a maintained id;
 *   4. write `<home>/plugins/installed/<owner>/<repo>/receipt.json` with the manifest,
 *      tag, commit, file digest and descriptor.
 * The Archon host then validates that receipt and re-checks the live descriptor on every
 * session, exactly as for a GitHub install.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { connectProvider, type ProviderPluginDescriptor } from '@archon/provider-contract/plugin';
import manifest from '../archon-plugin.json';

export const RECEIPT_ID = 'local/kiro-archon-connector';

async function handshake(binary: string): Promise<ProviderPluginDescriptor> {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const client = await connectProvider({
    readable: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  });
  try {
    return client.descriptor;
  } finally {
    await client.close();
    await closed;
  }
}

export async function installLocalPlugin(options: { archonHome: string; binary: string; commit: string; tag: string }): Promise<{
  descriptor: ProviderPluginDescriptor;
  target: string;
  receiptFile: string;
}> {
  const pluginsDir = join(options.archonHome, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  const target = join(pluginsDir, manifest.executable);
  await copyFile(options.binary, target);
  await chmod(target, 0o755);

  const descriptor = await handshake(target);
  if (manifest.executable !== `archon-provider-${descriptor.id}`) {
    throw new Error(`descriptor id ${descriptor.id} does not match ${manifest.executable}`);
  }
  if ((MAINTAINED_PROVIDER_IDS as readonly string[]).includes(descriptor.id)) {
    throw new Error(`provider id ${descriptor.id} is reserved for Archon's maintained providers`);
  }

  const digest = createHash('sha256').update(await readFile(target)).digest('hex');
  const receiptFile = join(pluginsDir, 'installed', ...RECEIPT_ID.split('/'), 'receipt.json');
  await mkdir(join(receiptFile, '..'), { recursive: true });
  const receipt = {
    schemaVersion: 1,
    id: RECEIPT_ID,
    manifest,
    tag: options.tag,
    commit: options.commit,
    installedAt: new Date().toISOString(),
    files: [{ path: manifest.executable, sha256: digest }],
    descriptor,
  };
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return { descriptor, target, receiptFile };
}
