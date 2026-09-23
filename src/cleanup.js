// Expiry sweeper: deletes images past their expireAt on a configurable interval.
import fs from 'node:fs';
import { config } from './config.js';
import * as store from './store.js';

let timer = null;
export let lastSweep = { at: 0, removed: 0 };

export function sweep() {
  const now = Date.now();
  let removed = 0;
  for (const rec of store.all()) {
    if (rec.expireAt && rec.expireAt <= now) {
      try { fs.unlinkSync(store.imagePath(rec)); } catch { /* file already gone */ }
      store.del(rec.id);
      removed++;
    }
  }
  store.persistNow();
  lastSweep = { at: now, removed };
  return removed;
}

export function startCleanup() {
  if (timer) clearInterval(timer);
  timer = setInterval(sweep, config.cleanIntervalMs);
  if (timer.unref) timer.unref();
  sweep();
}

export function restartCleanup() {
  startCleanup();
}
