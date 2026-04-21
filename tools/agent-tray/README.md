# Agent Console — Windows Tray

A system-tray icon that shows aggregated agent health and exposes quick
actions via right-click menu. Pairs with the **Agent Console** VS Code
extension; health is derived from `<AgentStateDir>/<role>/heartbeat.json`
files written by the repo's own watchdog/orchestrator.

## Health colors

- **green** — every registered role's heartbeat refreshed within `-StaleSec`
- **amber** — at least one role stale OR no roles registered yet
- **red** — heartbeat reader failed entirely

## Right-click menu

- Per-role status header (read-only)
- Open Agent Console (invokes VS Code's `agentConsole.openConsole`)
- Pause All / Resume All (if `-AgentControlScript` is provided)
- Spawn / Poke submenus per role (if `-SpawnScripts` is provided)
- Orchestrator Log
- Quit

## Usage

Headless launch (put this in a Startup shortcut):

```powershell
pwsh -NoProfile -WindowStyle Hidden -File .\agent-tray.ps1 `
    -RepoRoot 'C:/path/to/repo' `
    -Roles PrincipalEngineerAgent,SeniorEngineerAgent `
    -SpawnScripts @{
        PrincipalEngineerAgent = 'scripts/spawn-pe.ps1'
        SeniorEngineerAgent    = 'scripts/spawn-se.ps1'
    } `
    -AgentControlScript 'scripts/agent.ps1'
```

Or use the installer to create a Windows Startup shortcut:

```powershell
pwsh -NoProfile -File .\install-tray.ps1 -RepoRoot 'C:/path/to/repo' -Roles ...
```

Uninstall:

```powershell
pwsh -NoProfile -File .\install-tray.ps1 -Uninstall
```

## Notes

- Health reads are direct file reads of `heartbeat.json`. The tray never
  spawns another PowerShell process on the poll path.
- Uses `pwsh.exe` for all action shells; silently no-ops the action if the
  target script is missing.
- Pure `System.Windows.Forms.NotifyIcon` — no native dependencies.
- Repo-agnostic: all repo-specific paths (spawn scripts, agent controller,
  roles) are parameters.
