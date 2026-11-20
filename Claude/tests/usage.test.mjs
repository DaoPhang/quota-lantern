import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, normalizeWindow, normalizeScoped, loadLastKnown, createUsageReader, WEEKLY_TOKEN_ESTIMATE } from '../usage.mjs';
import { createTokenCounter } from '../tokens.mjs';

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

test('windows start one window-length before reset and are unknown once passed', () => {
  const primary = normalizeWindow({ utilization: 10, resets_at: future }, 'primary', now);
  assert.equal(primary.startsAt, new Date(now + 3600000 - 300 * 60000).toISOString());
  const weekly = normalizeWindow({ utilization: 10, resets_at: future }, 'secondary', now);
  assert.equal(weekly.startsAt, new Date(now + 3600000 - 10080 * 60000).toISOString());
  assert.equal(normalizeWindow({ utilization: 10, resets_at: new Date(now - 1000).toISOString() }, 'primary', now).startsAt, null);
  assert.equal(normalizeWindow({ utilization: 10, resets_at: null }, 'primary', now).startsAt, null);
  assert.equal(weekly.tokensLeft, Math.round(WEEKLY_TOKEN_ESTIMATE * 0.9));
  assert.equal(primary.tokensLeft, null);
  assert.equal(normalizeWindow({ utilization: 10, resets_at: new Date(now - 1000).toISOString() }, 'secondary', now).tokensLeft, null);
  assert.equal(normalizeUsage({}).breakdown, undefined);
});

test('token counter sums new input, output and cache writes per window and counts each message once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-tokens-'));
  try {
    const line = (id, at, usage, extra = {}) => JSON.stringify({ type: 'assistant', uuid: `u-${id}-${at}`, timestamp: new Date(at).toISOString(),
      message: { id, model: 'm', usage, content: [{ type: 'text', text: 'private' }] }, ...extra });
    const hour = 3600000;
    await mkdir(join(dir, 'projects', 'a', 'sub'), { recursive: true });
    await writeFile(join(dir, 'projects', 'a', 's1.jsonl'), [
      line('m1', now - hour, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999 }),
      line('m1', now - hour, { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100 }), // streamed repeat: larger reading wins
      line('m2', now - 6 * hour, { input_tokens: 1, output_tokens: 1 }),                                  // outside the 5-hour window
      JSON.stringify({ type: 'user', timestamp: new Date(now - hour).toISOString(), message: { usage: { input_tokens: 7777 } } }),
      'not json "usage" "assistant"',
    ].join('\n'));
    // A resumed session repeats m1 in another file and adds a subagent message.
    await writeFile(join(dir, 'projects', 'a', 'sub', 's2.jsonl'), [
      line('m1', now - hour, { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100 }),
      line('m3', now - 2 * hour, { input_tokens: 4, output_tokens: 6 }),
    ].join('\n'));
    const count = createTokenCounter();
    assert.deepEqual(await count(dir, [now - 5 * hour, now - 7 * 24 * hour, null], now), [140, 142, null]);
    assert.deepEqual(await count(join(dir, 'missing'), [now - hour], now), [0]);
    assert.deepEqual(await count(dir, [null, null], now), [null, null]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('live reading carries tokens used in each window and stays valid when no logs exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 1e9 } }));
    const soon = new Date(Date.now() + 3600000).toISOString();
    globalThis.fetch = async () => new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: soon }, seven_day: { utilization: 5, resets_at: soon } }), { status: 200 });
    const usage = await createUsageReader(dir, join(dir, 'cache.json'))(0);
    assert.equal(usage.windows[0].tokensUsed, 0);
    assert.equal(usage.windows[1].tokensUsed, 0);
    assert.equal(usage.windows[0].remainingPercent, 80);
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
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

const scopedEntry = (name, percent, resets_at = future) => ({ kind: 'weekly_scoped', percent, resets_at, scope: { model: { display_name: name } } });

test('the model-scoped weekly window is added only when the service reports one, highest use first', () => {
  const base = { five_hour: { utilization: 10, resets_at: future }, seven_day: { utilization: 20, resets_at: future } };
  assert.equal(normalizeUsage(base, 'live', new Date(now).toISOString(), now).windows.length, 2);
  const usage = normalizeUsage({ ...base, limits: [scopedEntry('Alpha', 30), scopedEntry('Beta', 60), { kind: 'other', percent: 99 }] },
    'live', new Date(now).toISOString(), now);
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[2].label, 'Beta');
  assert.equal(usage.windows[2].remainingPercent, 40);
  assert.equal(usage.windows[2].tokensLeft, null);
  assert.equal(usage.windows[1].remainingPercent, 80);
});

test('malformed scoped entries are ignored and an expired scoped reset stays unknown', () => {
  assert.equal(normalizeScoped([{ kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'A' } } },
    { kind: 'weekly_scoped', percent: 10, scope: {} }, null], now), null);
  assert.equal(normalizeScoped(undefined, now), null);
  const expired = normalizeScoped([scopedEntry('Beta', 60, new Date(now - 1000).toISOString())], now);
  assert.equal(expired.remainingPercent, null);
  assert.equal(expired.expired, true);
});

test('the scoped window survives the last-known cache without tokens counted for it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-usage-'));
  const realFetch = globalThis.fetch;
  try {
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 1e9 } }));
    const soon = new Date(Date.now() + 3600000).toISOString();
    globalThis.fetch = async () => new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: soon },
      seven_day: { utilization: 5, resets_at: soon }, limits: [scopedEntry('Beta', 40, soon)] }), { status: 200 });
    const file = join(dir, 'cache.json');
    const live = await createUsageReader(dir, file)(0);
    assert.equal(live.windows[2].remainingPercent, 60);
    assert.equal(live.windows[2].tokensUsed, null);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(saved.raw.limits[0]).sort(), ['kind', 'percent', 'resets_at', 'scope']);
    const restored = await loadLastKnown(file);
    assert.equal(restored.windows[2].label, 'Beta');
  } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
});
