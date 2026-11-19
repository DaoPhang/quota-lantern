import { createReadStream } from 'node:fs';
import { readdir as readdirP, stat as statP } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Tokens Claude Code recorded on this PC, summed per allowance window. Only totals leave this module:
// no prompts, replies, paths or session filenames are kept or returned.
const MAX_FILES = 2000;

async function listSessionFiles(dir, minMtime, found = [], depth = 0) {
  if (depth > 4 || found.length >= MAX_FILES) return found;
  let entries;
  try { entries = await readdirP(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await listSessionFiles(path, minMtime, found, depth + 1);
    else if (entry.name.endsWith('.jsonl')) {
      try {
        const info = await statP(path);
        if (info.mtimeMs >= minMtime) found.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {}
    }
  }
  return found;
}

// Billable-style total for one assistant message: new input, output, and cache writes.
// Cache reads are excluded because they re-send context that was already counted.
export function messageTokens(usage) {
  const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return n(usage?.input_tokens) + n(usage?.output_tokens) + n(usage?.cache_creation_input_tokens);
}

async function readEntries(path) {
  const entries = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const message = record?.message;
      const at = Date.parse(record?.timestamp);
      if (record?.type !== 'assistant' || !message?.usage || !Number.isFinite(at) || message.model === '<synthetic>') continue;
      entries.push([String(message.id ?? record.uuid ?? ''), at, messageTokens(message.usage)]);
    }
  } catch {}
  return entries;
}

// Returns a counter. counter(home, starts, now) gives one total per start time (ms), or null for a null start.
// Unchanged files are served from memory, so each refresh only re-reads files that grew.
export function createTokenCounter() {
  const cache = new Map();
  return async function countTokens(home, starts, now = Date.now()) {
    const known = starts.filter(Number.isFinite);
    if (!known.length) return starts.map(() => null);
    const files = await listSessionFiles(join(home, 'projects'), Math.min(...known));
    const live = new Set(files.map(file => file.path));
    for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
    // A resumed session repeats earlier messages, so each message id is counted once (largest reading wins).
    const messages = new Map();
    for (const file of files) {
      let item = cache.get(file.path);
      if (!item || item.mtimeMs !== file.mtimeMs || item.size !== file.size) {
        item = { mtimeMs: file.mtimeMs, size: file.size, entries: await readEntries(file.path) };
        cache.set(file.path, item);
      }
      item.entries.forEach(([id, at, tokens], index) => {
        const key = id || `${file.path}:${index}`;
        const seen = messages.get(key);
        if (!seen || tokens > seen[1]) messages.set(key, [at, tokens]);
      });
    }
    return starts.map(start => {
      if (!Number.isFinite(start)) return null;
      let total = 0;
      for (const [at, tokens] of messages.values()) if (at >= start && at <= now) total += tokens;
      return total;
    });
  };
}
