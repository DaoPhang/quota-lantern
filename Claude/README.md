# Claude usage widget

A compact native Windows (WPF) widget showing remaining **Claude** allowance: a car-style fuel gauge for the 5-hour window and a segmented status bar for the weekly window. It reads your existing Claude Code login from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and queries Anthropic's usage endpoint over a private parent/child pipe. No local server or open port.

## Run
- Build the launcher once from this folder with `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1`. That creates `Claude Widget.exe` beside the project files.
- Then double-click `Claude Widget.exe` (or `Start Widget.cmd`). Requires Windows PowerShell 5.1 and Node.js 22+.
- Right-click the strip (or use the `...` button when expanded) for *Always on top*, *Start with Windows*, and *Quit*. F5 refreshes; Escape quits; the × button quits too.
- The arrow button on the strip expands a collapsed-by-default panel showing this week's usage by product (Claude Code, Chats, Cowork, Other) from the account's weekly breakdown. It shows `--` when the weekly window has passed its reset.
- `npm test` runs the usage tests. Rebuild the launcher with `build-launcher.ps1`.

## Behavior
- Percentages mean **remaining**. Passed reset times show `--` until a new reading is confirmed.
- If the token is expired or the service is unreachable, the last known reading is shown, labelled "Last known data". Only percentages and reset times are cached (`usage-cache.json`), never tokens or chat content.
- When the access token is about to expire, the widget renews it with the stored refresh token (as Claude Code does) and writes the new pair back to `.credentials.json`, preserving other keys. If the refresh token itself has expired, open Claude Code and sign in again.
- Previews: `widget.ps1 -PreviewPath out.png -PreviewState live|stale|unknown|expired|zero|full`.

- The widget is a slim strip that follows the Windows light/dark app theme automatically.
- Updates are paced to respect the usage service's rate limit: every 2 minutes while you are active, every 10 minutes after 5 minutes idle, immediately when you return, and on demand when you expand the panel or press refresh. A rate-limit response is honored (see the footer) and recovers automatically.
