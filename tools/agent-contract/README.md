# Agent Contract (PowerShell)

Reusable producer-side helpers for the JSON bus that the **Agent Console** VS
Code extension consumes. Drop this folder into any repo that wants to drive
agents with Agent Console.

## Install

Copy `agent-contract.psm1` into your repo (for example `tools/agent-contract/`)
or reference it from your own scripts:

```powershell
Import-Module "$repoRoot/tools/agent-contract/agent-contract.psm1"
```

## Commands

### `Write-AgentKickoff`

Writes `<AgentStateDir>/<Role>/kickoff.json`. When the file's mtime advances,
the Agent Console extension opens Copilot Chat and injects the `Prompt` value.

```powershell
Write-AgentKickoff `
    -RepoRoot $repo `
    -Role "SeniorEngineerAgent" `
    -Reason "manual-spawn" `
    -Prompt "Start the next slice."
```

### `Write-AgentNextPrompt`

Publishes the prompt the orchestrator intends to send next. Surfaced in the
operator console for visibility before the action fires.

### `Write-AgentNextAction`

Publishes the planned next action (`poke` | `spawn` | `hard-restart` | `none`)
and an optional reason / planned-at epoch.

## Configuration

All writers default to `AgentStateDir = .agent`. Override via `-AgentStateDir`
if the consuming extension is configured differently (`agentConsole.agentStateDir`
in VS Code settings).

## Payload schema (version 1)

```jsonc
{
    "role": "SeniorEngineerAgent",
    "ts": "2026-04-21T01:49:00.000Z",
    "epoch": 1776727740,
    "reason": "respawn-stale-heartbeat",
    "prompt": "Optional override prompt",
    "version": 1
}
```

Payloads with `version !== 1` are ignored by the extension with a status-bar
warning so new fields can be added without breaking older consumers.
