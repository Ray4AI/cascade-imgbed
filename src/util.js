// Small shared helpers.

const DUR_MULT = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** Parse '10m' / '1h' / '6h' / '1d' / '7d' / '30d' / 'never' / '0' → ms (0 = never). */
export function parseDur(s) {
  if (s === null || s === undefined || s === '') return null;
  const t = String(s).trim().toLowerCase();
  if (t === 'never' || t === '0' || t === 'forever') return 0;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * DUR_MULT[m[2]];
}

/** ms → compact label like '7d' / '30m' / '90s'. */
export function durLabel(ms) {
  if (!ms) return 'never';
  for (const unit of ['d', 'h', 'm', 's']) {
    const mult = DUR_MULT[unit];
    if (ms % mult === 0) return `${ms / mult}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Human countdown label from a future timestamp. */
export function remainLabel(expireAt) {
  if (!expireAt) return '永久保留';
  const ms = expireAt - Date.now();
  if (ms <= 0) return '已过期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `剩余 ${d}天${h}小时`;
  if (h > 0) return `剩余 ${h}小时${m}分`;
  return `剩余 ${Math.max(1, m)}分钟`;
}

/** Keep only a safe, short original filename (stored in DB, never in paths). */
export function safeName(name) {
  if (!name) return '';
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  const base = String(name).split(/[\\/]/).pop() || '';
  return base.replace(/[\x00-\x1f\x7f"<>|:]/g, '').trim().slice(0, 120);
}
