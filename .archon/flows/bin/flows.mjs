#!/usr/bin/env node
// Helper for the kiro-flows workflow (.archon/workflows/kiro-flows.yaml).
//
// The workflow's bash nodes call this file for everything that has to be exact: reading
// features.yaml, checking the flows markdown, checking the test file for cheats, listing
// frozen files, and making the "break" copies. The writer agent may run `check` itself
// while it debugs, so it can see the same verdict the judge will give.
//
// Subcommands (run from the repository root):
//   resolve <features.yaml> <group> <suite_dir> <base_url>
//                                                 print the group as one line of JSON
//   lint <flows.md> [--tickets A-1,B-2] [--max 5] check the markdown's shape
//   check <suite_dir> <group>                     check tests/<group>.spec.ts against the markdown
//   freeze-list <suite_dir> <group> [dir...]      hash every file the writer must not change
//   break-plan <flows.md>                         one JSON line per flow: title, grep, values
//   mutate <in.spec.ts> <out.spec.ts> <title> <values.json>
//                                                 copy a test file with expected values swapped
//
// Exit code 0 means OK; 1 means the check failed (the reasons are printed); 2 means bad usage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const [cmd, ...args] = process.argv.slice(2);

// The text every expected value is replaced with in a "break" copy. Lint rejects it in
// the markdown so a flow can never expect it for real.
const BROKEN = 'zz-not-this';

// ADJUST: the keys features.yaml may use for a ticket's (or a group's) spec files. Each may
// hold one path or a list of paths, relative to the repository root; a path may be a file
// or a folder.
const SPEC_KEYS = ['spec', 'specs', 'spec_file', 'spec_files', 'spec_dir', 'spec_dirs', 'spec_path', 'spec_paths'];

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const unique = (xs) => [...new Set(xs)];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const count = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : 0);

// ---------------------------------------------------------------------------------------
// The flows markdown
//
//   # Flows: <group title>                       (optional top heading)
//
//   ## Flow: Reject a submitted claim @PROJ-40    one flow; tags are tickets or @emergent
//   - Given I am logged in as "approver"
//   - And I create and submit a claim named "e2e-claim-{run}"
//   - When I open that claim and reject it with reason "Duplicate"
//   - Then the claim's status shows "Rejected"   quoted text = exactly what the screen showed
//
//   ## Differences                               (free text: spec says X, app does Y)
//   ## Not found                                 (free text: spec items the app doesn't have)
//
// A step's "part" is given, when or then; And/But take the part of the line above them.
// Quoted values in the then part are the expected values. A value that contains {run}, or
// that the flow itself typed in an earlier Given/When line, is an "echo": the test checks
// its own data. Every flow must also expect at least one value the app produced (a "fixed"
// value); only fixed values are swapped in the break check.
// ---------------------------------------------------------------------------------------
function parseFlows(text) {
  const flows = [];
  const problems = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      cur = null;
      const m = line.match(/^##\s+Flow:\s*(.*)$/);
      if (m) {
        const rest = m[1].trim();
        const tags = (rest.match(/(?:^|\s)@\S+/g) ?? []).map((t) => t.trim());
        const name = rest.replace(/(?:^|\s)@\S+/g, ' ').replace(/\s+/g, ' ').trim();
        cur = { name, tags, title: [name, ...tags].join(' '), line: i + 1, steps: [] };
        flows.push(cur);
      }
      return;
    }
    if (!cur || !/^[-*]\s+/.test(line)) return;
    const s = line.match(/^[-*]\s+(Given|When|Then|And|But)\s+(.+)$/);
    if (s) cur.steps.push({ keyword: s[1], text: `${s[1]} ${s[2].trim()}`, line: i + 1 });
    else problems.push(`line ${i + 1}: a list item in a flow must start with Given, When, Then, And or But: ${line}`);
  });
  for (const f of flows) {
    let part = null;
    for (const st of f.steps) {
      if (['Given', 'When', 'Then'].includes(st.keyword)) part = st.keyword.toLowerCase();
      st.part = part ?? 'none';
      st.values = [...st.text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    }
    const typed = new Set(f.steps.filter((s) => s.part !== 'then').flatMap((s) => s.values));
    f.thenSteps = f.steps.filter((s) => s.part === 'then');
    f.thenValues = unique(f.thenSteps.flatMap((s) => s.values)).filter((v) => v.length > 0);
    f.fixedValues = f.thenValues.filter((v) => !v.includes('{run}') && !typed.has(v));
  }
  return { flows, problems };
}

function readFlows(mdPath) {
  if (!fs.existsSync(mdPath)) die(`FLOWS-FAIL\nno file ${mdPath}`, 1);
  return parseFlows(fs.readFileSync(mdPath, 'utf8'));
}

// ---------------------------------------------------------------------------------------
// resolve: find one group in features.yaml.
// Reads YAML with the `yaml` package installed in the suite (the setup node installs it),
// because the client machine may not have yq. Accepts either `groups: [...]` or a bare list.
// ---------------------------------------------------------------------------------------
function resolve() {
  const [features, group, suite, baseUrl] = args;
  if (!features || !group || !suite || !baseUrl) die('usage: flows.mjs resolve <features.yaml> <group> <suite_dir> <base_url>');
  // The group id becomes file names and a tag, so keep it to letters, digits and dashes.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(group)) die(`group id "${group}" may only use letters, digits, - and _`, 1);
  if (!/^https?:\/\/\S+$/.test(baseUrl)) die(`base_url must start with http:// or https://, got: ${baseUrl}`, 1);
  if (!fs.existsSync(features)) die(`no features file at ${features}`, 1);
  let YAML;
  try {
    YAML = createRequire(path.resolve(suite, 'package.json'))('yaml');
  } catch {
    die(`the yaml package is not installed in ${suite}; run the setup node first`, 1);
  }
  const doc = YAML.parse(fs.readFileSync(features, 'utf8'));
  const groups = Array.isArray(doc) ? doc : doc?.groups;
  if (!Array.isArray(groups)) die(`${features} has no "groups" list`, 1);
  const g = groups.find((x) => x && x.id === group);
  if (!g) die(`group "${group}" is not in ${features}. Groups: ${groups.map((x) => x?.id).join(', ')}`, 1);

  const tickets = [];
  const specs = [];
  const addSpecs = (v) => [].concat(v ?? []).forEach((p) => typeof p === 'string' && specs.push(p));
  for (const t of g.tickets ?? []) {
    if (typeof t === 'string') { tickets.push(t); continue; }
    if (t?.key) tickets.push(String(t.key));
    for (const k of SPEC_KEYS) addSpecs(t?.[k]);
  }
  for (const k of SPEC_KEYS) addSpecs(g[k]);
  const missing = unique(specs).filter((p) => !fs.existsSync(p));
  if (missing.length) die(`spec files listed for group "${group}" do not exist:\n${missing.join('\n')}`, 1);

  // Roles may be a list of ids or a map of id → description.
  const roles = Array.isArray(g.roles) ? g.roles.map(String) : Object.keys(g.roles ?? {});
  // Paths are spelled out here so prompts never have to glue "$INPUTS.group" to ".md".
  const out = {
    group: g.id,
    base_url: `${baseUrl.replace(/\/+$/, '')}/`,
    md_file: path.join(suite, 'flows', `${group}.md`),
    test_file: path.join(suite, 'tests', `${group}.spec.ts`),
    test_rel: `tests/${group}.spec.ts`,
    title: String(g.title ?? g.id),
    description: String(g.description ?? ''),
    entry: String(g.entry ?? '/'),
    roles: roles.join(','),
    first_role: roles[0] ?? 'default',
    tickets: unique(tickets).join(','),
    specs: unique(specs).join(','),
    notes: String(g.notes ?? ''),
  };
  if (!specs.length) console.error(`note: group "${group}" lists no spec files; explore will rely on the app alone`);
  console.log(JSON.stringify(out));
}

// ---------------------------------------------------------------------------------------
// lint: the markdown's shape. Run by explore (to fix its own file) and by freeze (to decide).
// ---------------------------------------------------------------------------------------
function lint() {
  const md = args[0];
  if (!md) die('usage: flows.mjs lint <flows.md> [--tickets A-1,B-2] [--max 5]');
  const max = Number(option('--max', '5'));
  const tickets = option('--tickets', '').split(',').map((t) => t.trim()).filter(Boolean);
  const allowedTags = new Set([...tickets.map((t) => `@${t}`), '@emergent']);
  const { flows, problems } = readFlows(md);

  if (flows.length === 0) problems.push('no "## Flow: <name> @TAG" headings found');
  if (flows.length > max) problems.push(`${flows.length} flows; at most ${max} allowed`);
  const names = flows.map((f) => f.name);
  for (const n of unique(names.filter((n, i) => names.indexOf(n) !== i))) problems.push(`two flows are named "${n}"`);

  for (const f of flows) {
    const at = `flow "${f.name}" (line ${f.line})`;
    if (!f.name) problems.push(`line ${f.line}: a flow heading needs a name before its tags`);
    if (/["'`\\]/.test(f.name)) problems.push(`${at}: the name must not contain quotes, backticks or backslashes`);
    if (!f.tags.length) problems.push(`${at}: needs at least one tag (${[...allowedTags].join(' ')})`);
    for (const t of f.tags) if (!allowedTags.has(t)) problems.push(`${at}: tag ${t} is not one of ${[...allowedTags].join(' ')}`);
    if (!f.steps.length) { problems.push(`${at}: has no "- Given/When/Then ..." lines`); continue; }
    if (!['Given', 'When'].includes(f.steps[0].keyword)) problems.push(`${at}: the first line must start with Given or When`);
    if (!f.steps.some((s) => s.keyword === 'When')) problems.push(`${at}: needs at least one When line`);
    if (!f.thenSteps.length) problems.push(`${at}: needs at least one Then line`);
    for (const s of f.thenSteps) {
      if (!s.values.length) problems.push(`line ${s.line}: every Then/And/But line after a Then must quote the exact text it expects: ${s.text}`);
    }
    if (f.thenSteps.length && !f.fixedValues.length) {
      problems.push(`${at}: every expected value is text the flow typed itself; expect at least one value the app produced (a message, a count, a status)`);
    }
    for (const s of f.steps) if (s.text.includes(BROKEN)) problems.push(`line ${s.line}: "${BROKEN}" is reserved for the break check`);
    for (const s of f.steps) if (s.text.includes('`')) problems.push(`line ${s.line}: no backticks in step lines`);
  }

  if (problems.length) {
    console.log('FLOWS-FAIL');
    problems.forEach((p) => console.log(`- ${p}`));
    process.exit(1);
  }
  console.log(`FLOWS-OK (${flows.length} flows)`);
}

// ---------------------------------------------------------------------------------------
// check: the test file against the frozen markdown, plus patterns that make a failing test
// look green. The judge (the check node) and the writer run exactly this.
// None of this proves an assertion is strong enough; the break check does that.
// ---------------------------------------------------------------------------------------
const BANNED = [
  [/\.(skip|fixme|fail|only)\b/, 'skips, inverts or isolates a test (.skip/.fixme/.fail/.only)'],
  [/\bexpect\.soft\b/, 'expect.soft lets the test carry on and pass after a failed check'],
  [/\bcatch\b/, 'try/catch or .catch() can swallow a failure'],
  [/\bwaitForTimeout\b/, 'waitForTimeout sleeps instead of waiting for something on the page'],
  [/\bif\s*\(/, 'no if statements in tests: a check inside an if can be skipped silently'],
  [/\.route(FromHAR)?\s*\(/, 'no mocking: the test must talk to the real app'],
  [/https?:\/\//, 'no full URLs: use paths relative to baseURL, e.g. page.goto(\'./\')'],
];

function check() {
  const [suite, group] = args;
  if (!suite || !group) die('usage: flows.mjs check <suite_dir> <group>');
  const md = path.join(suite, 'flows', `${group}.md`);
  const spec = path.join(suite, 'tests', `${group}.spec.ts`);
  const { flows, problems } = readFlows(md);
  if (!fs.existsSync(spec)) {
    console.log(`CHECK-FAIL\n- no test file ${spec}`);
    process.exit(1);
  }
  const code = fs.readFileSync(spec, 'utf8');
  // Labels may be written with any quote style; drop escapes before looking for text.
  const flat = code.replace(/\\/g, '');
  // The same code with every test.step label removed: an expected value must appear here,
  // in code that types or checks it, not only in the label that names the step.
  const unlabelled = code
    .replace(/test\.step\s*\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, 'test.step(')
    .replace(/\\/g, '');

  const tests = (code.match(/(?:^|[^.\w$])test\s*\(/g) ?? []).length;
  if (tests !== flows.length) problems.push(`${tests} test(...) calls for ${flows.length} flows; write exactly one test per flow`);
  for (const f of flows) {
    if (!flat.includes(f.title)) problems.push(`no test titled exactly: ${f.title}`);
    for (const s of f.steps) {
      if (!flat.includes(s.text)) problems.push(`flow "${f.name}": no test.step labelled exactly: ${s.text}`);
    }
    for (const v of f.thenValues.filter((x) => !x.includes('{run}'))) {
      if (!unlabelled.includes(v)) problems.push(`flow "${f.name}": "${v}" appears only in a step label; assert it with expect()`);
    }
  }
  const steps = flows.reduce((n, f) => n + f.steps.length, 0);
  const stepCalls = (code.match(/\btest\.step\s*\(/g) ?? []).length;
  if (stepCalls < steps) problems.push(`${stepCalls} test.step(...) calls for ${steps} markdown lines; wrap each line in its own test.step`);
  const thens = flows.reduce((n, f) => n + f.thenSteps.length, 0);
  const expects = (code.match(/(?:^|[^.\w$])expect\s*(\.\s*poll\s*)?\(/g) ?? []).length;
  if (expects < thens) problems.push(`${expects} expect(...) calls for ${thens} Then/And/But lines; check every Then line with expect()`);

  code.split(/\r?\n/).forEach((line, i) => {
    for (const [re, why] of BANNED) if (re.test(line)) problems.push(`${spec}:${i + 1}: ${why}\n    ${line.trim()}`);
  });

  // Assertions belong in the test file, where the rules above apply. A helper that asserts
  // could hide an `if` around the check.
  const helpers = path.join(suite, 'helpers');
  if (fs.existsSync(helpers)) {
    for (const file of fs.readdirSync(helpers, { recursive: true })) {
      const p = path.join(helpers, String(file));
      if (!fs.statSync(p).isFile() || !/\.[cm]?[jt]s$/.test(p)) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/(?:^|[^.\w$])expect\s*[.(]/.test(line)) problems.push(`${p}:${i + 1}: no expect() in helpers; assert in the test\n    ${line.trim()}`);
        if (/\.(skip|fixme|fail|only)\b/.test(line)) problems.push(`${p}:${i + 1}: ${BANNED[0][1]}\n    ${line.trim()}`);
      });
    }
  }

  if (problems.length) {
    console.log('CHECK-FAIL');
    problems.forEach((p) => console.log(`- ${p}`));
    process.exit(1);
  }
  console.log(`CHECK-OK (${flows.length} tests, ${steps} steps, ${expects} expects)`);
}

// ---------------------------------------------------------------------------------------
// freeze-list: "<sha256>  <path>" for every file the writer must not change, sorted.
// The writer may change only tests/<group>.spec.ts and helpers/ (except helpers/login.ts,
// which a person writes). Everything else in the suite is frozen, plus any extra folders
// given (the workflow passes .archon/flows/bin, so the checks themselves can't be edited).
// ---------------------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', 'reports', '.auth', 'playwright-report', '.cache']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('test-results')) walk(p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

function freezeList() {
  const [suite, group, ...extra] = args;
  if (!suite || !group) die('usage: flows.mjs freeze-list <suite_dir> <group> [dir...]');
  const own = path.join(suite, 'tests', `${group}.spec.ts`);
  const helpers = path.join(suite, 'helpers') + path.sep;
  const login = path.join(suite, 'helpers', 'login.ts');
  const files = [...walk(suite), ...extra.flatMap((d) => walk(d))].filter((p) => {
    if (p === own || p.endsWith('.zz-break.spec.ts')) return false;
    if (p.startsWith(helpers) && p !== login) return false;
    return true;
  });
  for (const p of files.sort()) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log(`${sha}  ${p}`);
  }
}

// ---------------------------------------------------------------------------------------
// break-plan / mutate: the "can this test fail?" check.
// For each flow, the break node makes a copy of the test file with that flow's fixed
// expected values replaced by "zz-not-this-<n>", runs only that test, and requires it to
// fail. A test that stays green doesn't really check those values.
// ---------------------------------------------------------------------------------------
function breakPlan() {
  const { flows } = readFlows(args[0] ?? die('usage: flows.mjs break-plan <flows.md>'));
  for (const f of flows) {
    console.log(JSON.stringify({ title: f.title, grep: `${escapeRegex(f.title)}$`, values: f.fixedValues }));
  }
}

function mutate() {
  const [input, output, title, valuesJson] = args;
  if (!input || !output || !title || !valuesJson) die('usage: flows.mjs mutate <in> <out> <title> <values.json>');
  const values = JSON.parse(valuesJson);
  // The title stays as it is, so --grep still finds the test after the swap.
  const parts = fs.readFileSync(input, 'utf8').split(title);
  let swapped = 0;
  const mutated = parts.map((part) => {
    let p = part;
    values.forEach((v, i) => {
      swapped += count(p, v);
      p = p.split(v).join(`${BROKEN}-${i + 1}`);
    });
    return p;
  });
  fs.writeFileSync(output, mutated.join(title));
  console.log(`swapped ${swapped} occurrence(s) of ${values.length} value(s)`);
}

switch (cmd) {
  case 'resolve': resolve(); break;
  case 'lint': lint(); break;
  case 'check': check(); break;
  case 'freeze-list': freezeList(); break;
  case 'break-plan': breakPlan(); break;
  case 'mutate': mutate(); break;
  default: die('usage: flows.mjs <resolve|lint|check|freeze-list|break-plan|mutate> ...  (see the top of this file)');
}
