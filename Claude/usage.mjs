import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Anthropic reports utilization as 0-100 and resets_at as an ISO timestamp.
export function normalizeWindow(raw, kind, now = Date.now()) {
  if (!raw || typeof raw.utilization !== 'number' || !Number.isFinite(raw.utilization)) return null;
  const resetDate = new Date(raw.resets_at ?? NaN);
  const resetsAt = Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
  const expired = resetsAt !== null && Date.parse(resetsAt) <= now;
  const used = Math.min(100, Math.max(0, raw.utilization));
  return {
    kind, label: kind === 'primary' ? 'Short-term window' : 'Weekly window',
    windowMinutes: kind === 'primary' ? 300 : 10080,
    usedPercent: expired ? null : used,
    remainingPercent: expired ? null : Math.round((100 - used) * 10) / 10,
    resetsAt, expired,
  };
}

// Share of this week's usage per product. Only labels and percentages are kept.
export function normalizeBreakdown(raw) {
  if (!Array.isArray(raw?.rows)) return null;
  const rows = raw.rows
    .filter(row => row && typeof row.display_name === 'string' && typeof row.percent === 'number' && Number.isFinite(row.percent))
    .map(row => ({ label: row.display_name.slice(0, 24), percent: Math.min(100, Math.max(0, row.percent)) }));
  return rows.length ? rows.slice(0, 4) : null;
}

export function normalizeUsage(raw, source = 'live', observedAt = new Date().toISOString(), now = Date.now(), plan = null) {
  return {
    source, observedAt, plan,
    windows: [normalizeWindow(raw.five_hour, 'primary', now), normalizeWindow(raw.seven_day, 'secondary', now)],
    breakdown: normalizeBreakdown(raw.seven_day_breakdown),
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

async function liveUsage(home) {
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
  return { raw, usage: normalizeUsage(raw, 'live', new Date().toISOString(), Date.now(), auth.subscriptionType ?? null) };
}

// Only percentages and reset times are stored: no tokens, prompts or paths.
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

export function createUsageReader(home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  cacheFile = join(here, 'usage-cache.json')) {
  let cached;
  let pending;
  let blockedUntil;
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
        const { raw, usage } = await liveUsage(home);
        result = usage;
        blockedUntil = 0;
        const { five_hour, seven_day, seven_day_breakdown } = raw;
        await writeFile(cacheFile, JSON.stringify({ observedAt: usage.observedAt, plan: usage.plan, raw: { five_hour, seven_day, seven_day_breakdown } }))
          .catch(() => {});
      } catch (error) {
        if (error.retryAfterMs) { blockedUntil = Date.now() + error.retryAfterMs; await saveBlock(blockedUntil); }
        const fallback = await loadLastKnown(cacheFile);
        result = fallback ?? { source: 'unavailable', observedAt: null, plan: null, windows: [null, null], breakdown: null };
        result.notice = explanations[error.message] ?? 'Could not reach the live usage service. Check your connection and refresh.';
      }
      result.checkedAt = new Date().toISOString();
      result.retryAt = Date.now() < blockedUntil ? new Date(blockedUntil).toISOString() : null;
      result.stale = !result.observedAt || Date.now() - Date.parse(result.observedAt) > 300000;
      cached = { checkedAtMs: Date.now(), value: result };
      return result;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
