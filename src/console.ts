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
type AgentControl = { paused?: Record<string, boolean>; autoSend?: Record<string, boolean> };
type RateBucket = { limit?: number; remaining?: number; reset?: number };
type RateLimitFile = {
  ts?: string;
  ok?: boolean;
  error?: string;
  resources?: { core?: RateBucket; search?: RateBucket; graphql?: RateBucket };
};

type EditorWindowInfo = {
  name: string;
  commandLine: string;
  mainWindowTitle: string;
};

function stableAgentToolsDir(): string | undefined {
  const explicit = (process.env.AGENT_CONSOLE_TOOLS_DIR ?? '').trim();
  if (explicit.length > 0) return explicit;
  const home = (process.env.USERPROFILE ?? process.env.HOME ?? '').trim();
  if (home.length === 0) return undefined;
  return path.join(home, 'AgentTools');
}

function resolveSpawnScriptPath(repoRoot: string, role: RoleEntry): string | undefined {
  const toolsDir = stableAgentToolsDir();
  if (toolsDir) {
    const candidates = [
      role.shortId ? `spawn-${role.shortId.toLowerCase()}.ps1` : '',
      `spawn-${role.id.toLowerCase()}.ps1`,
    ].filter((name) => name.length > 0);
    for (const candidate of candidates) {
      const file = path.join(toolsDir, candidate);
      if (fs.existsSync(file)) return file;
    }
  }
  if (!role.spawnScript) return undefined;
  return resolveRepoPath(repoRoot, role.spawnScript);
}

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
  autoSend: boolean;
  stopReason: string;
  stopReasonSeverity: 'legit' | 'error' | 'early' | 'stale' | 'unknown';
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

let _windowCache: { at: number; windows: EditorWindowInfo[] } = { at: 0, windows: [] };
// Cache the window list for longer than the 5s UI refresh so we only shell
// out to PowerShell once every ~2-3 polls. The data changes slowly (windows
// opening/closing), so a stale read is fine and it keeps background CPU down.
const WINDOW_CACHE_TTL_MS = 12_000;

function normalizeWindowText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildWindowMatchNeedles(role: RoleEntry): string[] {
  const values = new Set<string>();
  const add = (value?: string) => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) return;
    values.add(trimmed.toLowerCase());
    const normalized = normalizeWindowText(trimmed);
    if (normalized.length >= 5) values.add(normalized);
  };

  add(role.userDataDir);
  if (role.userDataDir) add(path.basename(role.userDataDir));
  add(role.id);
  add(role.displayName);
  if (role.agentFile) add(path.basename(role.agentFile, path.extname(role.agentFile)));

  return [...values];
}

function matchesRoleWindow(role: RoleEntry, window: EditorWindowInfo): boolean {
  const haystack = `${window.commandLine}\n${window.mainWindowTitle}`.toLowerCase();
  const normalizedHaystack = normalizeWindowText(haystack);
  return buildWindowMatchNeedles(role).some((needle) => {
    if (needle.length >= 3 && haystack.includes(needle)) return true;
    return needle.length >= 5 && normalizedHaystack.includes(needle);
  });
}

function listEditorWindows(): EditorWindowInfo[] {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (now - _windowCache.at < WINDOW_CACHE_TTL_MS) return _windowCache.windows;
  // wmic was removed from Windows 11 24H2+, so we use PowerShell + CIM instead.
  // Scan only top-level editor processes (no `--type=...` helpers), then join
  // to Get-Process for the visible window title. That lets us recognize windows
  // that do not advertise a dedicated `--user-data-dir` but do expose the role
  // or custom agent name in their title.
  const ps =
    "$editorNames = @('Code - Insiders.exe', 'Code.exe', 'Cursor.exe', 'Code - OSS.exe'); " +
    "@(" +
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $editorNames -contains $_.Name -and $_.CommandLine -and $_.CommandLine -notmatch ' --type=' } | " +
    "ForEach-Object { " +
    "  $title = ''; " +
    "  try { $title = (Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowTitle } catch { } " +
    "  [pscustomobject]@{ Name = $_.Name; CommandLine = $_.CommandLine; MainWindowTitle = $title } " +
    "}) | ConvertTo-Json -Compress";
  const tryExec = (exe: string): string | null => {
    try {
      return cp.execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 4_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Without this, each invocation flashes a conhost/PowerShell window
        // on top of the user's screen every refresh cycle.
        windowsHide: true,
      });
    } catch {
      return null;
    }
  };
  const out = tryExec('pwsh') ?? tryExec('powershell');
  if (out === null) {
    _windowCache = { at: now, windows: [] };
    return [];
  }
  try {
    const parsed = JSON.parse(out) as EditorWindowInfo | EditorWindowInfo[] | null;
    const windows = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter((entry) =>
      !!entry && typeof entry.commandLine === 'string' && typeof entry.mainWindowTitle === 'string',
    );
    _windowCache = { at: now, windows };
    return windows;
  } catch {
    _windowCache = { at: now, windows: [] };
    return [];
  }
}

function isWindowOpen(role: RoleEntry): boolean {
  return listEditorWindows().some((window) => matchesRoleWindow(role, window));
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

/**
 * Classify why an agent is idle/stopped so the operator can tell the
 * difference between "legitimately waiting" (green/amber) and
 * "abandoned mid-turn" (red).
 *
 * Returned string is always prefixed with one of:
 *   [legit]  — a clean stopping point (awaiting input, PR opened, paused)
 *   [error]  — a recorded error event
 *   [early]  — chat turn started but no tool/command follow-through
 *   [stale]  — activity file has no events at all
 *
 * Callers treat the prefix as a structured signal; the tail is human prose.
 */
function deriveStopReason(events: ActivityLine[]): string {
  if (events.length === 0) return '[stale] no activity recorded';

  const errors = events.filter((event) => event.type === 'error');
  if (errors.length > 0) {
    const last = errors[errors.length - 1];
    return `[error] ${(last.summary ?? 'error').slice(0, 80)}`;
  }

  const last = events[events.length - 1];
  const lastSummary = (last.summary ?? '').toLowerCase();
  const lastType = last.type ?? '?';

  // Legitimate stopping points — these are signals the agent intentionally
  // yielded rather than crashed.
  const legitimateMarkers = [
    'task_complete',
    'awaiting',
    'waiting for',
    'pr opened',
    'pr merged',
    'paused',
    'no-op',
    'nothing to do',
    'idle',
  ];
  if (legitimateMarkers.some((marker) => lastSummary.includes(marker))) {
    return `[legit] ${lastType}: ${last.summary ?? ''}`.slice(0, 80);
  }

  // Early-abandon heuristic: a chat turn started but never produced any
  // tool call, task run, or turn-end event. That matches the "agent stopped
  // responding mid-stream" pattern the operator needs to notice.
  const startedTurn = events.find((event) => event.type === 'chat.turn.start');
  const followThrough = events.some((event) =>
    event.type === 'chat.turn.end' ||
    event.type === 'tool.call' ||
    event.type === 'command.run',
  );
  if (startedTurn && !followThrough) {
    return `[early] chat turn started, no follow-through (${(startedTurn.summary ?? '').slice(0, 40)})`;
  }

  // Fall through: just surface the last event as best effort. If it names a
  // terminal command or tool call, prefix [legit] since the agent made it
  // past the "started turn, vanished" signature.
  const tail = `${lastType}: ${last.summary ?? ''}`.slice(0, 80);
  return followThrough ? `[legit] ${tail}` : tail;
}

/**
 * Read the `[legit] / [error] / [early] / [stale]` prefix that
 * `deriveStopReason` emits back out into a structured severity level. Callers
 * use this both to color the stop-reason pill in the webview and to escalate
 * role health when the classifier flags real trouble.
 */
function classifyStopReasonSeverity(stopReason: string): RowSnapshot['stopReasonSeverity'] {
  if (stopReason.startsWith('[error]')) return 'error';
  if (stopReason.startsWith('[early]')) return 'early';
  if (stopReason.startsWith('[legit]')) return 'legit';
  if (stopReason.startsWith('[stale]')) return 'stale';
  return 'unknown';
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
  const autoSend = !!control.autoSend?.[role.id];

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
  const stopReasonSeverity = classifyStopReasonSeverity(stopReason);

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
  const windowOpen = isWindowOpen(role);
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

  // Severity escalation: if the latest classified stop-reason says the agent
  // errored or early-abandoned, force health to red even if the window is
  // still open. Operators must notice these; they don't self-heal.
  if (!paused && (stopReasonSeverity === 'error' || stopReasonSeverity === 'early')) {
    health = 'red';
  }

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
    autoSend,
    stopReason,
    stopReasonSeverity,
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
    const autoSendLabel = row.autoSend ? 'Auto Send: ON' : 'Auto Send: OFF';
    const autoSendClass = row.autoSend ? ' class="primary"' : '';
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
      <td><span class="stop-pill stop-${row.stopReasonSeverity}">${escapeHtml(row.stopReasonSeverity)}</span> <small>${escapeHtml(row.stopReason || '—')}</small></td>
      <td class="prompt-cell">
        <textarea id="${promptId}" data-role="${row.role}" rows="3" placeholder="Type the next prompt for this agent. Leave blank to use the spawn script default.">${promptVal}</textarea>
        <div class="prompt-actions">
          <button data-act="send-prompt" data-role="${row.role}" class="primary" title="Save prompt and spawn/wake the agent (launch Insiders if closed, re-kick chat if open)">Send</button>
          <button data-act="toggle-auto-send" data-role="${row.role}"${autoSendClass} title="When ON, auto-send the textbox prompt whenever this agent's chat goes Stale (respects Pause)">${autoSendLabel}</button>
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
  .stop-pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 700; margin-right: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stop-pill.stop-legit   { background: rgba(76, 175, 80, 0.2);  color: #4caf50; }
  .stop-pill.stop-error   { background: rgba(244, 67, 54, 0.25); color: #f44336; }
  .stop-pill.stop-early   { background: rgba(255, 152, 0, 0.25); color: #ff9800; }
  .stop-pill.stop-stale   { background: rgba(158, 158, 158, 0.2); color: #9e9e9e; }
  .stop-pill.stop-unknown { background: rgba(158, 158, 158, 0.15); color: #bdbdbd; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; padding: 6px 8px; background: var(--vscode-editorWidget-background, rgba(255,255,255,0.03)); border: 1px solid var(--vscode-widget-border, #444); border-radius: 4px; }
  .toolbar .spacer { flex: 1; }
  .toolbar .danger { background: rgba(244, 67, 54, 0.15); color: #f44336; border: 1px solid rgba(244, 67, 54, 0.4); }
</style>
</head>
<body>
<h1>${PANEL_TITLE}</h1>
<div class="toolbar">
  <button data-act="pause-all" class="danger" title="Pause every registered role (writes agent-control.json)">Pause All</button>
  <button data-act="resume-all" title="Resume every registered role">Resume All</button>
  <span class="spacer"></span>
  <small>${rows.length} role${rows.length === 1 ? '' : 's'} registered</small>
</div>
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

  // Per-role cooldown for Auto Send so a persistently-stale chat doesn't
  // get re-kicked every 5s. Stores epoch-ms of the last auto-fire.
  const lastAutoSendAt = new Map<string, number>();
  const AUTO_SEND_COOLDOWN_MS = 120_000;

  const fireSpawn = (roleId: string): void => {
    const roles = readRoles(repoRoot, options.rolesFile);
    const role = roles.find((entry) => entry.id === roleId);
    if (!role) return;
    const script = resolveSpawnScriptPath(repoRoot, role);
    if (!script) return;
    const terminalName = role.shortId ? `${role.shortId} auto-send` : `${roleId} auto-send`;
    const terminal = vscode.window.createTerminal({ name: terminalName, cwd: repoRoot });
    terminal.sendText(`pwsh -NoProfile -File "${script}"`);
    // Don't steal focus for auto-fires.
  };

  const refresh = () => {
    const roles = readRoles(repoRoot, options.rolesFile);
    const rows = roles.map((role) => snapshot(repoRoot, role, options));

    // Auto Send: for any role with autoSend ON, not paused, chat stale, and a
    // non-empty persisted prompt override, fire the spawn script. Respect a
    // per-role cooldown so we don't re-kick every poll.
    const now = Date.now();
    for (const row of rows) {
      if (!row.autoSend) continue;
      if (row.paused) continue;
      if (row.chatState !== 'stale') continue;
      if (row.promptOverride.trim().length === 0) continue;
      const last = lastAutoSendAt.get(row.role) ?? 0;
      if (now - last < AUTO_SEND_COOLDOWN_MS) continue;
      lastAutoSendAt.set(row.role, now);
      fireSpawn(row.role);
    }

    if (focusedRoles.size > 0) return;
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
  if (!msg.act) return;

  // Global kill-switch actions operate on every registered role in one write.
  if (msg.act === 'pause-all' || msg.act === 'resume-all') {
    const control = readControl(repoRoot, options.agentStateDir);
    const roles = readRoles(repoRoot, options.rolesFile);
    if (msg.act === 'pause-all') {
      control.paused = control.paused ?? {};
      for (const r of roles) control.paused[r.id] = true;
    } else {
      control.paused = {};
    }
    writeControl(repoRoot, options.agentStateDir, control);
    refresh();
    return;
  }

  if (!msg.role) return;

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
    case 'toggle-auto-send': {
      const control = readControl(repoRoot, options.agentStateDir);
      control.autoSend = control.autoSend ?? {};
      const next = !control.autoSend[msg.role];
      if (next) control.autoSend[msg.role] = true;
      else delete control.autoSend[msg.role];
      writeControl(repoRoot, options.agentStateDir, control);
      // Persist whatever is currently in the textarea so auto-send has something to send.
      if (typeof msg.prompt === 'string' && msg.prompt.trim().length > 0) {
        writePromptOverride(repoRoot, options.agentStateDir, msg.role, msg.prompt);
      }
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
      const script = role ? resolveSpawnScriptPath(repoRoot, role) : undefined;
      if (!script) {
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
      // Smart spawn: the script itself decides whether to open a new Insiders
      // window or just re-kick chat in the existing one.
      const terminalName = role?.shortId ? `${role.shortId} ${msg.act}` : `${msg.role} ${msg.act}`;
      const terminal = vscode.window.createTerminal({ name: terminalName, cwd: repoRoot });
      terminal.sendText(`pwsh -NoProfile -File "${script}"`);
      terminal.show();
      refresh();
      return;
    }
  }
}

export const __test = {
  buildWindowMatchNeedles,
  matchesRoleWindow,
  normalizeWindowText,
  deriveStopReason,
  classifyStopReasonSeverity,
};
