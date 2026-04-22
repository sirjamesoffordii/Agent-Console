#!/usr/bin/env node
// Agent Console CLI (`ac`) — cross-platform operator control without needing
// VS Code or the tray. Reads the same .agent/<role>/... layout the extension
// emits, and writes to the same agent-control.json / prompt-override.txt /
// kickoff.json files the webview does.
//
// Usage:
//   ac status [--role <id>] [--json]
//   ac pause <role>
//   ac resume <role>
//   ac pause-all
//   ac resume-all
//   ac spawn <role> [--reason <text>] [--prompt <text>]
//   ac poke <role> [--reason <text>]
//   ac prompt <role> <text>        # writes prompt-override.txt
//   ac clear-prompt <role>
//   ac tail <role> [--n 20]
//
// Exits 0 on success, 1 on user error, 2 on internal error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION = require('../package.json').version;

function findRepoRoot(start) {
  let dir = path.resolve(start ?? process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.github', 'agents', 'roles.json'))) return dir;
    if (fs.existsSync(path.join(dir, '.agent'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start ?? process.cwd());
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readRoles(repo) {
  const file = path.join(repo, '.github', 'agents', 'roles.json');
  const doc = readJson(file);
  return doc?.roles ?? [];
}

function requireRole(roles, id) {
  const hit = roles.find((r) => r.id === id || r.shortId === id);
  if (!hit) {
    console.error(`ac: role '${id}' not in roles.json (known: ${roles.map((r) => r.id).join(', ')})`);
    process.exit(1);
  }
  return hit;
}

function controlPath(repo) { return path.join(repo, '.agent', 'agent-control.json'); }

function loadControl(repo) { return readJson(controlPath(repo)) ?? {}; }

function saveControl(repo, ctrl) { writeJson(controlPath(repo), ctrl); }

function ageSecFromEpoch(epoch) {
  if (!epoch) return -1;
  return Math.floor(Date.now() / 1000 - epoch);
}

function fmtAge(sec) {
  if (sec < 0) return '  —  ';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function cmdStatus(repo, args) {
  const roles = readRoles(repo);
  const ctrl = loadControl(repo);
  const only = args['--role'];
  const rows = roles.filter((r) => !only || r.id === only || r.shortId === only).map((r) => {
    const state = readJson(path.join(repo, '.agent', r.id, 'state.json'));
    const heartbeat = readJson(path.join(repo, '.agent', r.id, 'heartbeat.json'));
    const rl = readJson(path.join(repo, '.agent', r.id, 'ratelimit.json'));
    const override = fs.existsSync(path.join(repo, '.agent', r.id, 'prompt-override.txt'));
    const paused = !!ctrl.paused?.[r.id];
    const age = ageSecFromEpoch(state?.lastActivityEpoch ?? (heartbeat?.ts ? Math.floor(new Date(heartbeat.ts).getTime() / 1000) : 0));
    return {
      role: r.id,
      shortId: r.shortId,
      paused,
      age: fmtAge(age),
      branch: state?.branch ?? '—',
      coreRemaining: rl?.resources?.core?.remaining ?? null,
      coreLimit: rl?.resources?.core?.limit ?? null,
      overridePending: override,
    };
  });

  if (args['--json']) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const pad = (s, n) => (s ?? '').toString().padEnd(n);
  console.log(`${pad('ROLE', 26)} ${pad('SHORT', 6)} ${pad('PAUSED', 7)} ${pad('AGE', 6)} ${pad('BRANCH', 18)} ${pad('GH CORE', 10)} OVR`);
  console.log('-'.repeat(84));
  for (const r of rows) {
    const gh = r.coreRemaining != null ? `${r.coreRemaining}/${r.coreLimit}` : '—';
    console.log(`${pad(r.role, 26)} ${pad(r.shortId, 6)} ${pad(r.paused ? 'yes' : 'no', 7)} ${pad(r.age, 6)} ${pad(r.branch, 18)} ${pad(gh, 10)} ${r.overridePending ? '*' : ''}`);
  }
}

function cmdPause(repo, roleArg, paused) {
  const roles = readRoles(repo);
  const entry = requireRole(roles, roleArg);
  const ctrl = loadControl(repo);
  ctrl.paused = ctrl.paused ?? {};
  if (paused) ctrl.paused[entry.id] = true;
  else delete ctrl.paused[entry.id];
  saveControl(repo, ctrl);
  console.log(`${paused ? 'paused' : 'resumed'} ${entry.id}`);
}

function cmdPauseAll(repo, paused) {
  const roles = readRoles(repo);
  const ctrl = loadControl(repo);
  if (paused) {
    ctrl.paused = ctrl.paused ?? {};
    for (const r of roles) ctrl.paused[r.id] = true;
  } else {
    ctrl.paused = {};
  }
  saveControl(repo, ctrl);
  console.log(`${paused ? 'paused' : 'resumed'} ${roles.length} role${roles.length === 1 ? '' : 's'}`);
}

function writeKickoff(repo, role, reason, promptArg) {
  const file = path.join(repo, '.agent', role, 'kickoff.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const overrideFile = path.join(repo, '.agent', role, 'prompt-override.txt');
  const prompt = promptArg ??
    (fs.existsSync(overrideFile) ? fs.readFileSync(overrideFile, 'utf8') : `Resume your ${role} workflow.`);
  const payload = {
    role,
    ts: new Date().toISOString(),
    epoch: Math.floor(Date.now() / 1000),
    reason,
    version: 1,
    prompt,
  };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function cmdSpawn(repo, role, args) {
  const roles = readRoles(repo);
  const entry = requireRole(roles, role);
  const file = writeKickoff(repo, entry.id, args['--reason'] ?? 'cli-spawn', args['--prompt']);
  console.log(`kickoff -> ${file}`);
  if (entry.spawnScript) {
    const script = path.join(repo, entry.spawnScript);
    if (fs.existsSync(script)) {
      try {
        execFileSync('pwsh', ['-NoProfile', '-File', script], { stdio: 'inherit' });
      } catch (err) {
        console.error(`ac: spawn script exited non-zero: ${err.message}`);
        process.exit(2);
      }
    }
  }
}

function cmdPoke(repo, role, args) {
  const roles = readRoles(repo);
  const entry = requireRole(roles, role);
  const file = writeKickoff(repo, entry.id, args['--reason'] ?? 'cli-poke', args['--prompt']);
  console.log(`poke -> ${file} (extension will re-kick chat on next 5s poll)`);
}

function cmdPrompt(repo, role, text) {
  const roles = readRoles(repo);
  const entry = requireRole(roles, role);
  const dir = path.join(repo, '.agent', entry.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prompt-override.txt');
  if (!text || text.trim() === '') {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    console.log(`cleared prompt-override for ${entry.id}`);
  } else {
    fs.writeFileSync(file, text, 'utf8');
    console.log(`wrote prompt-override for ${entry.id} (${text.length} chars)`);
  }
}

function cmdTail(repo, role, args) {
  const roles = readRoles(repo);
  const entry = requireRole(roles, role);
  const n = parseInt(args['--n'] ?? '20', 10);
  const file = path.join(repo, '.agent', entry.id, 'activity.jsonl');
  if (!fs.existsSync(file)) { console.log('(no activity yet)'); return; }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      console.log(`${e.ts ?? '?'}  ${(e.type ?? '?').padEnd(18)}  ${e.summary ?? ''}`);
    } catch {
      console.log(line);
    }
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        out[a] = argv[i + 1]; i++;
      } else {
        out[a] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Agent Console CLI v${VERSION}

Commands:
  status [--role <id>] [--json]   Show per-role health (default)
  pause <role>                    Mark role as paused
  resume <role>                   Resume a paused role
  pause-all                       Pause every role
  resume-all                      Resume every role
  spawn <role> [--prompt <text>]  Write kickoff.json and run spawnScript (if any)
  poke <role> [--prompt <text>]   Write kickoff.json only (no spawn)
  prompt <role> <text>            Persist prompt-override.txt for the role
  clear-prompt <role>             Delete prompt-override.txt
  tail <role> [--n 20]            Tail activity.jsonl for a role

Options common to all:
  --repo <path>   Override detected repo root
  --help          Print this help
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const repo = args['--repo'] ? path.resolve(args['--repo']) : findRepoRoot();

  try {
    switch (cmd) {
      case 'status':       return cmdStatus(repo, args);
      case 'pause':        return cmdPause(repo, args._[0], true);
      case 'resume':       return cmdPause(repo, args._[0], false);
      case 'pause-all':    return cmdPauseAll(repo, true);
      case 'resume-all':   return cmdPauseAll(repo, false);
      case 'spawn':        return cmdSpawn(repo, args._[0], args);
      case 'poke':         return cmdPoke(repo, args._[0], args);
      case 'prompt':       return cmdPrompt(repo, args._[0], args._.slice(1).join(' '));
      case 'clear-prompt': return cmdPrompt(repo, args._[0], '');
      case 'tail':         return cmdTail(repo, args._[0], args);
      default:
        console.error(`ac: unknown command '${cmd}'`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`ac: ${err.message}`);
    process.exit(2);
  }
}

main();
