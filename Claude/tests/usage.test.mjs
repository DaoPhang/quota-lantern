import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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

test('expired access token is renewed and written back without losing other keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ mcpOAuth: { keep: 1 },
      claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: 1, refreshTokenExpiresAt: Date.now() + 1e9 } }));
    globalThis.fetch = async (url) => String(url).includes('/oauth/token')
      ? Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 })
      : Response.json({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600000).toISOString() } });
    const result = await createUsageReader(dir, join(dir, 'cache.json'))();
    assert.equal(result.source, 'live');
    const saved = JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8'));
    assert.equal(saved.claudeAiOauth.accessToken, 'new');
    assert.equal(saved.claudeAiOauth.refreshToken, 'r2');
    assert.deepEqual(saved.mcpOAuth, { keep: 1 });
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
});

test('weekly product breakdown keeps labels and clamped percentages only', () => {
  const rows = [
    { key: 'claude_code', display_name: 'Claude Code', percent: 80 },
    { key: 'chat', display_name: 'Chats', percent: -5 },
    { key: 'bad', display_name: 'Bad', percent: 'x' },
  ];
  const usage = normalizeUsage({ seven_day_breakdown: { rows } });
  assert.deepEqual(usage.breakdown, [{ label: 'Claude Code', percent: 80 }, { label: 'Chats', percent: 0 }]);
  assert.equal(normalizeUsage({}).breakdown, null);
});

test('rate limiting keeps the last reading, honors Retry-After and does not refetch during backoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 1e9 } }));
    await writeFile(join(dir, 'cache.json'), JSON.stringify({ observedAt: new Date(now).toISOString(),
      raw: { five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600000).toISOString() } } }));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '600' } }); };
    const first = await createUsageReader(dir, join(dir, 'cache.json'))();
    assert.equal(first.source, 'local');
    assert.equal(first.windows[0].remainingPercent, 75);
    assert.match(first.notice, /rate limiting/i);
    assert.ok(Date.parse(first.retryAt) - Date.now() > 590000);
    // A restarted reader reads the saved backoff and does not call the service again.
    const second = await createUsageReader(dir, join(dir, 'cache.json'))();
    assert.equal(calls, 1);
    assert.ok(second.retryAt);
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
});

test('a reading younger than the requested age is reused without calling the service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 1e9 } }));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600000).toISOString() } }); };
    const read = createUsageReader(dir, join(dir, 'cache.json'));
    await read();
    await read(60000);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
});
