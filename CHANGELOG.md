# Change Log

All notable changes to the **Agent Console** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13] - 2026-04-22

### Added
- **Activity log rotation**: `activity.jsonl` now rotates to `activity.jsonl.1` at 2 MiB so long-running agents don't let the file grow unbounded. The extension keeps exactly one archive — enough context for the stop-reason classifier, bounded on disk.
- **Stop-reason severity pills**: each row now renders a colored pill (`LEGIT` green / `ERROR` red / `EARLY` amber / `STALE` grey) next to the reason, and a `[error]` or `[early]` classification forces the health dot to red even when the chat window is still open. An abandoned or crashed turn is no longer invisible behind a green dot.
- **Global Pause All / Resume All**: kill-switch buttons in the console toolbar that toggle `paused` for every role in `roles.json` with a single `agent-control.json` write.
- **`ac` CLI** (`bin/ac.cjs`, wired via `package.json` `bin`): cross-platform operator control without needing VS Code. Commands: `status` (table + `--json`), `pause` / `resume` / `pause-all` / `resume-all`, `spawn` / `poke`, `prompt` / `clear-prompt`, `tail`. ShortId aliases are accepted everywhere a role id is expected.
- **Daily metrics rollup**: `scripts/metrics-rollup.ps1` reads each role's `activity.jsonl` over a configurable window (default 24h) and emits `<role>/metrics-daily.json` with per-event-type counts and the most recent error — the foundation for "PE error rate tripled today" alerts.
- **CI matrix**: the existing `windows-latest` CI job is now a matrix over `windows-latest` + `ubuntu-latest`, and adds lanes for the new CLI tests and metrics-rollup tests. The VSIX packaging job is split off into a Windows-only downstream job.

### Changed
- `npm test` now chains all four suites: extension integration, PS contract, CLI (`tests/cli.test.mjs`), and metrics rollup (`tests/metrics-rollup.tests.ps1`). Current totals: **66 + 22 + 34 + 14 = 136 tests**, all green.

## [0.1.12] - 2026-04-22

### Added
- **Role registry**: canonical `.github/agents/roles.json` + `roles.schema.json` covering the four persistent roles (Principal Engineer, Senior Engineer, Quality Assurance, Product Design). Adding a new role is now a pure JSON edit.
- **Role instruction files**: `.github/agents/principal-engineer.agent.md`, `senior-engineer.agent.md`, `product-design.agent.md`, `quality-assurance-agent.agent.md`.
- **Spawn scripts**: `scripts/spawn-common.ps1` plus per-role stubs (`spawn-pe.ps1`, `spawn-se.ps1`, `spawn-qa.ps1`, `spawn-pd.ps1`) that honor `prompt-override.txt` and relaunch the role's VS Code window with the correct `--user-data-dir`.
- **Telemetry writer**: `scripts/telemetry-ratelimit.ps1` pulls `gh api rate_limit` per role and emits the `ratelimit.json` + `usage.json` files the console consumes.
- **Respawn scheduler**: `scripts/schedule-next-action.ps1` reads each role's cadence (`continuous`, `scheduled:daily`, `scheduled:persona-rotation`, etc.) and writes `next-prompt.json` + `next-action.json` with a planned ETA epoch.

### Changed
- **Stop-reason classifier**: `deriveStopReason` now prefixes every reason with a structured tag: `[legit]`, `[error]`, `[early]` (chat turn started with no follow-through), or `[stale]`. Operators can now tell legitimate stopping points apart from early abandonment at a glance.

## [0.1.11] - 2026-04-21

### Changed
- Renamed the primary action button from `Send & Start` to `Send`. Behavior is unchanged — it still persists the textarea as a one-shot prompt override and spawns/wakes the agent.

### Added
- New `Auto Send` toggle button per role. When ON and the role's chat goes **Stale** (no activity for > 3 min), the console automatically re-fires the spawn script so the persisted prompt override gets delivered again. Respects Pause, skips empty prompts, and has a 2-minute per-role cooldown so a persistently stale chat isn't re-kicked every poll.

## [0.1.10] - 2026-04-21

### Fixed
- Agent Console now prefers stable spawn wrappers from `~/AgentTools` (or `AGENT_CONSOLE_TOOLS_DIR`) before falling back to repo-local `spawnScript` paths. This makes `Send & Start` resilient to repo branch switches and old worktrees that don't carry the latest agent-launch fixes.

## [0.1.9] - 2026-04-21

### Fixed
- Windows: the PowerShell window-detection probe no longer flashes a console window on every refresh. Added `windowsHide: true` to the `execFileSync` call and bumped the window-cache TTL from 4s to 12s so the probe runs at most every ~12s instead of every poll.

## [0.1.8] - 2026-04-21

### Fixed
- Webview: typing in the "Next Prompt" textarea no longer disappears on the 5s auto-refresh. Drafts are now persisted via `vscode.setState` and the periodic full-HTML refresh is paused while any textarea is focused.

## [0.1.0] - 2026-04-20

### Added
- Initial release of Agent Console as a standalone extension, extracted from Partner Path.
- Kickoff watcher: polls `<agentStateDir>/<role>/kickoff.json` every 5s and opens Copilot Chat with the payload prompt when a fresh kickoff arrives.
- Activity emitter: writes `state.json` and appends to `activity.jsonl` on task and terminal events.
- Operator console webview (`Agent Console: Open Console`) aggregating per-role status, issue, branch, last activity, GitHub rate limits, stop reason, and next-prompt preview.
- Pause / Resume / Poke / Restart actions per role via `agent-control.json` and optional `spawnScript`.
- Configuration: `agentConsole.role`, `agentConsole.agentStateDir`, `agentConsole.rolesFile`, `agentConsole.issueUrlTemplate`.
- Role detection fallbacks: `AGENT_CONSOLE_ROLE`, legacy `PARTNER_PATH_ROLE`, and inference from `roles.json` `userDataDir` leaf names.
