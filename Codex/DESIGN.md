# Codex desktop widget

Use a compact 352 x 292 native WPF window with a dark rounded surface. Two equal circular meters show independent allowances: mint for the 5-hour window and lavender for the week. Percentages explicitly mean **remaining**. The circular widget linked in README.md is the inspiration; the Windows implementation is an adaptation.

Surface: #191B24. Border: #373A47. Primary ring: #79E2BD. Weekly ring: #B5A2F4. Primary text: #F5F7FC. Supporting text: #939AAE. Use local Segoe UI and Consolas for the small terminal mark. No external fonts, images, or UI dependencies.

Read clockwise from twelve o'clock. Zero has an empty ring; 100% has a complete ring. Missing or expired allowance shows `--`, never a fabricated reset to 100%. Keep each reset countdown and exact local timestamp tooltip.

The footer communicates live, last known, unavailable, and disconnected states through text and color. Drag the header to move. Options control pinning, startup, and quitting. Keyboard access includes Tab navigation, F5 refresh, and Escape to close. Preserve accessible control names.

Position and pin preference persist locally. Clamp restored position to the current work area. Startup opens the widget without a browser or console. Closing stops its private usage reader.
