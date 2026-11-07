import { readFile, readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function normalizeWindow(raw, kind, now = Date.now()) {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null;
  const reset = raw.reset_at ?? raw.resets_at;
  const resetDate = new Date(Number.isFinite(reset) ? reset * 1000 : NaN);
  const resetsAt = Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
  const expired = resetsAt !== null && Date.parse(resetsAt) <= now;
  const used = Math.min(100, Math.max(0, raw.used_percent));
  return {
    kind, label: kind === 'primary' ? 'Short-term window' : 'Weekly window',
    windowMinutes: raw.limit_window_seconds ? raw.limit_window_seconds / 60 : raw.window_minutes ?? null,
    usedPercent: expired ? null : used,
    remainingPercent: expired ? null : Math.round((100 - used) * 10) / 10,
    resetsAt, expired,
  };
}

export function normalizeUsage(raw, source = 'live', observedAt = new Date().toISOString(), now = Date.now()) {
  const limits = raw.rate_limit ?? raw;
  return {
    source, observedAt, plan: raw.plan_type ?? null,
    windows: [normalizeWindow(limits.primary_window ?? limits.primary, 'primary', now),
      normalizeWindow(limits.secondary_window ?? limits.secondary, 'secondary', now)],
  };
}

async function liveUsage(home) {
  let auth;
  try { auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')); }
  catch { throw new Error('login_missing'); }
  if (!auth.tokens?.access_token) throw new Error('login_missing');
  const headers = { Authorization: `Bearer ${auth.tokens.access_token}`, 'User-Agent': 'codex-usage-monitor/1.0' };
  if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers, signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'login_expired' : 'service_unavailable');
  const raw = await response.json();
  if (!raw.rate_limit?.primary_window && !raw.rate_limit?.secondary_window) throw new Error('limits_missing');
  return normalizeUsage(raw);
}

async function sessionFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async entry => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sessionFiles(file);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [{ file, mtime: (await stat(file)).mtimeMs }] : [];
  }));
  return nested.flat();
}

// Read only the tail, never return prompts, responses or filenames to the browser.
async function usageTail(file) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap(line => {
      try {
        const item = JSON.parse(line);
        const limits = item.type === 'event_msg' && item.payload?.type === 'token_count' ? item.payload.rate_limits : null;
        return limits && (!limits.limit_id || limits.limit_id === 'codex') && (limits.primary || limits.secondary)
          && Number.isFinite(Date.parse(item.timestamp)) ? [{ timestamp: item.timestamp, limits }] : [];
      } catch { return []; }
    });
  } finally { await handle.close(); }
}

export async function localUsage(home) {
  const files = (await sessionFiles(join(home, 'sessions'))).sort((a, b) => b.mtime - a.mtime);
  // Inspect all recent sessions so a secondary-only premium event cannot hide Codex usage.
  let latest = null;
  for (const { file } of files.slice(0, 40)) {
    for (const event of await usageTail(file).catch(() => [])) {
      if (!latest || Date.parse(event.timestamp) > Date.parse(latest.timestamp)) latest = event;
    }
  }
  return latest ? normalizeUsage(latest.limits, 'local', latest.timestamp) : null;
}

const explanations = {
  login_missing: 'Open Codex and sign in to read live allowance.',
  login_expired: 'Your Codex login needs to be renewed. Sign in again in Codex, then refresh.',
  limits_missing: 'This account did not return subscription allowance data.',
  service_unavailable: 'The live usage service is unavailable. Try refreshing shortly.',
};

export function createUsageReader(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  let cached;
  let pending;
  return async function readUsage() {
    if (cached && Date.now() - cached.checkedAtMs < 15000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let result;
      try { result = await liveUsage(home); }
      catch (error) {
        const fallback = await localUsage(home).catch(() => null);
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
