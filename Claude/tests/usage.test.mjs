import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, normalizeWindow, loadLastKnown, createUsageReader } from '../usage.mjs';

const now = Date.parse('2026-11-03T05:00:00Z');
const future = new Date(now + 3600000).toISOString();

test('utilization converts to remaining percent for both windows', () => {
  const usage = normalizeUsage({ five_hour: { utilization: 38, resets_at: future },
    seven_day: { utilization: 48.5, resets_at: future } }, 'live', new Date(now).toISOString(), now, 'pro');
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.windows[0].remainingPercent, 62);
  assert.equal(usage.windows[1].remainingPercent, 51.5);
  assert.equal(usage.windows[0].resetsAt, future);
});

test('passed resets remain unknown instead of inventing a new allowance', () => {
  const window = normalizeWindow({ utilization: 90, resets_at: new Date(now - 1000).toISOString() }, 'primary', now);
  assert.equal(window.expired, true);
  assert.equal(window.remainingPercent, null);
  assert.equal(normalizeWindow({ utilization: null }, 'primary', now), null);
  assert.equal(normalizeWindow(null, 'primary', now), null);
});

test('out-of-range utilization is clamped and missing resets stay unknown', () => {
  assert.equal(normalizeWindow({ utilization: 140, resets_at: future }, 'primary', now).remainingPercent, 0);
  const noReset = normalizeWindow({ utilization: 10, resets_at: null }, 'secondary', now);
  assert.equal(noReset.resetsAt, null);
  assert.equal(noReset.expired, false);
});

test('last known reading is restored as local data and ignores bad files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  try {
    const file = join(dir, 'cache.json');
    assert.equal(await loadLastKnown(file), null);
    await writeFile(file, 'not json');
    assert.equal(await loadLastKnown(file), null);
    await writeFile(file, JSON.stringify({ observedAt: new Date(now).toISOString(), plan: 'max',
      raw: { five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3600000).toISOString() }, seven_day: null } }));
    const usage = await loadLastKnown(file);
    assert.equal(usage.source, 'local');
    assert.equal(usage.windows[0].remainingPercent, 80);
    assert.equal(usage.windows[1], null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing login reports unavailable with guidance and no network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  try {
    const result = await createUsageReader(dir, join(dir, 'cache.json'))();
    assert.equal(result.source, 'unavailable');
    assert.deepEqual(result.windows, [null, null]);
    assert.match(result.notice, /sign in/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expired login falls back to the last known reading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: 1 } }));
    await writeFile(join(dir, 'cache.json'), JSON.stringify({ observedAt: new Date(now).toISOString(),
      raw: { five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600000).toISOString() } } }));
    const result = await createUsageReader(dir, join(dir, 'cache.json'))();
    assert.equal(result.source, 'local');
    assert.equal(result.stale, true);
    assert.equal(result.windows[0].remainingPercent, 75);
    assert.match(result.notice, /expired/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
