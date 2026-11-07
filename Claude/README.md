# Claude usage widget

A compact native Windows (WPF) widget showing remaining **Claude** allowance for the 5-hour and weekly windows. It reads your existing Claude Code login from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and queries Anthropic's usage endpoint over a private parent/child pipe. No local server or open port.

## Run
- Build the launcher once from this folder with `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1`. That creates `Claude Widget.exe` beside the project files.
- Then double-click `Claude Widget.exe` (or `Start Widget.cmd`). Requires Windows PowerShell 5.1 and Node.js 22+.
- Right-click the `...` menu for *Always on top*, *Start with Windows*, and *Quit*. F5 refreshes; Escape closes.
- `npm test` runs the usage tests. Rebuild the launcher with `build-launcher.ps1`.

## Behavior
- Percentages mean **remaining**. Passed reset times show `--` until a new reading is confirmed.
- If the token is expired or the service is unreachable, the last known reading is shown, labelled "Last known data". Only percentages and reset times are cached (`usage-cache.json`), never tokens or chat content.
- The widget never refreshes the OAuth token itself, so it cannot sign Claude Code out. Open Claude Code to renew an expired login.
- Previews: `widget.ps1 -PreviewPath out.png -PreviewState live|stale|unknown|expired|zero|full`.
