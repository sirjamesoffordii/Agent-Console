/**
 * Agent Console.
 *
 * Generic VS Code webview that aggregates per-role state from a shared
 * `.agent/<role>/...` directory into a single dashboard. Polls every 5s.
 *
 * Expected data sources:
 *   - roles manifest (default: `.github/agents/roles.json`)
 *   - `<agentStateDir>/<role>/heartbeat.json`
 *   - `<agentStateDir>/<role>/state.json`
 *   - `<agentStateDir>/<role>/activity.jsonl`
 *   - `<agentStateDir>/agent-control.json`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type ConsoleOptions = {
  agentStateDir: string;
  issueUrlTemplate?: string;
  rolesFile: string;
};

type RoleEntry = {
  id: string;
  shortId: string;
  displayName: string;
  spawnScript?: string;
};

type RolesFile = { version?: number; roles?: RoleEntry[] };
type Heartbeat = { ts?: string; status?: string; issue?: number | null };
type LiveStateRead = { lastActivityEpoch?: number; branch?: string; nextPromptPreview?: string };
type ActivityLine = { ts?: string; type?: string; summary?: string };
type AgentControl = { paused?: Record<string, boolean> };
type RateBucket = { limit?: number; remaining?: number; reset?: number };
type RateLimitFile = {
  ts?: string;
  ok?: boolean;
  error?: string;
  resources?: { core?: RateBucket; search?: RateBucket; graphql?: RateBucket };
};

type RowSnapshot = {
  role: string;
  shortId: string;
  displayName: string;
  status: string;
  issue: number | null;
  branch: string;
  lastActivityIso: string;
  ageSec: number;
  paused: boolean;
  stopReason: string;
  nextPromptPreview: string;
  health: 'green' | 'amber' | 'red';
  ghCore: string;
  ghCoreLevel: 'ok' | 'warn' | 'crit' | 'unknown';
};

const PANEL_ID = 'agentConsole.panel';
const PANEL_TITLE = 'Agent Console';
const POLL_MS = 5_000;
const STALE_SEC = 180;

function resolveRepoPath(repoRoot: string, relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(repoRoot, relativeOrAbsolute);
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readRoles(repoRoot: string, rolesFile: string): RoleEntry[] {
  const file = resolveRepoPath(repoRoot, rolesFile);
  const data = readJson<RolesFile>(file);
  return data?.roles ?? [];
}

function readControl(repoRoot: string, agentStateDir: string): AgentControl {
  const file = path.join(repoRoot, agentStateDir, 'agent-control.json');
  return readJson<AgentControl>(file) ?? {};
}

function writeControl(repoRoot: string, agentStateDir: string, ctrl: AgentControl): void {
  const dir = path.join(repoRoot, agentStateDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent-control.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ctrl, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function tailActivity(repoRoot: string, agentStateDir: string, role: string, n = 5): ActivityLine[] {
  const file = path.join(repoRoot, agentStateDir, role, 'activity.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as ActivityLine;
      } catch {
        return { summary: line };
      }
    });
  } catch {
    return [];
  }
}

function deriveStopReason(events: ActivityLine[]): string {
  const errors = events.filter((event) => event.type === 'error');
  if (errors.length > 0) return errors[errors.length - 1].summary ?? 'error';
  const last = events[events.length - 1];
  if (!last) return '';
  return `${last.type ?? '?'}: ${last.summary ?? ''}`.slice(0, 80);
}

function snapshot(repoRoot: string, role: RoleEntry, options: ConsoleOptions): RowSnapshot {
  const heartbeat = readJson<Heartbeat>(path.join(repoRoot, options.agentStateDir, role.id, 'heartbeat.json')) ?? {};
  const state = readJson<LiveStateRead>(path.join(repoRoot, options.agentStateDir, role.id, 'state.json')) ?? {};
  const control = readControl(repoRoot, options.agentStateDir);
  const paused = !!control.paused?.[role.id];

  let ageSec = -1;
  let lastActivityIso = '';
  if (state.lastActivityEpoch) {
    ageSec = Math.floor(Date.now() / 1000 - state.lastActivityEpoch);
    lastActivityIso = new Date(state.lastActivityEpoch * 1000).toISOString();
  } else if (heartbeat.ts) {
    const parsed = new Date(heartbeat.ts).getTime();
    if (!Number.isNaN(parsed)) {
      ageSec = Math.floor((Date.now() - parsed) / 1000);
      lastActivityIso = heartbeat.ts;
    }
  }

  const events = tailActivity(repoRoot, options.agentStateDir, role.id, 5);
  const stopReason = deriveStopReason(events);

  const rateLimit = readJson<RateLimitFile>(path.join(repoRoot, options.agentStateDir, role.id, 'ratelimit.json'));
  let ghCore = '—';
  let ghCoreLevel: RowSnapshot['ghCoreLevel'] = 'unknown';
  if (rateLimit?.ok && rateLimit.resources?.core) {
    const remaining = rateLimit.resources.core.remaining ?? 0;
    const limit = rateLimit.resources.core.limit ?? 0;
    ghCore = `${remaining}/${limit}`;
    if (limit > 0) {
      const pct = Math.round((100 * remaining) / limit);
      ghCoreLevel = pct <= 10 ? 'crit' : pct <= 25 ? 'warn' : 'ok';
    }
  }

  let health: RowSnapshot['health'] = 'amber';
  if (paused) health = 'amber';
  else if (ageSec >= 0 && ageSec <= STALE_SEC) health = 'green';
  else if (ageSec > STALE_SEC) health = 'red';

  return {
    role: role.id,
    shortId: role.shortId,
    displayName: role.displayName,
    status: heartbeat.status ?? 'unknown',
    issue: heartbeat.issue ?? null,
    branch: state.branch ?? '',
    lastActivityIso,
    ageSec,
    paused,
    stopReason,
    nextPromptPreview: (state.nextPromptPreview ?? '').slice(0, 120),
    health,
    ghCore,
    ghCoreLevel,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] as string));
}

function issueCell(issue: number | null, role: string, issueUrlTemplate?: string): string {
  if (!issue) return '—';
  if (!issueUrlTemplate) return `#${issue}`;
  return `<a href="#" data-act="open-issue" data-role="${role}" data-issue="${issue}">#${issue}</a>`;
}

function renderHtml(rows: RowSnapshot[], nonce: string, issueUrlTemplate?: string): string {
  const body = rows.map((row) => {
    const ageText = row.ageSec < 0 ? 'no data' : `${row.ageSec}s ago`;
    const dot = `<span class="dot ${row.health}"></span>`;
    const ghCell = `<span class="gh ${row.ghCoreLevel}">${escapeHtml(row.ghCore)}</span>`;
    const pauseLabel = row.paused ? 'Resume' : 'Pause';
    const pauseAction = row.paused ? 'resume' : 'pause';
    return `<tr>
      <td>${dot}<strong>${escapeHtml(row.shortId)}</strong><br/><small>${escapeHtml(row.displayName)}</small></td>
      <td>${escapeHtml(row.status)}${row.paused ? ' <em>(paused)</em>' : ''}</td>
      <td>${issueCell(row.issue, row.role, issueUrlTemplate)}</td>
      <td><code>${escapeHtml(row.branch || '—')}</code></td>
      <td>${escapeHtml(ageText)}<br/><small>${escapeHtml(row.lastActivityIso)}</small></td>
      <td>${ghCell}</td>
      <td><small>${escapeHtml(row.stopReason || '—')}</small></td>
      <td><small>${escapeHtml(row.nextPromptPreview || '—')}</small></td>
      <td>
        <button data-act="${pauseAction}" data-role="${row.role}">${pauseLabel}</button>
        <button data-act="poke" data-role="${row.role}">Poke</button>
        <button data-act="restart" data-role="${row.role}">Restart</button>
      </td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
<title>${PANEL_TITLE}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 12px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); vertical-align: top; }
  th { font-weight: 600; opacity: 0.8; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.green { background: #4caf50; }
  .dot.amber { background: #ff9800; }
  .dot.red   { background: #f44336; }
  .gh.ok      { color: #4caf50; }
  .gh.warn    { color: #ff9800; font-weight: 600; }
  .gh.crit    { color: #f44336; font-weight: 700; }
  .gh.unknown { opacity: 0.6; }
  button { margin-right: 4px; padding: 2px 8px; cursor: pointer; }
  a { color: var(--vscode-textLink-foreground); }
  .footer { margin-top: 12px; font-size: 11px; opacity: 0.7; }
</style>
</head>
<body>
<h1>${PANEL_TITLE}</h1>
<table>
  <thead>
    <tr><th>Role</th><th>Status</th><th>Issue</th><th>Branch</th><th>Last Activity</th><th>GH (core)</th><th>Stop Reason</th><th>Next Prompt</th><th>Actions</th></tr>
  </thead>
  <tbody>${body || '<tr><td colspan="9">No roles registered.</td></tr>'}</tbody>
</table>
<div class="footer">Auto-refresh every 5s · ${escapeHtml(new Date().toISOString())}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    event.preventDefault();
    vscode.postMessage({
      act: button.getAttribute('data-act'),
      role: button.getAttribute('data-role'),
      issue: button.getAttribute('data-issue'),
    });
  });
</script>
</body>
</html>`;
}

function createNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function buildIssueUrl(template: string, issue: string): string {
  return template.includes('{issue}')
    ? template.replaceAll('{issue}', issue)
    : `${template.replace(/\/$/, '')}/${issue}`;
}

export function openConsole(
  context: vscode.ExtensionContext,
  repoRoot: string,
  options: ConsoleOptions,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    PANEL_ID,
    PANEL_TITLE,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const refresh = () => {
    const roles = readRoles(repoRoot, options.rolesFile);
    const rows = roles.map((role) => snapshot(repoRoot, role, options));
    panel.webview.html = renderHtml(rows, createNonce(), options.issueUrlTemplate);
  };

  refresh();
  const handle = setInterval(refresh, POLL_MS);
  panel.onDidDispose(() => clearInterval(handle), null, context.subscriptions);
  panel.webview.onDidReceiveMessage((msg: { act: string; role: string; issue?: string }) => {
    void handleAction(repoRoot, options, msg, refresh);
  });

  return panel;
}

async function handleAction(
  repoRoot: string,
  options: ConsoleOptions,
  msg: { act: string; role: string; issue?: string },
  refresh: () => void,
): Promise<void> {
  if (!msg.role || !msg.act) return;

  switch (msg.act) {
    case 'pause': {
      const control = readControl(repoRoot, options.agentStateDir);
      control.paused = control.paused ?? {};
      control.paused[msg.role] = true;
      writeControl(repoRoot, options.agentStateDir, control);
      refresh();
      return;
    }
    case 'resume': {
      const control = readControl(repoRoot, options.agentStateDir);
      if (control.paused) delete control.paused[msg.role];
      writeControl(repoRoot, options.agentStateDir, control);
      refresh();
      return;
    }
    case 'open-issue': {
      if (msg.issue && options.issueUrlTemplate) {
        const url = buildIssueUrl(options.issueUrlTemplate, msg.issue);
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
      return;
    }
    case 'poke':
    case 'restart': {
      const roles = readRoles(repoRoot, options.rolesFile);
      const role = roles.find((entry) => entry.id === msg.role);
      if (!role?.spawnScript) {
        await vscode.window.showWarningMessage(`No spawnScript registered for ${msg.role}`);
        return;
      }
      const script = resolveRepoPath(repoRoot, role.spawnScript);
      const argFlag = msg.act === 'poke' ? ' -Poke' : '';
      const terminal = vscode.window.createTerminal({ name: `${role.shortId} ${msg.act}`, cwd: repoRoot });
      terminal.sendText(`pwsh -NoProfile -File \"${script}\"${argFlag}`);
      terminal.show();
      return;
    }
  }
}
