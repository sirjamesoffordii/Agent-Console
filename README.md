# Agent Console

Standalone VS Code companion extension for local coding agents.

It does three things:

- watches `<agentStateDir>/<role>/kickoff.json` and opens Copilot Chat when a fresh kickoff arrives
- emits lightweight live activity to `<agentStateDir>/<role>/state.json` and `activity.jsonl`
- exposes an operator webview for pause, resume, poke, restart, and quick state inspection across all roles

The extension is intentionally repo-agnostic. It assumes only:

- a shared agent state directory, default `.agent`
- a roles manifest, default `.github/agents/roles.json`
- optional `spawnScript` fields in the roles manifest for `Poke` and `Restart` actions

## Configuration

These settings can be defined in workspace settings:

```jsonc
{
	"agentConsole.role": "SeniorEngineerAgent",
	"agentConsole.agentStateDir": ".agent",
	"agentConsole.rolesFile": ".github/agents/roles.json",
	"agentConsole.issueUrlTemplate": "https://github.com/owner/repo/issues/{issue}"
}
```

Role detection order:

1. `agentConsole.role`
2. `AGENT_CONSOLE_ROLE` environment variable
3. legacy `PARTNER_PATH_ROLE` environment variable
4. inferred from `roles.json` `userDataDir` leaf names found in the current VS Code process arguments

## Expected kickoff schema

```jsonc
{
	"role": "SeniorEngineerAgent",
	"ts": "2026-04-20T23:20:00.000Z",
	"epoch": 1776727200,
	"reason": "respawn-stale-heartbeat",
	"version": 1,
	"prompt": "Optional override prompt",
	"mode": "Optional chat mode hint"
}
```

Payloads with `version !== 1` are ignored with a status-bar warning.

## Development

```powershell
npm install
npm run build
```

To package a `.vsix`:

```powershell
npm run package
```
