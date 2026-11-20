// Pure helpers derived from usage readings: burn rate and time to limit, threshold crossings and the
// weekday peak window. Nothing here reads the clock, the network or the disk; callers pass `now`.
// Only percentages and reset times are handled, never credentials, prompts or paths.

const MINUTE = 60000;
const HISTORY_MS = 60 * MINUTE;
const BURN_WINDOW_MS = 15 * MINUTE;
const MIN_BURN_SPAN_MS = 2 * MINUTE;
// resets_at can drift by a little between readings of the same window.
const SAME_WINDOW_MS = 10 * MINUTE;

export const NOTIFY_THRESHOLDS = [75, 90];

// Anthropic's reported weekday reduced-limit window (an upstream heuristic, not an Anthropic figure).
export const PEAK = { timeZone: 'America/Los_Angeles', startHour: 5, endHour: 11, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] };

const clampPercent = (value) => Math.min(100, Math.max(0, value));
const usedPercent = (limit) => (limit && Number.isFinite(limit.usedPercent) && !limit.expired ? clampPercent(limit.usedPercent) : null);

// ---- Burn rate ----

// Tracks recent utilization per window. Only live readings should be recorded, so stale data is never a burn.
export function createBurnTracker() {
  const history = new Map();

  function record(key, used, at) {
    if (!Number.isFinite(used) || !Number.isFinite(at)) return;
    let samples = history.get(key) ?? [];
    const last = samples.at(-1);
    if (last && at <= last.at) return;               // the same reading, or out of order
    if (last && used < last.used - 0.01) samples = []; // utilization fell: the window reset
    samples.push({ at, used });
    history.set(key, samples.filter(sample => at - sample.at <= HISTORY_MS));
  }

  // Percentage points of allowance used per hour, or null until two readings span enough time. Never negative.
  function rate(key, now) {
    const samples = (history.get(key) ?? []).filter(sample => now - sample.at <= BURN_WINDOW_MS);
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples.at(-1);
    const span = last.at - first.at;
    if (span < MIN_BURN_SPAN_MS) return null;
    return Math.max(0, (last.used - first.used) / (span / 3600000));
  }

  return { record, rate };
}

// Minutes until the window is used up at `burnPerHour`, and whether that happens before it resets.
export function timeToLimit(burnPerHour, used, resetsAt, now) {
  if (!Number.isFinite(burnPerHour) || burnPerHour <= 0 || !Number.isFinite(used)) return null;
  const minutes = Math.round(((100 - clampPercent(used)) / burnPerHour) * 60);
  const resetMs = Date.parse(resetsAt ?? '');
  const beforeReset = Number.isFinite(resetMs) ? minutes * MINUTE < resetMs - now : null;
  return { minutes, beforeReset };
}

// Pace for the primary and secondary windows (null while unknown, expired or not enough readings).
export function paceFor(tracker, windows, now) {
  return [0, 1].map(index => {
    const limit = windows[index];
    const used = usedPercent(limit);
    if (used === null) return null;
    const burn = tracker.rate(index, now);
    if (burn === null) return null;
    const limitTime = timeToLimit(burn, used, limit.resetsAt, now);
    return { burnPctPerHour: Math.round(burn * 100) / 100, minutesToLimit: limitTime?.minutes ?? null, beforeReset: limitTime?.beforeReset ?? null };
  });
}

// Records a live reading. Stale or non-live readings are ignored.
export function recordReading(tracker, usage, now) {
  if (!usage || usage.source !== 'live' || !usage.observedAt) return;
  const at = Date.parse(usage.observedAt);
  if (!Number.isFinite(at) || now - at > 5 * MINUTE) return;
  [0, 1].forEach(index => {
    const used = usedPercent(usage.windows?.[index]);
    if (used !== null) tracker.record(index, used, at);
  });
}

// ---- Threshold crossings ----

// Fires once per threshold per window, only on an upward crossing. The first reading of a window is a
// baseline (no alert on launch). A new window, or a fall in use, re-arms the thresholds.
// `saved` ({ [key]: { resetsAt, used, notified } }) lets a restart carry on without re-notifying.
export function createCrossingDetector(thresholds = NOTIFY_THRESHOLDS, saved = {}) {
  const levels = [...thresholds].filter(t => t > 0 && t <= 100).sort((a, b) => a - b);
  const states = new Map(Object.entries(saved ?? {}));

  function check(key, used, resetsAt) {
    if (!Number.isFinite(used)) return [];
    const resetMs = Date.parse(resetsAt ?? '');
    const prev = states.get(key);
    const sameWindow = prev && (!Number.isFinite(resetMs) || !Number.isFinite(Date.parse(prev.resetsAt ?? ''))
      || Math.abs(Date.parse(prev.resetsAt) - resetMs) < SAME_WINDOW_MS);
    if (!sameWindow) {
      states.set(key, { resetsAt: resetsAt ?? null, used, notified: levels.filter(t => t <= used) });
      return [];
    }
    const fired = levels.filter(t => prev.used < t && t <= used && !prev.notified.includes(t));
    states.set(key, {
      resetsAt: resetsAt ?? prev.resetsAt, used,
      notified: levels.filter(t => t <= used && (prev.notified.includes(t) || fired.includes(t))),
    });
    return fired;
  }

  const snapshot = () => Object.fromEntries(states);
  return { check, snapshot };
}

const WINDOW_NAMES = ['5-hour', 'Weekly'];

// Crossings for one reading, as { window, threshold, remainingPercent }. Live readings only.
export function crossingAlerts(detector, usage, now) {
  if (!usage || usage.source !== 'live' || !usage.observedAt || now - Date.parse(usage.observedAt) > 5 * MINUTE) return [];
  const alerts = [];
  [0, 1].forEach(index => {
    const limit = usage.windows?.[index];
    const used = usedPercent(limit);
    if (used === null) return;
    for (const threshold of detector.check(String(index), used, limit.resetsAt)) {
      alerts.push({ window: WINDOW_NAMES[index], threshold, remainingPercent: Math.round((100 - used) * 10) / 10 });
    }
  });
  return alerts;
}

// ---- Peak window ----

// Whether `now` falls in the weekday reduced-limit window, and how long until it ends.
export function peakStatus(now = Date.now()) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: PEAK.timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  } catch { return { inPeak: false, minutesUntilEnd: null }; }
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const inPeak = PEAK.days.includes(parts.weekday)
    && minuteOfDay >= PEAK.startHour * 60 && minuteOfDay < PEAK.endHour * 60;
  return { inPeak, minutesUntilEnd: inPeak ? PEAK.endHour * 60 - minuteOfDay : null };
}
