import { createInterface } from 'node:readline';
import { createUsageReader } from './usage.mjs';

// Private pipe to the native widget. No HTTP server or browser is involved.
// The usage service rate limits clients, so reads are paced: every 2 minutes while the user is
// active, every 10 minutes while idle, and on demand when the widget asks for a fresher reading.
const ACTIVE_MS = 2 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const readUsage = createUsageReader();
let updating = false;
let idle = false;
let timer;

async function update(maxAgeMs) {
  if (updating) return;
  updating = true;
  try {
    process.stdout.write(`${JSON.stringify(await readUsage(maxAgeMs))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ source: 'unavailable', observedAt: null,
      windows: [null, null], notice: 'Unable to read usage. Refresh to try again.' })}\n`);
  } finally {
    updating = false;
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => { await update(ACTIVE_MS - 5000); schedule(); }, idle ? IDLE_MS : ACTIVE_MS);
}

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line === 'refresh') void update(15000);           // refresh button or F5
  else if (line === 'expand') void update(30000);        // panel opened: make sure it is fresh
  else if (line === 'idle') { idle = true; schedule(); }
  else if (line === 'active') { idle = false; schedule(); void update(60000); } // back at the PC
});
input.on('close', () => { clearTimeout(timer); process.exit(0); });
process.stdout.on('error', () => process.exit(0));
void update();
schedule();
