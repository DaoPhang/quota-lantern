import { readFile, writeFile } from 'node:fs/promises';
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

export function normalizeUsage(raw, source = 'live', observedAt = new Date().toISOString(), now = Date.now(), plan = null) {
  return {
    source, observedAt, plan,
    windows: [normalizeWindow(raw.five_hour, 'primary', now), normalizeWindow(raw.seven_day, 'secondary', now)],
  };
}

async function readAuth(home) {
  let auth;
  try { auth = JSON.parse(await readFile(join(home, '.credentials.json'), 'utf8')).claudeAiOauth; }
  catch { throw new Error('login_missing'); }
  if (!auth?.accessToken) throw new Error('login_missing');
  // The token is never refreshed here: rotating it could sign Claude Code out.
  if (Number.isFinite(auth.expiresAt) && auth.expiresAt <= Date.now()) throw new Error('login_expired');
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
  service_unavailable: 'The live usage service is unavailable. Try refreshing shortly.',
};

export function createUsageReader(home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  cacheFile = join(here, 'usage-cache.json')) {
  let cached;
  let pending;
  return async function readUsage() {
    if (cached && Date.now() - cached.checkedAtMs < 15000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let result;
      try {
        const { raw, usage } = await liveUsage(home);
        result = usage;
        const { five_hour, seven_day } = raw;
        await writeFile(cacheFile, JSON.stringify({ observedAt: usage.observedAt, plan: usage.plan, raw: { five_hour, seven_day } }))
          .catch(() => {});
      } catch (error) {
        const fallback = await loadLastKnown(cacheFile);
        result = fallback ?? { source: 'unavailable', observedAt: null, plan: null, windows: [null, null] };
        result.notice = explanations[error.message] ?? 'Could not reach the live usage service. Check your connection and refresh.';
      }
      result.checkedAt = new Date().toISOString();
      result.stale = !result.observedAt || Date.now() - Date.parse(result.observedAt) > 120000;
      cached = { checkedAtMs: Date.now(), value: result };
      return result;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
