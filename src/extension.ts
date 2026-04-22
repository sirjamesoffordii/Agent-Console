/**
 * Agent Console companion extension.
 *
 * Watches `<agentStateDir>/<role>/kickoff.json` and opens Copilot Chat when a
 * fresh kickoff payload appears. Also emits lightweight activity telemetry to:
 *
 *   - `<agentStateDir>/<role>/state.json`
 *   - `<agentStateDir>/<role>/activity.jsonl`
 *
 * This makes the extension reusable across repos that share the same basic
 * `.agent/<role>/...` convention without hard-coding Partner Path branding.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConsoleOptions, openConsole } from './console';

type KickoffPayload = {
  role: string;
  ts: string;
  epoch: number;
  reason: string;
  version: number;
  prompt?: string;
  mode?: string;
};

type RoleManifestEntry = {
  id: string;
  shortId?: string;
  displayName?: string;
  userDataDir?: string;
};

type RolesFile = {
  version?: number;
  roles?: RoleManifestEntry[];
};

type LiveState = {
  role: string;
  status: string;
  branch?: string;
  lastActivityEpoch: number;
  nextPromptPreview?: string;
  ts: string;
  version: 1;
};

type ActivityEvent = {
  ts: string;
  role: string;
  type: 'chat.turn.start' | 'chat.turn.end' | 'tool.call' | 'command.run' | 'error' | 'state.tick';
  summary: string;
  tokens?: { in?: number; out?: number };
};

const POLL_MS = 5_000;
const ACTIVITY_TICK_MS = 5_000;
const STATE_KEY_PREFIX = 'agentConsole.lastEpoch.';
const DEFAULT_PROMPT = 'Resume your agent workflow for this repository.';

function getConfig(): ConsoleOptions & { role?: string } {
  const config = vscode.workspace.getConfiguration('agentConsole');
  const role = (config.get<string>('role') ?? '').trim();
  const sharedRoot = (config.get<string>('sharedRoot') ?? '').trim();
  return {
    role: role.length > 0 ? role : undefined,
    agentStateDir: config.get<string>('agentStateDir') ?? '.agent',
    rolesFile: config.get<string>('rolesFile') ?? '.github/agents/roles.json',
    issueUrlTemplate: (config.get<string>('issueUrlTemplate') ?? '').trim() || undefined,
    sharedRoot: sharedRoot.length > 0 ? sharedRoot : undefined,
  };
}

function resolveRepoPath(repoRoot: string, relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(repoRoot, relativeOrAbsolute);
}

function findRepoRoot(agentStateDir: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, agentStateDir);
    if (fs.existsSync(candidate)) return folder.uri.fsPath;
  }
  return folders[0]?.uri.fsPath;
}

// The "state root" is where `.agent/<role>/...` lives. Normally that's the
// workspace folder, but when multiple role windows point at different
// worktrees we want them to share one tree. `agentConsole.sharedRoot` (if set)
// always wins; otherwise we fall back to the workspace folder.
function resolveStateRoot(repoRoot: string, sharedRoot?: string): string {
  if (sharedRoot && fs.existsSync(sharedRoot)) return sharedRoot;
  return repoRoot;
}

function readJsonSafe<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readRoles(repoRoot: string, rolesFile: string): RoleManifestEntry[] {
  const file = resolveRepoPath(repoRoot, rolesFile);
  const roles = readJsonSafe<RolesFile>(file);
  return roles?.roles ?? [];
}

function detectRole(repoRoot: string, configRole: string | undefined, rolesFile: string): string | undefined {
  if (configRole) return configRole;

  const envRole = process.env.AGENT_CONSOLE_ROLE ?? process.env.PARTNER_PATH_ROLE;
  if (envRole && envRole.trim().length > 0) {
    return envRole.trim();
  }

  const haystack = [
    process.env.VSCODE_USER_DATA_DIR ?? '',
    process.env.USERPROFILE ?? '',
    vscode.env.appName,
    vscode.env.machineId ?? '',
    process.argv.join('|'),
  ].join('|');

  const roles = readRoles(repoRoot, rolesFile);
  for (const role of roles) {
    const userDataDir = role.userDataDir;
    if (!userDataDir) continue;
    const leaf = path.basename(userDataDir);
    if (leaf && haystack.toLowerCase().includes(leaf.toLowerCase())) {
      return role.id;
    }
  }

  return undefined;
}

function readKickoff(repoRoot: string, agentStateDir: string, role: string): KickoffPayload | undefined {
  const file = path.join(repoRoot, agentStateDir, role, 'kickoff.json');
  return readJsonSafe<KickoffPayload>(file);
}

function defaultPromptFor(role: string): string {
  return `Resume your ${role} workflow for this repository.` || DEFAULT_PROMPT;
}

async function openChatWithPrompt(prompt: string): Promise<void> {
  // Strategy: try the newest, most reliable command first; fall back through
  // older signatures. Each attempt is wrapped so one failure doesn't abort
  // the chain. The goal: both insert the prompt AND submit it.

  // 1) Chat API command (recent VS Code): opens panel, inserts query, and
  //    when isPartialQuery is false it auto-submits.
  const tryOpen = async (arg: unknown): Promise<boolean> => {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', arg);
      return true;
    } catch {
      return false;
    }
  };

  const opened =
    (await tryOpen({ query: prompt, isPartialQuery: false })) ||
    (await tryOpen({ query: prompt })) ||
    (await tryOpen(prompt));

  if (!opened) {
    // Last-resort: just focus the chat view so the operator sees something.
    try { await vscode.commands.executeCommand('workbench.action.chat.focus'); } catch { /* noop */ }
    return;
  }

  // Some VS Code builds accept `query` but do NOT auto-submit — they leave
  // the text in the input box. Belt-and-braces: try known submit commands.
  // Wait one frame for the chat view to finish rendering the input.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const submitCommands = [
    'workbench.action.chat.submit',
    'workbench.action.chat.sendToNewChat',
    'github.copilot.chat.submit',
  ];
  for (const cmd of submitCommands) {
    try {
      await vscode.commands.executeCommand(cmd);
      return;
    } catch {
      // try next
    }
  }
}

// Rotate `activity.jsonl` when it grows past this many bytes. Keeps a single
// `.1` archive so we never lose the last N minutes of context on rotation.
// 2 MiB is ~30k events at typical summary sizes — more than enough for stop-
// reason classification and the last few chat turns, without letting the file
// grow unbounded over a long-running session.
const MAX_ACTIVITY_BYTES = 2 * 1024 * 1024;

function appendActivity(repoRoot: string, agentStateDir: string, role: string, event: ActivityEvent): void {
  try {
    const dir = path.join(repoRoot, agentStateDir, role);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'activity.jsonl');
    // Rotate before append if the current file is at or above the cap.
    try {
      const stat = fs.statSync(file);
      if (stat.size >= MAX_ACTIVITY_BYTES) {
        const rotated = file + '.1';
        try { fs.unlinkSync(rotated); } catch { /* no prior archive */ }
        fs.renameSync(file, rotated);
      }
    } catch { /* file doesn't exist yet — nothing to rotate */ }
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // best-effort only
  }
}

function writeState(repoRoot: string, agentStateDir: string, state: LiveState): void {
  try {
    const dir = path.join(repoRoot, agentStateDir, state.role);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best-effort only
  }
}

function readBranch(repoRoot: string): string | undefined {
  try {
    const headFile = path.join(repoRoot, '.git', 'HEAD');
    if (!fs.existsSync(headFile)) return undefined;
    const head = fs.readFileSync(headFile, 'utf8').trim();
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length);
    return head.slice(0, 7);
  } catch {
    return undefined;
  }
}

function startActivityEmitter(
  context: vscode.ExtensionContext,
  role: string,
  repoRoot: string,
  agentStateDir: string,
  workspaceRoot?: string,
): void {
  const kickoffFile = path.join(repoRoot, agentStateDir, role, 'kickoff.json');
  const nextPromptFile = path.join(repoRoot, agentStateDir, role, 'next-prompt.json');
  const branchRoot = workspaceRoot ?? repoRoot;

  let lastKickoffMtime = 0;
  let lastNextPromptMtime = 0;
  let lastActivityEpoch = Math.floor(Date.now() / 1000);

  const safeMtime = (file: string): number => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };

  lastKickoffMtime = safeMtime(kickoffFile);
  lastNextPromptMtime = safeMtime(nextPromptFile);

  appendActivity(repoRoot, agentStateDir, role, {
    ts: new Date().toISOString(),
    role,
    type: 'state.tick',
    summary: 'Agent Console activated',
  });

  context.subscriptions.push(vscode.tasks.onDidStartTask((event) => {
    lastActivityEpoch = Math.floor(Date.now() / 1000);
    appendActivity(repoRoot, agentStateDir, role, {
      ts: new Date().toISOString(),
      role,
      type: 'command.run',
      summary: `task.start ${event.execution.task.name}`,
    });
  }));

  context.subscriptions.push(vscode.tasks.onDidEndTask((event) => {
    lastActivityEpoch = Math.floor(Date.now() / 1000);
    appendActivity(repoRoot, agentStateDir, role, {
      ts: new Date().toISOString(),
      role,
      type: 'command.run',
      summary: `task.end ${event.execution.task.name}`,
    });
  }));

  context.subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => {
    lastActivityEpoch = Math.floor(Date.now() / 1000);
    appendActivity(repoRoot, agentStateDir, role, {
      ts: new Date().toISOString(),
      role,
      type: 'command.run',
      summary: `terminal.open ${terminal.name}`,
    });
  }));

  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    appendActivity(repoRoot, agentStateDir, role, {
      ts: new Date().toISOString(),
      role,
      type: 'command.run',
      summary: `terminal.close ${terminal.name}`,
    });
  }));

  const tick = () => {
    const kickoffMtime = safeMtime(kickoffFile);
    if (kickoffMtime > lastKickoffMtime) {
      lastKickoffMtime = kickoffMtime;
      lastActivityEpoch = Math.floor(Date.now() / 1000);
      const kickoff = readJsonSafe<KickoffPayload>(kickoffFile);
      appendActivity(repoRoot, agentStateDir, role, {
        ts: new Date().toISOString(),
        role,
        type: 'chat.turn.start',
        summary: `kickoff: ${kickoff?.reason ?? '(unknown)'}`,
      });
    }

    const nextPromptMtime = safeMtime(nextPromptFile);
    if (nextPromptMtime > lastNextPromptMtime) {
      lastNextPromptMtime = nextPromptMtime;
      lastActivityEpoch = Math.floor(Date.now() / 1000);
      const nextPrompt = readJsonSafe<{ prompt?: string; reason?: string }>(nextPromptFile);
      appendActivity(repoRoot, agentStateDir, role, {
        ts: new Date().toISOString(),
        role,
        type: 'chat.turn.start',
        summary: `next-prompt: ${nextPrompt?.reason ?? '(unknown)'}`,
      });
    }

    const nextPrompt = readJsonSafe<{ prompt?: string }>(nextPromptFile);
    writeState(repoRoot, agentStateDir, {
      role,
      status: 'alive',
      branch: readBranch(branchRoot),
      lastActivityEpoch,
      nextPromptPreview: nextPrompt?.prompt?.slice(0, 200),
      ts: new Date().toISOString(),
      version: 1,
    });
  };

  tick();
  const handle = setInterval(tick, ACTIVITY_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(handle) });
}

export function activate(context: vscode.ExtensionContext): void {
  const config = getConfig();
  const repoRoot = findRepoRoot(config.agentStateDir);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  // Always make the status item clickable so operators can launch the console
  // from any window (host or role instance).
  status.command = 'agentConsole.openConsole';
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.commands.registerCommand('agentConsole.openConsole', () => {
    const root = findRepoRoot(config.agentStateDir);
    if (!root) {
      void vscode.window.showWarningMessage('Agent Console: no workspace folder open.');
      return;
    }
    const cfgStateRoot = resolveStateRoot(root, config.sharedRoot);
    // If sharedRoot differs from the workspace root, also search the workspace
    // root for role state — role windows may still be writing to their own
    // worktree, and we want the console to see the most recent data either way.
    const fallbacks = cfgStateRoot !== root ? [root] : [];
    openConsole(context, cfgStateRoot, { ...config, fallbackStateRoots: fallbacks });
  }));

  if (!repoRoot) {
    status.text = '$(dashboard) Agent Console';
    status.tooltip = 'Click to open Agent Console (no workspace folder detected)';
    status.show();
    return;
  }

  const role = detectRole(repoRoot, config.role, config.rolesFile);
  if (!role) {
    status.text = '$(dashboard) Agent Console';
    status.tooltip = 'Click to open Agent Console (role not detected for this window)';
    status.show();
    return;
  }

  status.text = `$(dashboard) ${role}`;
  status.tooltip = `Click to open Agent Console — watching ${config.agentStateDir}/${role}/kickoff.json`;
  status.show();

  const stateRoot = resolveStateRoot(repoRoot, config.sharedRoot);

  const stateKey = STATE_KEY_PREFIX + role;

  const tick = async () => {
    const payload = readKickoff(stateRoot, config.agentStateDir, role);
    if (!payload) return;
    if (payload.version !== 1) {
      status.text = '$(warning) Agent Console: unknown schema';
      status.tooltip = `Refusing kickoff with version=${payload.version}; expected 1.`;
      status.show();
      return;
    }
    if (typeof payload.epoch !== 'number' || payload.role !== role) return;

    const lastSeen = context.globalState.get<number>(stateKey, 0);
    if (payload.epoch <= lastSeen) return;

    const prompt = payload.prompt?.trim().length
      ? payload.prompt
      : defaultPromptFor(role);

    await openChatWithPrompt(prompt);
    await context.globalState.update(stateKey, payload.epoch);
    status.text = `$(check) ${role} kickoff fired`;
    status.tooltip = `Last kickoff epoch ${payload.epoch} (${payload.reason}).`;
  };

  void tick();
  const handle = setInterval(() => { void tick(); }, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(handle) });

  startActivityEmitter(context, role, stateRoot, config.agentStateDir, repoRoot);
}

export function deactivate(): void {
  // no-op
}
