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
  return {
    role: role.length > 0 ? role : undefined,
    agentStateDir: config.get<string>('agentStateDir') ?? '.agent',
    rolesFile: config.get<string>('rolesFile') ?? '.github/agents/roles.json',
    issueUrlTemplate: (config.get<string>('issueUrlTemplate') ?? '').trim() || undefined,
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
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
  } catch {
    await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
  }
}

function appendActivity(repoRoot: string, agentStateDir: string, role: string, event: ActivityEvent): void {
  try {
    const dir = path.join(repoRoot, agentStateDir, role);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'activity.jsonl');
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
): void {
  const kickoffFile = path.join(repoRoot, agentStateDir, role, 'kickoff.json');
  const nextPromptFile = path.join(repoRoot, agentStateDir, role, 'next-prompt.json');

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
      branch: readBranch(repoRoot),
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
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.commands.registerCommand('agentConsole.openConsole', () => {
    const root = findRepoRoot(config.agentStateDir);
    if (!root) {
      void vscode.window.showWarningMessage('Agent Console: no workspace folder open.');
      return;
    }
    openConsole(context, root, config);
  }));

  if (!repoRoot) {
    status.text = '$(warning) Agent Console: no workspace';
    status.show();
    return;
  }

  const role = detectRole(repoRoot, config.role, config.rolesFile);
  if (!role) {
    status.text = '$(warning) Agent Console: role unknown';
    status.tooltip = 'Set agentConsole.role or AGENT_CONSOLE_ROLE for this window.';
    status.show();
    return;
  }

  status.text = `$(rocket) ${role} kickoff watching`;
  status.tooltip = `Watching ${config.agentStateDir}/${role}/kickoff.json`;
  status.show();

  const stateKey = STATE_KEY_PREFIX + role;

  const tick = async () => {
    const payload = readKickoff(repoRoot, config.agentStateDir, role);
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

  startActivityEmitter(context, role, repoRoot, config.agentStateDir);
}

export function deactivate(): void {
  // no-op
}
