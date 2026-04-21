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

## Install

- **From GitHub Release** — grab `agent-console.vsix` from the [Releases page](https://github.com/sirjamesoffordii/Agent-Console/releases) and install via Extensions panel -> `...` -> **Install from VSIX**, or:

  ```powershell
  code-insiders --install-extension agent-console.vsix --force
  ```

- **From Marketplace** — once published: search "Agent Console" in the Extensions panel, or `code --install-extension sirjamesoffordii.agent-console`.

## Publishing (maintainer notes)

Automated via `.github/workflows/publish.yml`:

1. Create an Azure DevOps PAT with **Marketplace: Manage** scope at https://dev.azure.com.
2. Add it as a repo secret named `VSCE_PAT` (Settings -> Secrets and variables -> Actions).
3. Optional: add `OVSX_PAT` for Open VSX.
4. Push a `v*` tag or run the `Publish` workflow via `workflow_dispatch`.

Manual fallback:

```powershell
npx @vscode/vsce login sirjamesoffordii   # paste PAT once
npm run publish
```
