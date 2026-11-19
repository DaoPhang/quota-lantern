import { readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTokenCounter } from './tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Independent estimate of non-cached tokens in one Team Standard weekly allowance. Anthropic does not publish it.
export const WEEKLY_TOKEN_ESTIMATE = 16700000;

// Anthropic reports utilization as 0-100 and resets_at as an ISO timestamp.
export function normalizeWindow(raw, kind, now = Date.now()) {
  if (!raw || typeof raw.utilization !== 'number' || !Number.isFinite(raw.utilization)) return null;
  const resetDate = new Date(raw.resets_at ?? NaN);
  const resetsAt = Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
  const expired = resetsAt !== null && Date.parse(resetsAt) <= now;
  const used = Math.min(100, Math.max(0, raw.utilization));
  const windowMinutes = kind === 'primary' ? 300 : 10080;
  return {
    kind, label: kind === 'primary' ? 'Short-term window' : 'Weekly window',
    windowMinutes,
    // The window is taken to begin one window-length before its reset; unknown once the reset has passed.
    startsAt: resetsAt && !expired ? new Date(Date.parse(resetsAt) - windowMinutes * 60000).toISOString() : null,
    tokensUsed: null,
    tokensLeft: kind === 'primary' || expired ? null : Math.round(WEEKLY_TOKEN_ESTIMATE * (100 - used) / 100),
    usedPercent: expired ? null : used,
    remainingPercent: expired ? null : Math.round((100 - used) * 10) / 10,
    resetsAt, expired,
  };
}

export function normalizeUsage(raw, source = 'live', observedAt = new Date().toISOString(), now = Date.now(), plan = null) {
  return {
    source, observedAt, plan,
    windows: [normalizeWindow(raw.five_hour, 'primary', now), normalizeWindow(raw.seven_day, 'secondary', now)],
  };
}

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Renews the access token with the stored refresh token, exactly as Claude Code does,
// and writes the new pair back so Claude Code keeps working. Other keys are preserved.
async function refreshAuth(file, whole, auth) {
  if (!auth.refreshToken) throw new Error('login_expired');
  if (Number.isFinite(auth.refreshTokenExpiresAt) && auth.refreshTokenExpiresAt <= Date.now()) throw new Error('login_expired');
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-usage-monitor/1.0' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(12000), redirect: 'error',
    });
  } catch { throw new Error('service_unavailable'); }
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 || response.status === 403 ? 'login_expired' : 'service_unavailable');
  const body = await response.json();
  if (!body.access_token) throw new Error('service_unavailable');
  const next = { ...auth, accessToken: body.access_token,
    refreshToken: body.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  if (body.refresh_token && Number.isFinite(Number(body.refresh_token_expires_in))) {
    next.refreshTokenExpiresAt = Date.now() + Number(body.refresh_token_expires_in) * 1000;
  }
  // Re-read just before writing so a concurrent Claude Code update is not clobbered.
  let latest = whole;
  try { latest = JSON.parse(await readFile(file, 'utf8')); } catch {}
  if (latest?.claudeAiOauth?.refreshToken && latest.claudeAiOauth.refreshToken !== auth.refreshToken
      && latest.claudeAiOauth.expiresAt > Date.now() + REFRESH_MARGIN_MS) return latest.claudeAiOauth;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ ...latest, claudeAiOauth: next }), { mode: 0o600 });
    await rename(tmp, file);
  } catch { await unlink(tmp).catch(() => {}); }
  return next;
}

async function readAuth(home) {
  const file = join(home, '.credentials.json');
  let whole, auth;
  try { whole = JSON.parse(await readFile(file, 'utf8')); auth = whole.claudeAiOauth; }
  catch { throw new Error('login_missing'); }
  if (!auth?.accessToken) throw new Error('login_missing');
  if (Number.isFinite(auth.expiresAt) && auth.expiresAt - REFRESH_MARGIN_MS <= Date.now()) {
    return refreshAuth(file, whole, auth);
  }
  return auth;
}

// Candidate Claude homes, best first: the explicit/env home, ~/.claude, then Orca-managed profiles
// (newest credentials first). Only homes that hold an access token are tried.
async function candidateHomes(home, discover) {
  const homes = [home];
  if (!discover) return homes;
  const add = (dir) => { if (!homes.includes(dir)) homes.push(dir); };
  add(join(homedir(), '.claude'));
  const root = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'orca', 'claude-profiles');
  try {
    const found = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name, 'home');
      try { found.push({ dir, mtime: (await stat(join(dir, '.credentials.json'))).mtimeMs }); } catch {}
    }
    found.sort((a, b) => b.mtime - a.mtime).forEach(({ dir }) => add(dir));
  } catch {}
  return homes;
}

async function liveUsage(home, discover = false) {
  let failure = new Error('login_missing');
  for (const candidate of await candidateHomes(home, discover)) {
    try { return await liveUsageFrom(candidate); }
    catch (error) {
      // Only try the next home when this one has no usable login; real service errors stop here.
      if (error.message !== 'login_missing' && error.message !== 'login_expired') throw error;
      if (failure.message === 'login_missing') failure = error;
    }
  }
  throw failure;
}

async function liveUsageFrom(home) {
  const auth = await readAuth(home);
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-usage-monitor/1.0',
    },
    signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (response.status === 429) {
    // Honor Retry-After so a rate limit is never hammered; fall back to 5 minutes, cap at 1 hour.
    const seconds = Number(response.headers.get('retry-after'));
    throw Object.assign(new Error('rate_limited'), { retryAfterMs: (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 300) * 1000 });
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'login_expired' : 'service_unavailable');
  const raw = await response.json();
  if (!raw.five_hour && !raw.seven_day) throw new Error('limits_missing');
  return { raw, home, usage: normalizeUsage(raw, 'live', new Date().toISOString(), Date.now(), auth.subscriptionType ?? null) };
}

// Only percentages and reset times are stored: no credentials, prompts or paths.
export async function loadLastKnown(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (!saved?.raw || !Number.isFinite(Date.parse(saved.observedAt))) return null;
    return normalizeUsage(saved.raw, 'local', saved.observedAt, Date.now(), saved.plan ?? null);
  } catch { return null; }
}

const explanations = {
  login_missing: 'Open Claude Code and sign in to read live allowance.',
  login_expired: 'Your Claude login has expired. Open Claude Code to renew it, then refresh.',
  limits_missing: 'This account did not return subscription allowance data.',
  rate_limited: 'The usage service is rate limiting requests. The widget keeps the last reading and retries automatically.',
  service_unavailable: 'The live usage service is unavailable. Try refreshing shortly.',
};

export function createUsageReader(home, cacheFile = join(here, 'usage-cache.json')) {
  // An explicit home (tests) is used alone; otherwise the login is discovered automatically.
  const discover = home === undefined;
  home ??= process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let cached;
  let pending;
  let blockedUntil;
  let tokenHome = home;
  const countTokens = createTokenCounter();
  // A rate-limit backoff survives restarts, so reopening the widget does not retry too early.
  const loadBlock = async () => {
    try { return Number(JSON.parse(await readFile(cacheFile, 'utf8')).blockedUntil) || 0; } catch { return 0; }
  };
  const saveBlock = async (until) => {
    let saved = {};
    try { saved = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
    await writeFile(cacheFile, JSON.stringify({ ...saved, blockedUntil: until })).catch(() => {});
  };
  return async function readUsage(maxAgeMs = 15000) {
    if (cached && Date.now() - cached.checkedAtMs < maxAgeMs) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let result;
      blockedUntil ??= await loadBlock();
      try {
        if (Date.now() < blockedUntil) throw new Error('rate_limited');
        const { raw, usage, home: usedHome } = await liveUsage(home, discover);
        result = usage;
        tokenHome = usedHome;
        blockedUntil = 0;
        const { five_hour, seven_day } = raw;
        await writeFile(cacheFile, JSON.stringify({ observedAt: usage.observedAt, plan: usage.plan, raw: { five_hour, seven_day } }))
          .catch(() => {});
      } catch (error) {
        if (error.retryAfterMs) { blockedUntil = Date.now() + error.retryAfterMs; await saveBlock(blockedUntil); }
        const fallback = await loadLastKnown(cacheFile);
        result = fallback ?? { source: 'unavailable', observedAt: null, plan: null, windows: [null, null] };
        result.errorCode = error.message in explanations ? error.message : 'unknown';
        result.notice = explanations[error.message] ??'Could not reach the live usage service. Check your connection and refresh.';
      }
      // Tokens Claude Code logged on this PC inside each window; never fails the reading.
      try {
        const totals = await countTokens(tokenHome, result.windows.map(w => (w?.startsAt ? Date.parse(w.startsAt) : null)));
        result.windows.forEach((w, i) => { if (w) w.tokensUsed = totals[i]; });
      } catch {}
      result.checkedAt = new Date().toISOString();
      result.retryAt = Date.now() < blockedUntil ? new Date(blockedUntil).toISOString() : null;
      result.stale = !result.observedAt || Date.now() - Date.parse(result.observedAt) > 300000;
      cached = { checkedAtMs: Date.now(), value: result };
      return result;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
