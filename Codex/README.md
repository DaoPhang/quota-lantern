# Codex usage widget

A compact native Windows desktop widget with circular meters for your **5-hour** and **1-week** Codex allowances, percentages remaining, and reset countdowns. Inspired by [this circular usage widget](https://www.reddit.com/r/codex/comments/1tfb3mk/i_used_codex_from_my_iphone_to_build_a_codex/).

## Open the widget

Requires Windows, Windows PowerShell 5.1 (included with Windows), and Node.js 22 or newer on PATH. No npm packages, API key, browser, or HTTP server are needed.

Build the launcher once from this folder with `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1`. That creates **Codex Widget.exe** beside the project files. Then double-click **Codex Widget.exe** or run `npm start`. **Start Widget.cmd** and the previous **Start Usage UI.cmd** also open the native widget once it is built. Keep the executable beside `widget.ps1` and the other project files. Only one widget instance runs at a time. The widget stays on top by default; change this in its options menu.

- Drag the Codex header to move it. Position is saved in `widget-settings.json`.
- Click the refresh arrow or press F5 to update. Automatic refresh runs every 30 seconds.
- Open **...** for **Always on top**, **Start with Windows**, and **Quit**.
- Click the close button or press Escape to quit; the private Node reader also exits.
- Hover over reset countdowns for the exact local reset time, or the widget for freshness and any retrieval notice.

## Start automatically

Double-click **Enable Startup.cmd** once from your normal Windows session. It registers the widget for your account at Windows sign-in, without opening a terminal or browser. No administrator access is needed. Keep this folder in its current location; rerun the launcher after moving it.

Alternatively run `npm run startup:enable`. Disable through the widget menu or `npm run startup:disable`. Inspect registration with `powershell -NoProfile -File .\startup.ps1 -Status`.

Startup uses the `CodexUsageWidget` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. If an agent or managed environment denies registry writes, run **Enable Startup.cmd** yourself outside that environment. The native launcher hides the console and uses a process-only execution-policy option; it does not change the system execution policy. Rebuild it from `WidgetLauncher.cs` with `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1` if needed.

## Data and privacy

The reader uses the existing Codex login in `%USERPROFILE%\.codex\auth.json`, or `CODEX_HOME` if set, for a read-only request to the Codex account usage endpoint. It falls back to recent local Codex allowance events when live data is unavailable. Tokens and chat content never reach the UI. Allowance data travels through a private parent/child pipe; nothing listens on a network port.

Green status means fresh live account data. **Last known data** identifies fallback or stale observations; **--** means unknown. A passed reset never invents a return to 100%. Sign in again through Codex if the login expires. Subscription limits may be unavailable for API-key-only accounts. The usage endpoint is not a versioned public API.

## Development and validation

- `widget.xaml`: WPF layout and styling.
- `widget.ps1`: rings, freshness, settings, and child-process lifecycle.
- `usage-worker.mjs`: private JSON pipe, polling, and refresh commands.
- `usage.mjs`: authentication, live/local normalization, fallback, and cache.
- `startup.ps1`: per-user startup registration.
- `tests/usage.test.mjs`: Node built-in tests with synthetic records and temporary directories.

Run `npm test`. If the environment blocks test subprocesses, use `node --test --test-isolation=none tests/usage.test.mjs` on Node 22.8+.

Render a synthetic preview with `powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\widget.ps1 -PreviewPath "$PWD\screenshots\widget-live.png" -PreviewState live`. States include `stale`, `unknown`, `expired`, `zero`, and `full`. Use `-VerifyPath` instead to render one actual account reading and close. Preview values are fixtures.

The previous HTML page, browser assets, and web server have been removed. `AGENTS.md` describes the current native widget structure and development commands.
