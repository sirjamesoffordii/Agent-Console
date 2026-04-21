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

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type ConsoleOptions = {
  agentStateDir: string;
  issueUrlTemplate?: string;
  rolesFile: string;
  sharedRoot?: string;
  /**
   * Extra roots that may hold `.agent/<role>/state.json` or activity for a
   * role. The snapshot picks whichever location has the most recent state
   * file, so a role window writing to its own worktree still surfaces in a
   * console reading from a shared root (and vice versa).
   */
  fallbackStateRoots?: string[];
};

type RoleEntry = {
  id: string;
  shortId: string;
  displayName: string;
  spawnScript?: string;
  ghConfigDir?: string;
  userDataDir?: string;
  agentFile?: string;
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
  ghAccount: string;
  ghAccountOk: boolean;
  promptOverride: string;
  windowOpen: boolean;
  agentFileOk: boolean;
  agentFileName: string;
  chatState: 'busy' | 'idle' | 'stale' | 'unknown';
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

// ---------------------------------------------------------------------------
// Window + agent-file detection (Windows-only, cached 4s)
// ---------------------------------------------------------------------------

let _windowCache: { at: number; cmdLines: string[] } = { at: 0, cmdLines: [] };
const WINDOW_CACHE_TTL_MS = 4_000;

function listInsidersCmdLines(): string[] {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (now - _windowCache.at < WINDOW_CACHE_TTL_MS) return _windowCache.cmdLines;
  // wmic was removed from Windows 11 24H2+, so we use PowerShell + CIM instead.
  // Filter in the pipeline (not -Filter) to avoid nested-quote escaping issues
  // when execFileSync passes the -Command arg through to PowerShell.
  const ps =
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.Name -eq 'Code - Insiders.exe' } | " +
    "ForEach-Object { $_.CommandLine } | Where-Object { $_ } | " +
    "ForEach-Object { $_ + [char]0 }";
  const tryExec = (exe: string): string | null => {
    try {
      return cp.execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 4_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  const out = tryExec('pwsh') ?? tryExec('powershell');
  if (out === null) {
    _windowCache = { at: now, cmdLines: [] };
    return [];
  }
  const cmdLines = out
    .split('\u0000')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  _windowCache = { at: now, cmdLines };
  return cmdLines;
}

function isWindowOpen(userDataDir?: string): boolean {
  if (!userDataDir) return false;
  const a = userDataDir.replace(/\//g, '\\').toLowerCase();
  const b = userDataDir.replace(/\\/g, '/').toLowerCase();
  return listInsidersCmdLines().some((cmd) => {
    const lc = cmd.toLowerCase();
    return lc.includes(a) || lc.includes(b);
  });
}

function checkAgentFile(repoRoot: string, agentFile?: string): { ok: boolean; name: string } {
  if (!agentFile) return { ok: false, name: '' };
  const full = resolveRepoPath(repoRoot, agentFile);
  return { ok: fs.existsSync(full), name: path.basename(agentFile, path.extname(agentFile)) };
}

function readGhAccount(ghConfigDir?: string): { login: string; ok: boolean } {
  if (!ghConfigDir) return { login: '', ok: false };
  try {
    const hostsFile = path.join(ghConfigDir, 'hosts.yml');
    if (!fs.existsSync(hostsFile)) return { login: '', ok: false };
    const text = fs.readFileSync(hostsFile, 'utf8');
    // naive yaml: find first `user:` line under github.com
    const match = text.match(/user:\s*([^\s\r\n]+)/);
    if (match) return { login: match[1], ok: true };
    return { login: '', ok: false };
  } catch {
    return { login: '', ok: false };
  }
}

function promptOverridePath(repoRoot: string, agentStateDir: string, role: string): string {
  return path.join(repoRoot, agentStateDir, role, 'prompt-override.txt');
}

function readPromptOverride(repoRoot: string, agentStateDir: string, role: string): string {
  try {
    const file = promptOverridePath(repoRoot, agentStateDir, role);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function writePromptOverride(repoRoot: string, agentStateDir: string, role: string, text: string): void {
  const dir = path.join(repoRoot, agentStateDir, role);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = promptOverridePath(repoRoot, agentStateDir, role);
  if (text.trim() === '') {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
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
  // Pick the state root with the freshest state.json for this role, so the
  // console stays correct when role windows write to their own worktrees
  // and the operator dashboard reads from a shared root (or vice versa).
  const candidateRoots = [repoRoot, ...(options.fallbackStateRoots ?? [])].filter(
    (r, i, arr) => !!r && arr.indexOf(r) === i,
  );
  const pickRoot = (): string => {
    let best = repoRoot;
    let bestMtime = -1;
    for (const r of candidateRoots) {
      try {
        const f = path.join(r, options.agentStateDir, role.id, 'state.json');
        const s = fs.statSync(f);
        if (s.mtimeMs > bestMtime) {
          bestMtime = s.mtimeMs;
          best = r;
        }
      } catch {
        // missing file — skip
      }
    }
    return best;
  };
  const stateRoot = pickRoot();

  const heartbeat = readJson<Heartbeat>(path.join(stateRoot, options.agentStateDir, role.id, 'heartbeat.json')) ?? {};
  const state = readJson<LiveStateRead>(path.join(stateRoot, options.agentStateDir, role.id, 'state.json')) ?? {};
  // Partner-Path writes `next-action.json` (not `next-prompt.json`). Read
  // either so the console works against both the Agent Console extension's
  // emissions and the Partner-Path spawn/watchdog harness.
  const nextPromptFallback = readJson<{ prompt?: string; reason?: string; action?: string }>(
    path.join(stateRoot, options.agentStateDir, role.id, 'next-prompt.json'),
  ) ?? readJson<{ prompt?: string; reason?: string; action?: string }>(
    path.join(stateRoot, options.agentStateDir, role.id, 'next-action.json'),
  ) ?? {};
  const control = readControl(stateRoot, options.agentStateDir);
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

  const events = tailActivity(stateRoot, options.agentStateDir, role.id, 5);
  const stopReason = deriveStopReason(events);

  const rateLimit = readJson<RateLimitFile>(path.join(stateRoot, options.agentStateDir, role.id, 'ratelimit.json'));
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

  const ghAcct = readGhAccount(role.ghConfigDir);
  const promptOverride = readPromptOverride(stateRoot, options.agentStateDir, role.id);
  const windowOpen = isWindowOpen(role.userDataDir);
  const agentFileInfo = checkAgentFile(repoRoot, role.agentFile);

  // Role health reflects the operator's real question — "is this agent alive?"
  //   green  = window open AND recent activity
  //   amber  = paused, OR window open but no/stale activity, OR activity
  //            without a detectable window (cross-platform fallback)
  //   red    = window closed and no recent activity
  let health: RowSnapshot['health'] = 'amber';
  const freshActivity = ageSec >= 0 && ageSec <= STALE_SEC;
  if (paused) health = 'amber';
  else if (windowOpen && freshActivity) health = 'green';
  else if (windowOpen) health = 'amber';
  else if (freshActivity) health = 'amber';
  else health = 'red';

  let chatState: RowSnapshot['chatState'] = 'unknown';
  if (ageSec < 0) chatState = 'unknown';
  else if (ageSec <= 30) chatState = 'busy';
  else if (ageSec <= STALE_SEC) chatState = 'idle';
  else chatState = 'stale';

  // Issue number: prefer heartbeat.issue (explicit), then parse branch for a
  // leading numeric segment (Partner-Path convention: feat/pe/123-foo-bar).
  const branchName = state.branch ?? '';
  let issue: number | null = heartbeat.issue ?? null;
  if (issue == null && branchName) {
    const m = branchName.match(/(?:^|[\/_-])(\d{2,6})(?=[-_\/]|$)/);
    if (m) issue = parseInt(m[1], 10);
  }

  // Next-prompt preview: state.json (extension) → next-prompt.json →
  // next-action.json (Partner-Path). Fall back to the prompt-override draft.
  const nextPromptPreview = (
    state.nextPromptPreview ||
    nextPromptFallback.prompt ||
    nextPromptFallback.reason ||
    nextPromptFallback.action ||
    ''
  ).slice(0, 120);

  return {
    role: role.id,
    shortId: role.shortId,
    displayName: role.displayName,
    status: heartbeat.status ?? 'unknown',
    issue,
    branch: branchName,
    lastActivityIso,
    ageSec,
    paused,
    stopReason,
    nextPromptPreview,
    health,
    ghCore,
    ghCoreLevel,
    ghAccount: ghAcct.login,
    ghAccountOk: ghAcct.ok,
    promptOverride,
    windowOpen,
    agentFileOk: agentFileInfo.ok,
    agentFileName: agentFileInfo.name,
    chatState,
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
    const acctDot = row.ghAccountOk ? '<span class="dot green"></span>' : '<span class="dot red"></span>';
    const acctCell = row.ghAccount
      ? `${acctDot}<code>${escapeHtml(row.ghAccount)}</code>`
      : `${acctDot}<small>—</small>`;
    const windowCell = row.windowOpen
      ? '<span class="dot green"></span><strong>Open</strong>'
      : '<span class="dot red"></span><small>Closed</small>';
    const agentCell = row.agentFileOk
      ? `<span class="dot green"></span><code>${escapeHtml(row.agentFileName)}</code>`
      : `<span class="dot red"></span><small>${escapeHtml(row.agentFileName || 'missing')}</small>`;
    const chatLabel = row.paused
      ? 'paused'
      : row.chatState === 'busy' ? 'Busy'
      : row.chatState === 'idle' ? 'Idle'
      : row.chatState === 'stale' ? 'Stale'
      : '—';
    const chatDotClass = row.paused ? 'amber'
      : row.chatState === 'busy' ? 'green'
      : row.chatState === 'idle' ? 'amber'
      : row.chatState === 'stale' ? 'red'
      : 'amber';
    const chatCell = `<span class="dot ${chatDotClass}"></span><strong>${chatLabel}</strong><br/><small>${escapeHtml(ageText)}</small>`;
    const pauseLabel = row.paused ? 'Resume' : 'Pause';
    const pauseAction = row.paused ? 'resume' : 'pause';
    const promptId = `prompt-${row.role}`;
    const promptVal = escapeHtml(row.promptOverride);
    return `<tr>
      <td>${dot}<strong>${escapeHtml(row.shortId)}</strong><br/><small>${escapeHtml(row.displayName)}</small></td>
      <td>${acctCell}</td>
      <td>${windowCell}</td>
      <td>${agentCell}</td>
      <td>${chatCell}</td>
      <td>${issueCell(row.issue, row.role, issueUrlTemplate)}</td>
      <td><code>${escapeHtml(row.branch || '—')}</code></td>
      <td>${ghCell}</td>
      <td><small>${escapeHtml(row.stopReason || '—')}</small></td>
      <td class="prompt-cell">
        <textarea id="${promptId}" data-role="${row.role}" rows="3" placeholder="Type the next prompt for this agent. Leave blank to use the spawn script default.">${promptVal}</textarea>
        <div class="prompt-actions">
          <button data-act="send-prompt" data-role="${row.role}" class="primary" title="Save prompt and spawn/wake the agent (launch Insiders if closed, re-kick chat if open)">Send &amp; Start</button>
          <button data-act="restart" data-role="${row.role}" title="Spawn/wake the agent using the default prompt (ignores the textarea)">Restart (default)</button>
          <button data-act="clear-prompt" data-role="${row.role}" title="Clear saved override">Clear</button>
          <button data-act="${pauseAction}" data-role="${row.role}">${pauseLabel}</button>
        </div>
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
  textarea { width: 100%; min-width: 280px; font-family: var(--vscode-editor-font-family); font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 4px 6px; resize: vertical; box-sizing: border-box; }
  .prompt-cell { min-width: 320px; width: 40%; }
  .prompt-actions { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .prompt-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; font-weight: 600; }
  .prompt-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<h1>${PANEL_TITLE}</h1>
<table>
  <thead>
    <tr><th>Role</th><th>GH Account</th><th>Window</th><th>Custom Agent</th><th>Chat</th><th>Issue</th><th>Branch</th><th>GH (core)</th><th>Stop Reason</th><th>Next Prompt &amp; Controls</th></tr>
  </thead>
  <tbody>${body || '<tr><td colspan="10">No roles registered.</td></tr>'}</tbody>
</table>
<div class="footer">Auto-refresh every 5s · ${escapeHtml(new Date().toISOString())}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || {};
  const drafts = state.drafts || {};

  // Restore any in-progress textarea drafts after an auto-refresh replaced the
  // HTML. Draft (what the user was typing) always beats the server-rendered
  // persisted override, because the user hasn't hit Send yet.
  document.querySelectorAll('textarea[data-role]').forEach((ta) => {
    const role = ta.getAttribute('data-role');
    if (drafts[role] !== undefined && drafts[role] !== null) {
      ta.value = drafts[role];
    }
  });

  const saveDraft = (role, value) => {
    const s = vscode.getState() || {};
    s.drafts = s.drafts || {};
    if (value === '' || value == null) delete s.drafts[role];
    else s.drafts[role] = value;
    vscode.setState(s);
  };

  document.body.addEventListener('input', (event) => {
    const ta = event.target.closest && event.target.closest('textarea[data-role]');
    if (!ta) return;
    saveDraft(ta.getAttribute('data-role'), ta.value);
  });

  // Tell the host to pause the 5s re-render while the user is typing, so the
  // textarea isn't yanked out from under the caret.
  document.body.addEventListener('focusin', (event) => {
    const ta = event.target.closest && event.target.closest('textarea[data-role]');
    if (!ta) return;
    vscode.postMessage({ act: 'focus', role: ta.getAttribute('data-role') });
  });
  document.body.addEventListener('focusout', (event) => {
    const ta = event.target.closest && event.target.closest('textarea[data-role]');
    if (!ta) return;
    vscode.postMessage({ act: 'blur', role: ta.getAttribute('data-role') });
  });

  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    event.preventDefault();
    const act = button.getAttribute('data-act');
    const role = button.getAttribute('data-role');
    const issue = button.getAttribute('data-issue');
    let prompt;
    if (role) {
      const ta = document.getElementById('prompt-' + role);
      if (ta) prompt = ta.value;
    }
    // Once the user commits (send/clear/restart) the draft is no longer
    // in-flight — drop it so the server-rendered value wins on next refresh.
    if (role && (act === 'send-prompt' || act === 'clear-prompt' || act === 'restart')) {
      saveDraft(role, '');
    }
    vscode.postMessage({ act, role, issue, prompt });
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

  // Track which role's textarea (if any) has focus. While a textarea is
  // focused we skip the periodic full-HTML refresh so the caret/selection
  // isn't destroyed while the user is typing the next prompt.
  const focusedRoles = new Set<string>();

  const refresh = () => {
    if (focusedRoles.size > 0) return;
    const roles = readRoles(repoRoot, options.rolesFile);
    const rows = roles.map((role) => snapshot(repoRoot, role, options));
    panel.webview.html = renderHtml(rows, createNonce(), options.issueUrlTemplate);
  };

  refresh();
  const handle = setInterval(refresh, POLL_MS);
  panel.onDidDispose(() => clearInterval(handle), null, context.subscriptions);
  panel.webview.onDidReceiveMessage((msg: { act: string; role: string; issue?: string; prompt?: string }) => {
    if (msg.act === 'focus' && msg.role) {
      focusedRoles.add(msg.role);
      return;
    }
    if (msg.act === 'blur' && msg.role) {
      focusedRoles.delete(msg.role);
      // Refresh once the user leaves the textarea so data catches up.
      refresh();
      return;
    }
    void handleAction(repoRoot, options, msg, refresh);
  });

  return panel;
}

async function handleAction(
  repoRoot: string,
  options: ConsoleOptions,
  msg: { act: string; role: string; issue?: string; prompt?: string },
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
    case 'clear-prompt': {
      writePromptOverride(repoRoot, options.agentStateDir, msg.role, '');
      refresh();
      return;
    }
    case 'send-prompt':
    case 'restart': {
      const roles = readRoles(repoRoot, options.rolesFile);
      const role = roles.find((entry) => entry.id === msg.role);
      if (!role?.spawnScript) {
        await vscode.window.showWarningMessage(`No spawnScript registered for ${msg.role}`);
        return;
      }
      // send-prompt: persist whatever is in the textarea as the one-shot override.
      // restart (default): explicitly clear any override so the spawn script falls back to its built-in prompt.
      if (msg.act === 'send-prompt' && typeof msg.prompt === 'string') {
        writePromptOverride(repoRoot, options.agentStateDir, msg.role, msg.prompt);
      } else if (msg.act === 'restart') {
        writePromptOverride(repoRoot, options.agentStateDir, msg.role, '');
      }
      const script = resolveRepoPath(repoRoot, role.spawnScript);
      // Smart spawn: the script itself decides whether to open a new Insiders
      // window or just re-kick chat in the existing one.
      const terminal = vscode.window.createTerminal({ name: `${role.shortId} ${msg.act}`, cwd: repoRoot });
      terminal.sendText(`pwsh -NoProfile -File "${script}"`);
      terminal.show();
      refresh();
      return;
    }
  }
}
