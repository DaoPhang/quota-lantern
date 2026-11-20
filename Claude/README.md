# Claude usage widget

A compact native Windows (WPF) widget showing remaining **Claude** allowance: a car-style fuel gauge for the 5-hour window and a segmented status bar for the weekly window. It reads your existing Claude Code login from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and queries Anthropic's usage endpoint over a private parent/child pipe. No local server or open port.

## Run
- Build the launcher once from this folder with `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1`. That creates `Claude Widget.exe` beside the project files.
- Then double-click `Claude Widget.exe` (or `Start Widget.cmd`). Requires Windows PowerShell 5.1 and Node.js 22+.
- Right-click the strip (or use the `...` button when expanded) for *Always on top*, *Start with Windows*, and *Quit*. F5 refreshes; Escape quits; the × button quits too.
- The arrow button on the strip expands a collapsed-by-default panel with the status line and the options, refresh and quit buttons.
- Under the 5-hour value the widget shows tokens used, counted from Claude Code session logs on this PC (new input, output and cache writes; the window is taken to start 5 hours before its reset). Chats, Cowork and other devices are not included. Under the weekly value it shows an estimate of tokens left: 16.7M non-cached tokens (an independent estimate for a Team Standard seat, not an Anthropic figure) times the remaining percentage. Both show `--` once the window has passed its reset.
- `npm test` runs the usage tests. Rebuild the launcher with `build-launcher.ps1`.

## Behavior
- Percentages mean **remaining**. Passed reset times show `--` until a new reading is confirmed.
- If the token is expired or the service is unreachable, the last known reading is shown, labelled "Last known data". Only percentages and reset times are cached (`usage-cache.json`), never tokens or chat content.
- When the access token is about to expire, the widget renews it with the stored refresh token (as Claude Code does) and writes the new pair back to `.credentials.json`, preserving other keys. If the refresh token itself has expired, open Claude Code and sign in again.
- Previews: `widget.ps1 -PreviewPath out.png -PreviewState live|stale|unknown|expired|zero|full`.

- The widget is a slim strip that follows the Windows light/dark app theme automatically.
- Updates are paced to respect the usage service's rate limit: every 2 minutes while you are active, every 10 minutes after 5 minutes idle, immediately when you return, and on demand when you expand the panel or press refresh. A rate-limit response is honored (see the footer) and recovers automatically.

## Insights
- **Model weekly row**: when the usage service reports a separate weekly cap for one model, the expanded panel adds a "<model> weekly" row (percent left and time to reset). It disappears when the service stops reporting one. Tokens are not counted for it.
- **Pace**: the expanded panel estimates time to limit from this widget's own recent live readings (the last 15 minutes). It shows in amber only when the limit would arrive before the reset, and is hidden until two live readings exist or while data is stale. It is an estimate, not an Anthropic figure.
- **Notifications**: a Windows balloon appears when the 5-hour or weekly window passes 75% or 90% used, once per threshold per window. The first reading after launch is only a baseline, and a restart does not repeat a threshold. Toggle from the options menu (`widget-settings.json` keeps the choice; `alerts-state.json` keeps notified thresholds as percentages and reset times only).
- **Peak hours**: on weekdays 5-11 AM Pacific the expanded panel shows a hint that limits are reported reduced. This is a time-based hint from public reports, not a live reading.
- Preview these with `widget.ps1 -PreviewPath out.png -PreviewState insights -PreviewExpanded`.
