// Metadata store: meta.json (rebuilt from files if lost — filesystem is the source of truth).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, IMAGES_DIR } from './config.js';

const META_FILE = path.join(DATA_DIR, 'meta.json');
let meta = new Map();
let saveTimer = null;

export function loadMeta() {
  meta = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const r of arr) if (r && r.id) meta.set(r.id, r);
  } catch { /* no meta yet */ }
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 200);
}

function flush() {
  try { fs.writeFileSync(META_FILE, JSON.stringify([...meta.values()])); } catch { /* retried later */ }
}

export function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flush();
}

export const get = (id) => meta.get(id);
export const all = () => [...meta.values()];

export function put(rec) { meta.set(rec.id, rec); persist(); }
export function del(id) { meta.delete(id); persist(); }

export function clearAll() {
  for (const rec of meta.values()) {
    try { fs.unlinkSync(imagePath(rec)); } catch { /* already gone */ }
  }
  meta.clear();
  persistNow();
}

export function imagePath(rec) {
  return path.join(IMAGES_DIR, `${rec.id}.${rec.ext}`);
}

export function stats() {
  let bytes = 0;
  for (const rec of meta.values()) bytes += rec.size || 0;
  return { count: meta.size, bytes };
}
