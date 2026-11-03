import fs from 'node:fs';
import { readScannerStatus } from './scannerStatus.js';

const OUTBOX_FILE = process.env.SCANNER_OUTBOX_FILE ?? '/home/scanner/dax-scanner/data/paper-scanner/outbox.txt';
const CHECK_MS = 120000;
const STALE_MIN = 10;

// Read the outbox text, or null when it cannot be read
function readOutbox() {
  try {
    return fs.readFileSync(OUTBOX_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

// Start the watcher; send(text) delivers a message to the owner. Returns a stop function
export function startScannerWatch(send, options = {}) {
  if (options.enabled === false) return () => {};
  let staleSent = false;
  let completeSent = false;
  let lastOutbox = 'NONE';

  const check = async () => {
    try {
      const s = readScannerStatus();
      if (s === null) return;
      const finished = s.status === 'RUN COMPLETE';
      if (finished && !completeSent) {
        completeSent = true;
        await send(`Scanner run complete. closedTrades: ${s.closedTrades}, stopReason: ${s.stopReason}. Run the summary on the VM.`);
      }
      if (!finished && s.ageMin !== null && s.ageMin > STALE_MIN && !staleSent) {
        staleSent = true;
        await send(`SCANNER STALE: no update for ${Math.round(s.ageMin)} min (last: ${s.generatedAt}).`);
      }
      if (!finished && s.ageMin !== null && s.ageMin <= STALE_MIN && staleSent) {
        staleSent = false;
        await send('Scanner recovered: status updates are fresh again.');
      }
      const outbox = readOutbox();
      if (outbox !== null && outbox !== 'NONE' && outbox !== lastOutbox) {
        await send(`Scanner alert:\n${outbox}`);
      }
      if (outbox !== null) lastOutbox = outbox;
    } catch {
      // The watcher must never crash the bot
    }
  };

  const timer = setInterval(check, CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
