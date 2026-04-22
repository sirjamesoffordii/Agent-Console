// CLI smoke tests for bin/ac.cjs.
//
// Exercises the full CLI against a scratch workspace on disk. Run with:
//   node tests/cli.test.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';

const thisFile = url.fileURLToPath(import.meta.url);
const here = path.dirname(thisFile);
const repoRoot = path.resolve(here, '..');
const cli = path.join(repoRoot, 'bin', 'ac.cjs');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}`); }
}
function eq(name, a, b) {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  ok(name + (pass ? '' : ` (got ${JSON.stringify(a)} expected ${JSON.stringify(b)})`), pass);
}

function mkScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  fs.mkdirSync(path.join(root, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.github', 'agents', 'roles.json'),
    JSON.stringify({
      version: 1,
      roles: [
        { id: 'Alpha', shortId: 'A', displayName: 'Alpha' },
        { id: 'Beta',  shortId: 'B', displayName: 'Beta' },
      ],
    }, null, 2),
  );
  return root;
}

function ac(repo, args) {
  const res = spawnSync(process.execPath, [cli, ...args, '--repo', repo], { encoding: 'utf8' });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

console.log('== ac CLI ==');

// --- help
{
  const { stdout, status } = ac('.', ['--help']);
  ok('--help exits 0', status === 0);
  ok('--help mentions status command', stdout.includes('status'));
  ok('--help mentions pause-all', stdout.includes('pause-all'));
}

// --- status against empty scratch
{
  const root = mkScratch();
  const { stdout, status } = ac(root, ['status', '--json']);
  ok('status --json exits 0 on empty state', status === 0);
  const rows = JSON.parse(stdout);
  eq('status lists both roles', rows.map((r) => r.role), ['Alpha', 'Beta']);
  eq('no role paused initially', rows.every((r) => !r.paused), true);
  fs.rmSync(root, { recursive: true, force: true });
}

// --- pause / resume / pause-all / resume-all
{
  const root = mkScratch();
  eq('pause Alpha exit 0', ac(root, ['pause', 'Alpha']).status, 0);
  let ctrl = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'agent-control.json'), 'utf8'));
  eq('pause Alpha recorded', ctrl.paused?.Alpha, true);

  eq('resume Alpha exit 0', ac(root, ['resume', 'Alpha']).status, 0);
  ctrl = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'agent-control.json'), 'utf8'));
  ok('resume Alpha cleared', !ctrl.paused?.Alpha);

  eq('pause-all exit 0', ac(root, ['pause-all']).status, 0);
  ctrl = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'agent-control.json'), 'utf8'));
  eq('pause-all sets both', Object.keys(ctrl.paused ?? {}).sort().join(','), 'Alpha,Beta');

  eq('resume-all exit 0', ac(root, ['resume-all']).status, 0);
  ctrl = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'agent-control.json'), 'utf8'));
  eq('resume-all clears all', JSON.stringify(ctrl.paused ?? {}), '{}');
  fs.rmSync(root, { recursive: true, force: true });
}

// --- prompt write + clear
{
  const root = mkScratch();
  eq('prompt write exit 0', ac(root, ['prompt', 'Alpha', 'do the thing']).status, 0);
  const override = path.join(root, '.agent', 'Alpha', 'prompt-override.txt');
  eq('prompt override content', fs.readFileSync(override, 'utf8'), 'do the thing');

  eq('clear-prompt exit 0', ac(root, ['clear-prompt', 'Alpha']).status, 0);
  ok('prompt override removed', !fs.existsSync(override));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- poke writes kickoff.json with the right shape
{
  const root = mkScratch();
  const { status } = ac(root, ['poke', 'Alpha', '--prompt', 'wake up', '--reason', 'cli-test']);
  eq('poke exit 0', status, 0);
  const kickoff = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'Alpha', 'kickoff.json'), 'utf8'));
  eq('kickoff.role', kickoff.role, 'Alpha');
  eq('kickoff.version', kickoff.version, 1);
  eq('kickoff.prompt', kickoff.prompt, 'wake up');
  eq('kickoff.reason', kickoff.reason, 'cli-test');
  ok('kickoff.epoch numeric', typeof kickoff.epoch === 'number' && kickoff.epoch > 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// --- unknown role errors with non-zero exit
{
  const root = mkScratch();
  const { status, stderr } = ac(root, ['pause', 'NopeRole']);
  ok('unknown role exits 1', status === 1);
  ok('unknown role mentions known', stderr.includes('Alpha') && stderr.includes('Beta'));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- tail handles no activity gracefully
{
  const root = mkScratch();
  const { status, stdout } = ac(root, ['tail', 'Alpha']);
  eq('tail exit 0 on empty', status, 0);
  ok('tail prints placeholder', stdout.includes('(no activity yet)'));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- tail formats events and respects --n
{
  const root = mkScratch();
  const dir = path.join(root, '.agent', 'Alpha');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ ts: '2026-04-22T00:00:0' + i + 'Z', type: 'tool.call', summary: 'edit_' + i }));
  fs.writeFileSync(path.join(dir, 'activity.jsonl'), lines.join('\n') + '\n');

  const all = ac(root, ['tail', 'Alpha']);
  eq('tail default exit 0', all.status, 0);
  const countAll = all.stdout.trim().split('\n').filter(Boolean).length;
  eq('tail default returns all 5', countAll, 5);

  const limited = ac(root, ['tail', 'Alpha', '--n', '2']);
  const countLim = limited.stdout.trim().split('\n').filter(Boolean).length;
  eq('tail --n 2 returns 2', countLim, 2);
  ok('tail shows newest events first filter (last two)', limited.stdout.includes('edit_3') && limited.stdout.includes('edit_4'));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- shortId alias resolves to canonical role
{
  const root = mkScratch();
  eq('pause via shortId exit 0', ac(root, ['pause', 'A']).status, 0);
  const ctrl = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'agent-control.json'), 'utf8'));
  eq('shortId A resolved to Alpha', ctrl.paused?.Alpha, true);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n== Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
