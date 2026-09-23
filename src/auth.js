// Password hashing (scrypt) + HMAC-signed stateless tokens. Zero dependencies.
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return `s2:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [tag, saltHex, hashHex] = String(stored).split(':');
    if (tag !== 's2') return false;
    const expect = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expect.length);
    return crypto.timingSafeEqual(expect, actual);
  } catch {
    return false;
  }
}

export function signToken(secret, ttlMs) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(secret, token) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = t.slice(0, i);
  const sig = t.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}
