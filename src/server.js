// CascadeImg — zero-dependency Node HTTP server.
// Paste-image cascade UI → direct links + LLM-ready reference formats.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  config, loadConfig, saveConfigNow, publicConfig, renderAllFormats, SIZE_KINDS,
} from './config.js';
import { verifyPassword, hashPassword, signToken, verifyToken } from './auth.js';
import { sniff } from './sniff.js';
import * as store from './store.js';
import { startCleanup, restartCleanup, sweep, lastSweep } from './cleanup.js';
import { safeName, humanSize, parseDur } from './util.js';

const PORT = parseInt(process.env.PORT || '3080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TOKEN_TTL = 7 * 86400000;
const COOKIE = 'ci_token';

loadConfig();
store.loadMeta();
startCleanup();

// ---------------------------------------------------------------- helpers

function sendJSON(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendError(res, code, msg) {
  sendJSON(res, code, { error: msg });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!config.passwordHash) return true; // open mode
  const token = parseCookies(req.headers.cookie)[COOKIE]
    || (String(req.headers.authorization || '').startsWith('Bearer ')
      ? String(req.headers.authorization).slice(7) : '');
  return verifyToken(config.tokenSecret, token);
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  sendError(res, 401, 'unauthorized');
  return false;
}

function publicBase(req) {
  if (config.baseUrl) return config.baseUrl;
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

const urlOf = (req, rec) => `${publicBase(req)}/i/${rec.id}.${rec.ext}`;

function clientPayload(req, rec) {
  return {
    id: rec.id,
    filename: rec.filename,
    kind: rec.kind || 'image',
    ext: rec.ext,
    mime: rec.mime,
    w: rec.w,
    h: rec.h,
    size: rec.size,
    sizeLabel: humanSize(rec.size),
    createdAt: rec.createdAt,
    expireAt: rec.expireAt,
    hits: rec.hits || 0,
    url: urlOf(req, rec),
    formats: renderAllFormats(rec, urlOf(req, rec)),
    defaultFormat: config.defaultFormat,
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJSON(req, limit = 256 * 1024) {
  return readBody(req, limit).then((buf) => JSON.parse(buf.toString('utf8') || '{}'));
}

/** Minimal multipart/form-data parser (first file part + simple text fields). */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, files: [] };
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const fields = {};
  const files = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const after = start + boundary.length;
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break; // closing --
    const headerStart = after + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;
    const headers = body.slice(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    const content = body.slice(headerEnd + 4, next === -1 ? body.length : Math.max(headerEnd + 4, next - 2));
    const disp = /content-disposition:\s*([^\r\n]+)/i.exec(headers);
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers);
    // param extraction anchored at ';' or start, so `filename=` is never mistaken for `name=`
    const name = disp ? (/(?:^|;)\s*name="([^"]*)"/i.exec(disp[1]) || [])[1] || '' : '';
    const filename = disp ? (/(?:^|;)\s*filename="([^"]*)"/i.exec(disp[1]) || [])[1] : undefined;
    if (filename !== undefined) {
      files.push({ name, filename, mime: ctype?.[1]?.trim() || '', data: content });
    } else {
      fields[name] = content.toString('utf8');
    }
    start = next;
  }
  return { fields, files };
}

// Upload rate limiting: simple per-IP fixed window.
const rateBuckets = new Map();
function rateLimited(ip) {
  if (!config.rateLimitPerMin) return false;
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now - b.start >= 60000) {
    rateBuckets.set(ip, { start: now, n: 1 });
    return false;
  }
  b.n += 1;
  return b.n > config.rateLimitPerMin;
}

// ------------------------------------------------------------- upload flow

async function handleUpload(req, res) {
  if (!requireAuth(req, res)) return;
  const ip = req.socket.remoteAddress || '?';
  if (rateLimited(ip)) return sendError(res, 429, 'too many uploads, slow down');

  const ctype = req.headers['content-type'] || '';
  const KIND_CN = { image: '图片', text: '文本', audio: '音频', video: '视频', doc: '文件' };
  const maxAllBytes = Math.max(...Object.values(config.sizeLimitsMb)) * 1024 * 1024;
  let buf, filename, declaredMime;

  try {
    if (ctype.startsWith('multipart/form-data')) {
      const body = await readBody(req, maxAllBytes + 1024 * 1024);
      const { files, fields } = parseMultipart(body, ctype);
      const file = files.find((f) => f.data.length) || files[0];
      if (!file) return sendError(res, 400, 'no file in multipart body');
      buf = file.data;
      filename = safeName(file.filename || fields.filename);
      declaredMime = file.mime;
    } else {
      buf = await readBody(req, maxAllBytes);
      const q = new URL(req.url, 'http://x').searchParams;
      filename = safeName(req.headers['x-filename'] || q.get('filename') || '');
      declaredMime = ctype;
    }
  } catch (e) {
    return sendError(res, e.code === 413 ? 413 : 400, e.code === 413
      ? `文件超过服务端接收上限（最大类型上限 ${Math.round(maxAllBytes / 1048576)} MB）`
      : e.message);
  }

  if (!buf || !buf.length) return sendError(res, 400, 'empty upload');

  const info = sniff(buf, filename, declaredMime);
  if (!info) return sendError(res, 415, '不支持的文件类型（支持：图片 png/jpeg/gif/webp/bmp、文本 txt/md/json/代码、音频 mp3/flac/wav/m4a/ogg、视频 mp4/webm/mov、pdf/zip 等）');

  // per-kind size limit (type is known only after sniffing)
  const limitMb = config.sizeLimitsMb[info.kind] ?? config.sizeLimitsMb.doc;
  if (buf.length > limitMb * 1024 * 1024) {
    return sendError(res, 413, `${KIND_CN[info.kind] || '文件'}类上限 ${limitMb} MB，当前 ${(buf.length / 1048576).toFixed(1)} MB（可在设置里分类型调整）`);
  }

  const now = Date.now();
  const rec = {
    id: crypto.randomBytes(16).toString('base64url'), // 128-bit unguessable id
    filename: filename || '',
    kind: info.kind,
    ext: info.ext,
    mime: info.mime,
    plainServe: !!info.plainServe,
    w: info.w || 0,
    h: info.h || 0,
    size: buf.length,
    createdAt: now,
    expireAt: config.retentionMs > 0 ? now + config.retentionMs : null,
    hits: 0,
  };
  fs.writeFileSync(store.imagePath(rec), buf);
  store.put(rec);
  declaredMime; // accepted but sniff() is authoritative
  sendJSON(res, 201, clientPayload(req, rec));
}

// ---------------------------------------------------------------- routing

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendError(res, 404, 'not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'",
  });
  res.end(fs.readFileSync(file));
}

/** Content-Disposition honoring the keep-original-name option (RFC 5987 for non-ASCII). */
function contentDisposition(rec) {
  const name = (config.keepOriginalName && rec.filename) ? rec.filename : `${rec.id}.${rec.ext}`;
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || `${rec.id}.${rec.ext}`;
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function serveFile(req, res, id, ext) {
  const rec = store.get(id);
  if (!rec || rec.ext !== ext) return sendError(res, 404, 'not found or expired');
  const etag = `"${rec.id}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  // sliding expiry + hit counter
  rec.hits = (rec.hits || 0) + 1;
  if (config.slidingExpiry && config.retentionMs > 0) rec.expireAt = Date.now() + config.retentionMs;
  store.put(rec);

  const filePath = store.imagePath(rec);
  const stat = fs.statSync(filePath);
  const headers = {
    'Content-Type': rec.plainServe ? 'text/plain; charset=utf-8' : rec.mime,
    'Cache-Control': 'public, max-age=600',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(rec),
  };

  // single-range support (needed for audio/video seeking)
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    let start, end;
    if (!m[1]) { // suffix: bytes=-N
      const n = parseInt(m[2], 10);
      start = Math.max(0, stat.size - n);
      end = stat.size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

async function handleConfigPut(req, res) {
  if (!requireAuth(req, res)) return;
  let body;
  try { body = await readJSON(req); } catch (e) { return sendError(res, 400, 'invalid JSON'); }

  const oldInterval = config.cleanIntervalMs;
  let retentionChanged = false;
  let newSession = null;

  if (typeof body.baseUrl === 'string') config.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
  if (body.retention !== undefined) {
    const v = parseDur(body.retention);
    if (v === null) return sendError(res, 400, `bad retention: ${body.retention}`);
    config.retentionMs = v;
    retentionChanged = true;
  }
  if (body.cleanInterval !== undefined) {
    const v = parseDur(body.cleanInterval);
    if (!v || v < 30000) return sendError(res, 400, `bad cleanInterval: ${body.cleanInterval}`);
    config.cleanIntervalMs = v;
  }
  if (typeof body.slidingExpiry === 'boolean') config.slidingExpiry = body.slidingExpiry;
  if (typeof body.keepOriginalName === 'boolean') config.keepOriginalName = body.keepOriginalName;
  if (body.sizeLimitsMb && typeof body.sizeLimitsMb === 'object') {
    for (const [kind, raw] of Object.entries(body.sizeLimitsMb)) {
      if (!SIZE_KINDS.includes(kind)) continue;
      const v = parseFloat(raw);
      if (!(v >= 0.1 && v <= 4096)) return sendError(res, 400, `sizeLimitsMb.${kind} 需在 0.1..4096 MB`);
      config.sizeLimitsMb[kind] = v;
    }
  }
  if (body.maxUploadMb !== undefined) { // legacy: one value for all kinds
    const v = parseFloat(body.maxUploadMb);
    if (!(v >= 0.1 && v <= 4096)) return sendError(res, 400, 'maxUploadMb 需在 0.1..4096 MB');
    for (const k of SIZE_KINDS) config.sizeLimitsMb[k] = v;
  }
  if (Array.isArray(body.formats)) {
    const cleaned = [];
    for (const f of body.formats) {
      const id = String(f.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      const name = String(f.name || '').trim().slice(0, 40);
      const template = String(f.template || '').slice(0, 500);
      if (id && template) cleaned.push({ id, name: name || id, template });
    }
    if (!cleaned.length) return sendError(res, 400, 'formats must contain at least one entry');
    config.formats = cleaned;
    if (!cleaned.some((f) => f.id === config.defaultFormat)) config.defaultFormat = cleaned[0].id;
  }
  if (typeof body.defaultFormat === 'string' && config.formats.some((f) => f.id === body.defaultFormat)) {
    config.defaultFormat = body.defaultFormat;
  }
  if (body.password && typeof body.password === 'object') {
    const { current, next, clear } = body.password;
    if (config.passwordHash && !verifyPassword(current || '', config.passwordHash)) {
      return sendError(res, 403, '当前密码不正确');
    }
    if (clear === true) {
      config.passwordHash = null; // explicit clear → open mode
    } else if (next) {
      if (String(next).length < 4) return sendError(res, 400, '密码至少 4 位');
      config.passwordHash = hashPassword(next);
      newSession = signToken(config.tokenSecret, TOKEN_TTL); // keep this session logged in
    } else {
      return sendError(res, 400, '请填写新密码，或使用“清除密码”');
    }
  }

  saveConfigNow();
  if (retentionChanged) {
    // re-apply retention policy to existing images (expireAt = createdAt + retention)
    for (const r of store.all()) {
      r.expireAt = config.retentionMs > 0 ? r.createdAt + config.retentionMs : null;
      store.put(r);
    }
  }
  if (oldInterval !== config.cleanIntervalMs) restartCleanup();
  else sweep(); // apply new retention immediately

  sendJSON(res, 200, publicConfig({ ...store.stats(), lastSweep }), newSession
    ? { 'Set-Cookie': `${COOKIE}=${newSession}; HttpOnly; SameSite=Lax; Path=/` }
    : {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---- public endpoints
    if (req.method === 'GET' && p === '/healthz') return sendJSON(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) return serveStatic(res, p.slice(1));

    const imgMatch = /^\/i\/([A-Za-z0-9_-]{10,40})\.([a-z0-9]{2,5})$/.exec(p);
    if (imgMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(req, res, imgMatch[1], imgMatch[2]);
    }

    // ---- auth
    if (req.method === 'POST' && p === '/api/login') {
      const body = await readJSON(req).catch(() => ({}));
      if (!config.passwordHash) return sendJSON(res, 200, { ok: true, open: true });
      if (!verifyPassword(body.password || '', config.passwordHash)) return sendError(res, 403, '密码错误');
      const token = signToken(config.tokenSecret, TOKEN_TTL);
      return sendJSON(res, 200, { ok: true, token }, {
        'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`,
      });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
    }
    if (req.method === 'GET' && p === '/api/me') {
      return sendJSON(res, 200, {
        authRequired: !!config.passwordHash,
        loggedIn: isAuthed(req) || !config.passwordHash,
      });
    }

    // ---- management (auth required when a password is set)
    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res);

    if (req.method === 'GET' && p === '/api/config') {
      if (!requireAuth(req, res)) return;
      return sendJSON(res, 200, publicConfig({ ...store.stats(), lastSweep }));
    }
    if (req.method === 'PUT' && p === '/api/config') return handleConfigPut(req, res);

    if (req.method === 'GET' && p === '/api/images') {
      if (!requireAuth(req, res)) return;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
      const before = parseInt(url.searchParams.get('before') || String(Date.now() + 1), 10) || (Date.now() + 1);
      const list = store.all()
        .filter((r) => r.createdAt < before)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((r) => clientPayload(req, r));
      return sendJSON(res, 200, { items: list });
    }

    const delMatch = /^\/api\/images\/([A-Za-z0-9_-]{10,40})$/.exec(p);
    if (delMatch && req.method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      const rec = store.get(delMatch[1]);
      if (!rec) return sendError(res, 404, 'not found');
      try { fs.unlinkSync(store.imagePath(rec)); } catch { /* gone */ }
      store.del(rec.id);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/purge') {
      if (!requireAuth(req, res)) return;
      store.clearAll();
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/sweep') {
      if (!requireAuth(req, res)) return;
      return sendJSON(res, 200, { ok: true, removed: sweep() });
    }

    sendError(res, 404, 'not found');
  } catch (e) {
    console.error('[error]', p, e);
    if (!res.headersSent) sendError(res, 500, 'internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[cascade-imgbed] listening on http://${HOST}:${PORT}  data=${path.resolve(process.env.DATA_DIR || './data')}`);
});
