#!/usr/bin/env bun
/**
 * Build this plugin and install it into an Archon home, for local use before (or instead
 * of) a GitHub release.
 *
 *   bun run install:local                       # into $ARCHON_HOME, else ~/.archon
 *   bun run install:local --archon-home /abs/dir
 *   bun run install:local --remove              # uninstall the local copy
 *
 * The receipt id is `local/kiro-archon-connector`. Restart a running `archon serve`
 * afterwards; a new CLI process sees the change immediately.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../archon-plugin.json';
import packageJson from '../package.json';
import { installLocalPlugin, RECEIPT_ID } from '../e2e/install';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const homeFlag = args.indexOf('--archon-home');
// Archon starts plugins by absolute path, so the home must be absolute.
const archonHome = resolve(homeFlag >= 0 && args[homeFlag + 1] ? args[homeFlag + 1]! : (process.env.ARCHON_HOME ?? join(homedir(), '.archon')));
const pluginsDir = join(archonHome, 'plugins');
const ownReceipt = join(pluginsDir, 'installed', ...RECEIPT_ID.split('/'), 'receipt.json');

function receiptsOwningExecutable(): string[] {
  const owners: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'receipt.json') {
        try {
          const receipt = JSON.parse(readFileSync(path, 'utf8')) as { id?: string; files?: { path: string }[] };
          if (receipt.files?.some(file => file.path === manifest.executable) && receipt.id !== RECEIPT_ID) {
            owners.push(receipt.id ?? path);
          }
        } catch {
          // An unreadable receipt is Archon's to report.
        }
      }
    }
  };
  walk(join(pluginsDir, 'installed'));
  return owners;
}

if (args.includes('--remove')) {
  rmSync(ownReceipt, { force: true });
  if (receiptsOwningExecutable().length === 0) rmSync(join(pluginsDir, manifest.executable), { force: true });
  console.log(`Removed ${RECEIPT_ID} from ${archonHome}`);
  process.exit(0);
}

const others = receiptsOwningExecutable();
if (others.length > 0) {
  console.error(`${manifest.executable} is already installed by ${others.join(', ')}. Remove it first: archon plugin remove ${others[0]}`);
  process.exit(1);
}

const build = Bun.spawnSync([process.execPath, 'scripts/build.ts'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();
const installed = await installLocalPlugin({
  archonHome,
  binary: join(ROOT, 'dist', manifest.executable),
  commit: /^[0-9a-f]{40}$/.test(head) ? head : '0'.repeat(40),
  tag: `v${packageJson.version}`,
});
console.log(`Installed ${RECEIPT_ID} (provider '${installed.descriptor.id}', v${installed.descriptor.version}) into ${archonHome}`);
console.log(`  executable: ${installed.target}`);
console.log(`  receipt:    ${installed.receiptFile}`);
console.log('Check it with: archon plugin list && archon doctor');
