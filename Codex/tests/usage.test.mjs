import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, normalizeWindow, localUsage, createUsageReader } from '../usage.mjs';

const now = Date.parse('2026-11-03T05:00:00Z');
const future = now / 1000 + 3600;
test('live API and local records represent the same allowance', () => {
  const live = normalizeUsage({ plan_type: 'plus', rate_limit: {
    primary_window: { used_percent: 38, reset_at: future, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 48, reset_at: future, limit_window_seconds: 604800 },
  } }, 'live', new Date(now).toISOString(), now);
  const local = normalizeUsage({ primary: { used_percent: 38, resets_at: future, window_minutes: 300 },
    secondary: { used_percent: 48, resets_at: future, window_minutes: 10080 } }, 'local', new Date(now).toISOString(), now);
  assert.deepEqual(live.windows, local.windows);
  assert.equal(live.windows[0].remainingPercent, 62);
  assert.equal(live.windows[1].remainingPercent, 52);
});
test('passed resets remain unknown instead of inventing a new allowance', () => {
  const window = normalizeWindow({ used_percent: 90, reset_at: now / 1000 - 1 }, 'primary', now);
  assert.equal(window.expired, true);
  assert.equal(window.remainingPercent, null);
  assert.equal(window.usedPercent, null);
  assert.equal(normalizeWindow({ used_percent: null }, 'primary', now), null);
});

test('a reset at the observation time is expired and missing windows stay unknown', () => {
  const usage = normalizeUsage({ primary: { used_percent: 0, resets_at: now / 1000 } }, 'local', new Date(now).toISOString(), now);
  assert.equal(usage.windows[0].expired, true);
  assert.equal(usage.windows[0].remainingPercent, null);
  assert.equal(usage.windows[1], null);
});

test('normalization rejects invalid percentages and bounds valid numeric values', () => {
  for (const used of [null, undefined, '20', NaN, Infinity, -Infinity]) {
    assert.equal(normalizeWindow({ used_percent: used }, 'primary', now), null);
  }
  assert.equal(normalizeWindow({ used_percent: -5 }, 'primary', now).remainingPercent, 100);
  assert.equal(normalizeWindow({ used_percent: 105 }, 'secondary', now).remainingPercent, 0);
  const window = normalizeWindow({ used_percent: 12.34 }, 'primary', now);
  assert.equal(window.remainingPercent, 87.7);
  assert.equal(window.resetsAt, null);
  assert.equal(window.expired, false);
});

test('invalid reset timestamps preserve allowance with an unknown reset time', () => {
  for (const reset of [Number.MAX_VALUE, -Number.MAX_VALUE, 8640000000001, NaN, Infinity, 'invalid']) {
    const window = normalizeWindow({ used_percent: 25, reset_at: reset }, 'primary', now);
    assert.equal(window.resetsAt, null);
    assert.equal(window.remainingPercent, 75);
    assert.equal(window.expired, false);
  }
});

test('a missing Codex login and empty home produce an explicit unavailable reading', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-monitor-test-'));
  try {
    const result = await createUsageReader(home)();
    assert.equal(result.source, 'unavailable');
    assert.equal(result.observedAt, null);
    assert.deepEqual(result.windows, [null, null]);
    assert.equal(result.stale, true);
    assert.match(result.notice, /sign in/i);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the reader falls back to local data without exposing session content or credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-monitor-test-'));
  try {
    const sessions = join(home, 'sessions');
    await mkdir(sessions);
    await writeFile(join(home, 'auth.json'), JSON.stringify({ api_key: 'private-test-key' }));
    const record = {
      type: 'event_msg', timestamp: '2026-01-01T00:00:00Z',
      payload: { type: 'token_count', privateText: 'private-session-content', rate_limits: {
        primary: { used_percent: 25, resets_at: 4102444800, window_minutes: 300 },
        secondary: { used_percent: 75, resets_at: 4102444800, window_minutes: 10080 },
      } },
    };
    await writeFile(join(sessions, 'private-session-name.jsonl'), JSON.stringify(record));
    const result = await createUsageReader(home)();
    assert.equal(result.source, 'local');
    assert.equal(result.observedAt, record.timestamp);
    assert.deepEqual(result.windows.map(window => window.remainingPercent), [75, 25]);
    assert.equal(result.stale, true);
    assert.match(result.notice, /sign in/i);
    assert.doesNotMatch(JSON.stringify(result), /private-test-key|private-session-content|private-session-name|auth\.json/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('local fallback chooses the newest Codex event, skips premium and partial lines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-monitor-test-'));
  try {
    const sessions = join(home, 'sessions', '2026');
    await mkdir(sessions, { recursive: true });
    const event = (timestamp, limits) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: limits } });
    const limits = used => ({ limit_id: 'codex', primary: { used_percent: used, resets_at: 4102444800, window_minutes: 300 } });
    await writeFile(join(sessions, 'a.jsonl'), [event('2026-11-03T01:00:00Z', limits(20)), event('2026-11-03T02:00:00Z', limits(40)), '{partial'].join('\n'));
    await writeFile(join(sessions, 'b.jsonl'), [event('2026-11-03T01:30:00Z', limits(30)), event('2026-11-03T03:00:00Z', { limit_id: 'premium', primary: { used_percent: 99 } })].join('\n'));
    const result = await localUsage(home);
    assert.equal(result.source, 'local');
    assert.equal(result.observedAt, '2026-11-03T02:00:00Z');
    assert.equal(result.windows[0].remainingPercent, 60);
    assert.equal(result.windows[1], null);
  } finally { await rm(home, { recursive: true, force: true }); }
});
