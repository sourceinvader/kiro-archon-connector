#!/usr/bin/env bun
/**
 * Compile the plugin into standalone executables named the way `archon plugin add`
 * expects release assets: `archon-provider-kiro-<os>-<arch>[.exe]`, plus `checksums.txt`
 * in `sha256sum` format.
 *
 *   bun scripts/build.ts          # this machine's platform only (also dist/archon-provider-kiro)
 *   bun scripts/build.ts --all    # every supported release platform
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from '../archon-plugin.json';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, 'src', 'main.ts');
const all = process.argv.includes('--all');

const TARGETS = [
  { os: 'darwin', arch: 'arm64', bun: 'bun-darwin-arm64' },
  { os: 'darwin', arch: 'x64', bun: 'bun-darwin-x64' },
  { os: 'linux', arch: 'x64', bun: 'bun-linux-x64' },
  { os: 'linux', arch: 'arm64', bun: 'bun-linux-arm64' },
  { os: 'windows', arch: 'x64', bun: 'bun-windows-x64' },
] as const;

const hostOs = process.platform === 'win32' ? 'windows' : process.platform;
const selected = all ? TARGETS : TARGETS.filter(target => target.os === hostOs && target.arch === process.arch);
if (selected.length === 0) throw new Error(`No release target for ${process.platform}/${process.arch}`);

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const checksums: string[] = [];
for (const target of selected) {
  const asset = `${manifest.executable}-${target.os}-${target.arch}${target.os === 'windows' ? '.exe' : ''}`;
  const outfile = join(DIST, asset);
  const proc = Bun.spawn(
    [process.execPath, 'build', '--compile', '--minify', `--target=${target.bun}`, ENTRY, '--outfile', outfile],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' }
  );
  if ((await proc.exited) !== 0) throw new Error(`build failed for ${target.bun}`);
  const digest = createHash('sha256').update(await readFile(outfile)).digest('hex');
  checksums.push(`${digest}  ${asset}`);
  console.log(`built ${asset}`);
}
await writeFile(join(DIST, 'checksums.txt'), `${checksums.join('\n')}\n`);

if (!all) {
  const [target] = selected;
  const asset = `${manifest.executable}-${target!.os}-${target!.arch}${target!.os === 'windows' ? '.exe' : ''}`;
  await copyFile(join(DIST, asset), join(DIST, manifest.executable));
}
console.log(`checksums: ${join(DIST, 'checksums.txt')}`);
