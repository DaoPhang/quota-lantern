import { createInterface } from 'node:readline';
import { createUsageReader } from './usage.mjs';

// Private pipe to the native widget. No HTTP server or browser is involved.
const readUsage = createUsageReader();
let updating = false;
async function update() {
  if (updating) return;
  updating = true;
  try {
    process.stdout.write(`${JSON.stringify(await readUsage())}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ source: 'unavailable', observedAt: null,
      windows: [null, null], notice: 'Unable to read usage. Refresh to try again.' })}\n`);
  } finally {
    updating = false;
  }
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'refresh') void update(); });
const timer = setInterval(update, 30000);
input.on('close', () => { clearInterval(timer); process.exit(0); });
process.stdout.on('error', () => process.exit(0));
void update();
