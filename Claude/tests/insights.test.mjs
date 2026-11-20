import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBurnTracker, timeToLimit, paceFor, recordReading,
  createCrossingDetector, crossingAlerts, peakStatus,
} from '../insights.mjs';

const T0 = Date.parse('2026-03-04T12:00:00Z');
const min = (n) => n * 60000;
const limit = (used, resetsAt = null, expired = false) => ({ usedPercent: expired ? null : used, resetsAt, expired });
const live = (at, primaryUsed, weeklyUsed = 10, resetsAt = new Date(T0 + min(300)).toISOString()) => ({
  source: 'live', observedAt: new Date(at).toISOString(),
  windows: [limit(primaryUsed, resetsAt), limit(weeklyUsed, resetsAt)],
});

test('burn rate is percentage points per hour over recent readings', () => {
  const tracker = createBurnTracker();
  tracker.record(0, 10, T0);
  tracker.record(0, 15, T0 + min(10));
  assert.equal(tracker.rate(0, T0 + min(10)), 30);
});

test('burn rate is unknown with one reading, a short span, or flat and falling use', () => {
  const tracker = createBurnTracker();
  tracker.record(0, 10, T0);
  assert.equal(tracker.rate(0, T0), null);
  tracker.record(0, 11, T0 + min(1));
  assert.equal(tracker.rate(0, T0 + min(1)), null);
  const flat = createBurnTracker();
  flat.record(0, 10, T0);
  flat.record(0, 10, T0 + min(6));
  assert.equal(flat.rate(0, T0 + min(6)), 0);
});

test('a reset (use falling) discards earlier readings so the old window never counts as a burn', () => {
  const tracker = createBurnTracker();
  tracker.record(0, 90, T0);
  tracker.record(0, 95, T0 + min(4));
  tracker.record(0, 2, T0 + min(8));
  assert.equal(tracker.rate(0, T0 + min(8)), null);
  tracker.record(0, 4, T0 + min(12));
  assert.equal(tracker.rate(0, T0 + min(12)), 30);
});

test('readings older than the burn window are ignored and repeated readings are not double counted', () => {
  const tracker = createBurnTracker();
  tracker.record(0, 10, T0);
  tracker.record(0, 10, T0);
  tracker.record(0, 20, T0 + min(30));
  assert.equal(tracker.rate(0, T0 + min(30)), null);
});

test('time to limit says whether the limit arrives before the reset', () => {
  const resets = new Date(T0 + min(120)).toISOString();
  assert.deepEqual(timeToLimit(60, 40, resets, T0), { minutes: 60, beforeReset: true });
  assert.deepEqual(timeToLimit(20, 40, resets, T0), { minutes: 180, beforeReset: false });
  assert.deepEqual(timeToLimit(60, 40, null, T0), { minutes: 60, beforeReset: null });
  assert.equal(timeToLimit(0, 40, resets, T0), null);
  assert.equal(timeToLimit(null, 40, resets, T0), null);
});

test('stale or non-live readings are never recorded as burn', () => {
  const tracker = createBurnTracker();
  recordReading(tracker, { ...live(T0, 10), source: 'local' }, T0);
  recordReading(tracker, live(T0 - min(30), 10), T0);
  recordReading(tracker, live(T0 + min(6), 40), T0 + min(6));
  assert.deepEqual(paceFor(tracker, live(T0 + min(6), 40).windows, T0 + min(6)), [null, null]);
});

test('pace is reported per window and stays unknown for expired windows', () => {
  const tracker = createBurnTracker();
  recordReading(tracker, live(T0, 10, 20), T0);
  recordReading(tracker, live(T0 + min(6), 16, 20), T0 + min(6));
  const now = T0 + min(6);
  const pace = paceFor(tracker, live(now, 16, 20).windows, now);
  assert.equal(pace[0].burnPctPerHour, 60);
  assert.equal(pace[0].minutesToLimit, 84);
  assert.equal(pace[0].beforeReset, true);
  assert.equal(pace[1].burnPctPerHour, 0);
  assert.equal(pace[1].minutesToLimit, null);
  const expired = [limit(0, null, true), limit(20)];
  assert.equal(paceFor(tracker, expired, now)[0], null);
});

test('the first reading of a window is a baseline and fires nothing', () => {
  const detector = createCrossingDetector([75, 90]);
  assert.deepEqual(detector.check('0', 80, '2026-03-04T17:00:00Z'), []);
  assert.deepEqual(detector.check('0', 85, '2026-03-04T17:00:00Z'), []);
});

test('an upward crossing fires once, and a skipped threshold fires with the next', () => {
  const detector = createCrossingDetector([75, 90]);
  const reset = '2026-03-04T17:00:00Z';
  detector.check('0', 70, reset);
  assert.deepEqual(detector.check('0', 75, reset), [75]);
  assert.deepEqual(detector.check('0', 80, reset), []);
  assert.deepEqual(detector.check('0', 95, reset), [90]);
  const jump = createCrossingDetector([75, 90]);
  jump.check('0', 70, reset);
  assert.deepEqual(jump.check('0', 92, reset), [75, 90]);
});

test('a new window or a fall in use re-arms the thresholds', () => {
  const detector = createCrossingDetector([75, 90]);
  detector.check('0', 80, '2026-03-04T17:00:00Z');
  detector.check('0', 5, '2026-03-04T22:00:00Z');
  assert.deepEqual(detector.check('0', 76, '2026-03-04T22:00:00Z'), [75]);
  const drop = createCrossingDetector([75, 90]);
  drop.check('0', 10, '2026-03-04T17:00:00Z');
  drop.check('0', 80, '2026-03-04T17:00:00Z');
  drop.check('0', 60, '2026-03-04T17:00:00Z');
  assert.deepEqual(drop.check('0', 78, '2026-03-04T17:00:00Z'), [75]);
});

test('reset time drift within a window is the same window, and a restart does not re-notify', () => {
  const detector = createCrossingDetector([75, 90]);
  detector.check('0', 70, '2026-03-04T17:00:00.100Z');
  assert.deepEqual(detector.check('0', 80, '2026-03-04T17:00:00.900Z'), [75]);
  const restarted = createCrossingDetector([75, 90], detector.snapshot());
  assert.deepEqual(restarted.check('0', 82, '2026-03-04T17:00:00.500Z'), []);
  assert.deepEqual(restarted.check('0', 91, '2026-03-04T17:00:00.500Z'), [90]);
});

test('alerts carry remaining percent and are only raised from fresh live readings', () => {
  const detector = createCrossingDetector([75, 90]);
  assert.deepEqual(crossingAlerts(detector, live(T0, 70), T0), []);
  assert.deepEqual(crossingAlerts(detector, live(T0 + min(2), 76), T0 + min(2)),
    [{ window: '5-hour', threshold: 75, remainingPercent: 24 }]);
  assert.deepEqual(crossingAlerts(detector, { ...live(T0 + min(4), 95), source: 'local' }, T0 + min(4)), []);
  assert.deepEqual(crossingAlerts(detector, live(T0, 95), T0 + min(30)), []);
});

test('peak window covers weekday 5-11 AM Pacific, across the daylight saving change', () => {
  assert.equal(peakStatus(Date.parse('2026-03-04T14:00:00Z')).inPeak, true);   // Wed 06:00 PST
  assert.equal(peakStatus(Date.parse('2026-03-04T14:00:00Z')).minutesUntilEnd, 300);
  assert.equal(peakStatus(Date.parse('2026-03-04T12:59:00Z')).inPeak, false);  // 04:59 PST
  assert.equal(peakStatus(Date.parse('2026-03-04T13:00:00Z')).inPeak, true);   // 05:00 PST
  assert.equal(peakStatus(Date.parse('2026-03-04T19:00:00Z')).inPeak, false);  // 11:00 PST
  assert.equal(peakStatus(Date.parse('2026-03-09T11:59:00Z')).inPeak, false);  // Mon 04:59 PDT
  assert.equal(peakStatus(Date.parse('2026-03-09T12:00:00Z')).inPeak, true);   // Mon 05:00 PDT
  assert.equal(peakStatus(Date.parse('2026-03-09T17:59:00Z')).minutesUntilEnd, 1);
  assert.equal(peakStatus(Date.parse('2026-03-09T18:00:00Z')).inPeak, false);  // 11:00 PDT
  assert.equal(peakStatus(Date.parse('2026-03-07T14:00:00Z')).inPeak, false);  // Saturday
});
