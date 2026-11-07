# Repository Guidelines

## Project Structure & Module Organization

This local Codex allowance monitor uses Node.js ES modules and a native Windows WPF widget.

- `widget.ps1` and `widget.xaml`: widget lifecycle, settings, layout, and rendering.
- `usage-worker.mjs`: private JSON pipe, polling, and refresh commands.
- `usage.mjs`: live usage retrieval, normalization, caching, and local session fallback.
- `WidgetLauncher.cs` and `build-launcher.ps1`: source and build script for `Codex Widget.exe`.
- `startup.ps1`: per-user Windows startup registration.
- `tests/usage.test.mjs`: automated usage-data tests.
- `screenshots/`: widget visual references.
- `README.md`: setup and behavior; `DESIGN.md`: visual direction.

## Build, Test, and Development Commands

Use Windows PowerShell 5.1 with WPF and Node.js 22 or newer. No dependency installation is required; the native launcher is included.

- `npm start`: open `Codex Widget.exe`; quit through the widget menu or close button.
- `npm test`: run all `tests/*.test.mjs` using Node's built-in test runner.
- Double-click `Codex Widget.exe`, `Start Widget.cmd`, or `Start Usage UI.cmd` to launch the widget.
- `npm run startup:enable` / `npm run startup:disable`: manage startup for the current Windows account.
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1`: rebuild the launcher.

## Coding Style & Naming Conventions

Match existing JavaScript: two-space indentation, semicolons, single-quoted strings, and `const` unless reassignment is needed. Use camelCase for functions and variables, `.mjs` for server modules, and `node:` imports for Node built-ins. Keep the widget and Node reader dependency-free. No formatter or linter is configured.

Follow `DESIGN.md` for colors, typography, responsive layout, and explicit freshness labels. Preserve accessible meter labels and unknown-value states.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name test files `*.test.mjs` under `tests/` and give tests descriptive behavior-based names. Use synthetic records, fixed timestamps, and temporary directories; clean up fixtures afterward.

Run `npm test` for logic changes. Cover normalization, expired resets, and fallback selection when changing those paths. No coverage threshold is configured. For widget changes, render synthetic previews using `widget.ps1 -PreviewPath <path> -PreviewState <state>` and inspect live, stale, unknown, expired, zero, and full states.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout. Use concise, imperative commit subjects, such as `Fix expired allowance display`. Describe the behavior change, validation performed, and related issues in pull requests. Include screenshots for visual changes.

## Security & Configuration

Keep allowance transport on the private parent/child pipe; no HTTP server or listening network port is needed. Read authentication from the existing Codex home (`CODEX_HOME` or the default `.codex` directory). Never commit credentials or expose tokens, chat contents, or session filenames through widget output or diagnostics. Passed reset times must remain unknown until confirmed by a new reading.
