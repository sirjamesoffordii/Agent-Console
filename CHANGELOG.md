# Change Log

All notable changes to the **Agent Console** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
