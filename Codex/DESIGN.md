# Codex desktop widget

Use a compact 352 x 292 native WPF window with a dark rounded surface. Two meters show independent allowances: a car-style fuel gauge in mint for the 5-hour window, and a segmented status bar in lavender for the week. Percentages explicitly mean **remaining**. The circular widget linked in README.md was the original inspiration; the gauge and bar are a later adaptation.

Surface: #191B24. Border: #373A47. Gauge arc: #79E2BD. Weekly bar: #B5A2F4. Primary text: #F5F7FC. Supporting text: #939AAE. Use local Segoe UI and Consolas for the small terminal mark. No external fonts, images, or UI dependencies.

The gauge sweeps 240 degrees clockwise from **E** (empty, lower left) to **F** (full, lower right), with a tick every 5%. The needle and filled arc both show the remaining allowance. The bar fills left to right with a divider at each quarter. Zero has an empty arc, a needle on E, and an empty bar; 100% has a full arc, a needle on F, and a full bar. An unknown or expired 5-hour allowance parks a dimmed needle on E, which is not a reading of zero. Missing or expired allowance shows `--`, never a fabricated reset to 100%. Keep each reset countdown and exact local timestamp tooltip.

The footer communicates live, last known, unavailable, and disconnected states through text and color. Drag the header to move. Options control pinning, startup, and quitting. Keyboard access includes Tab navigation, F5 refresh, and Escape to close. Preserve accessible control names.

Position and pin preference persist locally. Clamp restored position to the current work area. Startup opens the widget without a browser or console. Closing stops its private usage reader.
