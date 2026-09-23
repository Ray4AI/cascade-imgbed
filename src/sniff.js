// File-type sniffing by magic bytes (+ UTF-8 heuristic for text). Never trust Content-Type.
// Returns { mime, ext, kind, w?, h?, plainServe? } or null when unsupported.
// kind: 'image' | 'text' | 'audio' | 'video' | 'doc'
// SVG is intentionally NOT supported (XSS risk); html/xml text is served as text/plain.

const TEXT_EXTS = new Map(Object.entries({
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
  yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain', ini: 'text/plain',
  conf: 'text/plain', cfg: 'text/plain', env: 'text/plain', gitignore: 'text/plain',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', jsx: 'text/plain',
  tsx: 'text/plain', css: 'text/css', html: 'text/html', htm: 'text/html',
  xml: 'text/xml', svg: 'image/svg+xml', sh: 'text/plain', bash: 'text/plain',
  zsh: 'text/plain', py: 'text/plain', go: 'text/plain', rs: 'text/plain',
  java: 'text/plain', kt: 'text/plain', c: 'text/plain', h: 'text/plain',
  cpp: 'text/plain', hpp: 'text/plain', sql: 'text/plain', vue: 'text/plain',
  srt: 'text/plain', vtt: 'text/plain', tex: 'text/plain',
}));
const MAX_TEXT_CHECK = 1024 * 1024; // validate UTF-8 on up to 1MB

export function sniff(buf, filename = '', declaredMime = '') {
  if (!buf || buf.length < 4) return null;
  const img = sniffImage(buf);
  if (img) return { ...img, kind: 'image' };
  const media = sniffMedia(buf);
  if (media) return { ...media, kind: media.mime.startsWith('audio/') ? 'audio' : 'video' };
  const doc = sniffDoc(buf);
  if (doc) return { ...doc, kind: 'doc' };
  const text = sniffText(buf, filename, declaredMime);
  if (text) return text;
  return null;
}

// ------------------------------------------------------------------ images

function sniffImage(buf) {
  if (buf.length < 24) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a) {
    return { mime: 'image/png', ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // JPEG — scan segments for a SOF frame header
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xff) { off++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { mime: 'image/jpeg', ext: 'jpg', h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      if (marker === 0xda) break;
      if (len < 2) break;
      off += 2 + len;
    }
    return { mime: 'image/jpeg', ext: 'jpg', w: 0, h: 0 };
  }

  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF' && buf.length >= 10) {
    return { mime: 'image/gif', ext: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // WEBP (VP8 / VP8L / VP8X)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const fourcc = buf.toString('ascii', 12, 16);
    const base = { mime: 'image/webp', ext: 'webp', w: 0, h: 0 };
    if (fourcc === 'VP8 ') {
      if (buf[27] === 0x9d && buf[28] === 0x01 && buf[29] === 0x2a) {
        return { ...base, w: buf.readUInt16LE(30) & 0x3fff, h: buf.readUInt16LE(32) & 0x3fff };
      }
    } else if (fourcc === 'VP8L') {
      if (buf[24] === 0x2f) {
        const [b0, b1, b2, b3] = [buf[25], buf[26], buf[27], buf[28]];
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { ...base, w, h };
      }
    } else if (fourcc === 'VP8X' && buf.length >= 35) {
      return { ...base, w: buf.readUIntLE(28, 3) + 1, h: buf.readUIntLE(31, 3) + 1 };
    }
    return base;
  }

  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    return { mime: 'image/bmp', ext: 'bmp', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
  }

  return null;
}

// ------------------------------------------------------------- audio/video

function sniffMedia(buf) {
  // MP3 with ID3 tag
  if (buf.length > 8 && buf.toString('ascii', 0, 3) === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };

  // MPEG audio / ADTS AAC frame sync
  if (buf.length > 4 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const layer = (buf[1] >> 1) & 0x03;
    if (layer === 0 && (buf[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', ext: 'aac' };
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }

  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const form = buf.toString('ascii', 8, 12);
    if (form === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
    if (form === 'AVI ') return { mime: 'video/x-msvideo', ext: 'avi' };
  }

  if (buf.length > 4 && buf.toString('ascii', 0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };

  if (buf.length > 4 && buf.toString('ascii', 0, 4) === 'OggS') {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    if (/theora/i.test(head)) return { mime: 'video/ogg', ext: 'ogv' };
    return { mime: 'audio/ogg', ext: 'ogg' };
  }

  // ISO-BMFF: MP4 / M4A / MOV  (size + 'ftyp' at offset 4)
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'M4A ') return { mime: 'audio/mp4', ext: 'm4a' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov' };
    return { mime: 'video/mp4', ext: 'mp4' };
  }

  // Matroska / WebM (EBML)
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    return /webm/i.test(head)
      ? { mime: 'video/webm', ext: 'webm' }
      : { mime: 'video/x-matroska', ext: 'mkv' };
  }

  return null;
}

// --------------------------------------------------------- documents / archives

function sniffDoc(buf) {
  if (buf.length > 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return { mime: 'application/zip', ext: 'zip' };
  }
  if (buf.length > 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c) {
    return { mime: 'application/x-7z-compressed', ext: '7z' };
  }
  if (buf.length > 7 && buf.toString('ascii', 0, 4) === 'Rar!' && buf[4] === 0x1a && buf[5] === 0x07) {
    return { mime: 'application/vnd.rar', ext: 'rar' };
  }
  if (buf.length > 3 && buf[0] === 0x1f && buf[1] === 0x8b) return { mime: 'application/gzip', ext: 'gz' };
  if (buf.length > 3 && buf.toString('ascii', 0, 3) === 'BZh') return { mime: 'application/x-bzip2', ext: 'bz2' };
  return null;
}

// ---------------------------------------------------------------------- text

function sniffText(buf, filename, declaredMime) {
  // must be valid UTF-8 without NUL/control bytes
  const sample = buf.subarray(0, Math.min(buf.length, MAX_TEXT_CHECK));
  if (sample.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    // partial multi-byte at the cut may fail; try whole buffer for small files
    if (buf.length > MAX_TEXT_CHECK) return null;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  let mime = TEXT_EXTS.get(ext);
  if (!mime) {
    const d = String(declaredMime || '').split(';')[0].trim().toLowerCase();
    if (d.startsWith('text/') || d === 'application/json' || d === 'application/xml' || d.endsWith('+json') || d.endsWith('+xml')) {
      mime = d;
    } else if (!ext) {
      mime = 'text/plain';
    } else {
      // unknown extension and no text-ish declared type → treat as plain text only if filename absent
      return String(filename) ? null : { mime: 'text/plain', ext: 'txt', kind: 'text' };
    }
  }
  const finalExt = TEXT_EXTS.has(ext) ? ext : 'txt';
  const plainServe = ['text/html', 'text/xml', 'application/xml', 'image/svg+xml'].includes(mime);
  return {
    mime: plainServe ? 'text/plain' : mime,
    ext: finalExt === 'svg' ? 'txt' : finalExt, // never store svg (would be image-served)
    kind: 'text',
    plainServe,
  };
}
