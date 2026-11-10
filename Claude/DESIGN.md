# Claude desktop widget

A native WPF glance strip: a 352 x 76 pill that stays out of the way and expands downward (to 352 x 260) into this week's usage by product. Percentages always mean **remaining** allowance.

Collapsed: a ring for the 5-hour window (clockwise from twelve o'clock), then the 5-hour percentage with `5-hour · <time to reset>`, a divider, and the weekly percentage with `Weekly · <time to reset>`. The arrow button on the right expands the strip. The small dot on the ring is the freshness indicator: green = live, amber = last known, offline, or awaiting a reset. Dimmed values mean the data is not live.

Expanded: "This week's usage by product" with four bars (Claude Code, Chats, Cowork, Other), then a footer with the full status text and the options, refresh and quit buttons. Always starts collapsed.

Theme follows Windows (Settings > Personalization > Colors > app mode) and updates within a few seconds of a change. Dark: surface #1F1E1D, border #3A3936, text #FAF9F5 / #B5B2A9, accent clay #D97757. Light: surface #FAF9F5, border #D9D5C7, text #141413 / #5E5B52, accent #C4623F. Local Segoe UI only; no external fonts or images.

Missing or expired allowance shows `--`, never a fabricated reset to 100%, and passed reset times show `reset due` until a new reading. Product shares are also `--` once the weekly window has passed its reset. Keep each reset tooltip and accessible names on the ring, values, buttons and product rows.

Drag anywhere on the strip to move it; right-click it for options (always on top, start with Windows, quit). Keyboard: Tab, F5 refresh, Escape quits. The × button quits and stops the private usage reader. Position and pin preference persist locally and are clamped to the current work area.
