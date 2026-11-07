# Usage widgets

- `Codex/`: Codex allowance widget (builds `Codex Widget.exe`).
- `Claude/`: Claude allowance widget (builds `Claude Widget.exe`).

To get the launcher, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\build-launcher.ps1` inside the folder you want. The executables are not stored in the repository.

Each folder is self-contained, with its own build script, launcher source, tests, and README. Both can run side by side and be enabled for Windows startup independently.
