// Runtime config: defaults ← config.json (settings UI) ← env vars (env wins when set).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from './auth.js';
import { parseDur, durLabel, humanSize } from './util.js';

export const DATA_DIR = process.env.DATA_DIR || './data';
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_FORMATS = [
  { id: 'llm', name: 'LLM 引用', template: '[image:{url}]' },
  { id: 'markdown', name: 'Markdown', template: '![{filename}]({url})' },
  { id: 'xml', name: 'XML 标签', template: '<image>{url}</image>' },
  { id: 'html', name: 'HTML <img>', template: '<img src="{url}">' },
  { id: 'plain', name: '纯链接', template: '{url}' },
];

// Per-kind upload size limits (MB). 'doc' covers pdf/archives etc.
export const SIZE_KINDS = ['image', 'text', 'audio', 'video', 'doc'];
export const DEFAULT_SIZE_LIMITS = { image: 20, text: 2, audio: 50, video: 100, doc: 30 };

const DEFAULTS = {
  baseUrl: '',                // external base URL for generated links (reverse proxy domain)
  retentionMs: 7 * 86400000,  // 0 = keep forever
  cleanIntervalMs: 5 * 60000,
  slidingExpiry: false,       // refresh expiry on every direct-link hit
  keepOriginalName: true,     // Content-Disposition / download uses the original filename
  sizeLimitsMb: { ...DEFAULT_SIZE_LIMITS },
  rateLimitPerMin: 30,
  passwordHash: null,         // null = open mode
  tokenSecret: null,
  formats: null,
  defaultFormat: 'llm',
};

export let config = null;
let saveTimer = null;

export function loadConfig() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* start fresh */ }
  }
  // migrate legacy single-limit config: maxUploadMb (number) → sizeLimitsMb (per kind)
  const storedLimits = stored.sizeLimitsMb && typeof stored.sizeLimitsMb === 'object' ? stored.sizeLimitsMb : null;
  const legacyMb = typeof stored.maxUploadMb === 'number' ? stored.maxUploadMb : null;
  config = { ...DEFAULTS, ...stored };
  if (storedLimits) {
    config.sizeLimitsMb = { ...DEFAULT_SIZE_LIMITS, ...storedLimits };
  } else {
    config.sizeLimitsMb = { ...DEFAULT_SIZE_LIMITS };
    if (legacyMb > 0) for (const k of SIZE_KINDS) config.sizeLimitsMb[k] = legacyMb;
  }
  delete config.maxUploadMb;
  if (!config.tokenSecret) config.tokenSecret = crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(config.formats) || !config.formats.length) {
    config.formats = DEFAULT_FORMATS.map((f) => ({ ...f }));
  }
  applyEnv();
  saveConfigNow();
  return config;
}

/** Env vars pin (override) their fields on every boot when present. */
function applyEnv() {
  const e = process.env;
  if (e.BASE_URL !== undefined && e.BASE_URL !== '') config.baseUrl = e.BASE_URL.replace(/\/+$/, '');
  if (e.RETENTION !== undefined) { const v = parseDur(e.RETENTION); if (v !== null) config.retentionMs = v; }
  if (e.CLEAN_INTERVAL !== undefined) {
    const v = parseDur(e.CLEAN_INTERVAL);
    if (v) config.cleanIntervalMs = Math.max(30000, v);
  }
  if (e.RATE_LIMIT_PER_MIN !== undefined) {
    const v = parseInt(e.RATE_LIMIT_PER_MIN, 10);
    if (v >= 0) config.rateLimitPerMin = v;
  }
  if (e.SLIDING_EXPIRY !== undefined) config.slidingExpiry = /^(1|true|yes|on)$/i.test(e.SLIDING_EXPIRY);
  if (e.KEEP_FILENAME !== undefined) config.keepOriginalName = /^(1|true|yes|on)$/i.test(e.KEEP_FILENAME);
  // per-kind size limits: MAX_IMAGE_MB / MAX_TEXT_MB / MAX_AUDIO_MB / MAX_VIDEO_MB / MAX_DOC_MB,
  // legacy MAX_UPLOAD_MB applies to every kind
  const limitEnvs = { MAX_IMAGE_MB: 'image', MAX_TEXT_MB: 'text', MAX_AUDIO_MB: 'audio', MAX_VIDEO_MB: 'video', MAX_DOC_MB: 'doc' };
  for (const [envKey, kind] of Object.entries(limitEnvs)) {
    const v = parseFloat(e[envKey]);
    if (v > 0) config.sizeLimitsMb[kind] = v;
  }
  const all = parseFloat(e.MAX_UPLOAD_MB);
  if (all > 0) for (const k of SIZE_KINDS) config.sizeLimitsMb[k] = all;
  if (e.PASSWORD) config.passwordHash = hashPassword(e.PASSWORD);
}

export function saveConfigNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // full config (incl. passwordHash + tokenSecret) goes to disk; stripSecrets is for API only
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function saveConfigDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveConfigNow(); }, 300);
}

/** What goes to disk / API responses (never leak secrets). */
export function stripSecrets(c) {
  const { passwordHash, tokenSecret, ...rest } = c;
  return { ...rest, hasPassword: !!c.passwordHash };
}

/** Sanitized view for the settings UI. */
export function publicConfig(stats) {
  return {
    ...stripSecrets(config),
    retention: durLabel(config.retentionMs),
    cleanInterval: durLabel(config.cleanIntervalMs),
    authRequired: !!config.passwordHash,
    stats,
  };
}

/** Render a format template against an image record. */
export function renderFormat(template, rec, url) {
  return String(template)
    .replaceAll('{url}', url)
    .replaceAll('{id}', rec.id)
    .replaceAll('{filename}', rec.filename || `${rec.id}.${rec.ext}`)
    .replaceAll('{ext}', rec.ext)
    .replaceAll('{size}', humanSize(rec.size))
    .replaceAll('{w}', String(rec.w || 0))
    .replaceAll('{h}', String(rec.h || 0))
    .replaceAll('{time}', new Date(rec.createdAt).toISOString());
}

export function renderAllFormats(rec, url) {
  const out = {};
  for (const f of config.formats) out[f.id] = renderFormat(f.template, rec, url);
  return out;
}
