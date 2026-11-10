// TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 digits — the Google Authenticator defaults) on Node's built-in crypto (OpenSSL).
// No custom cryptography: HOTP (RFC 4226) dynamic truncation, AES-256-GCM for secrets at rest, scrypt for recovery
// code verifiers, crypto.timingSafeEqual for comparisons.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw Error('invalid base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const STEP_S = 30, DIGITS = 6;
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}
export const counterAt = (ms: number) => Math.floor(ms / 1000 / STEP_S);
/** Verify a 6-digit code within ±1 step. Returns the matched counter (for replay protection) or null. */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastCounter: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const c = counterAt(nowMs);
  for (const k of [c, c - 1, c + 1]) {
    if (k < 0) continue;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, k)), Buffer.from(code));
    if (ok) return lastCounter !== null && k <= lastCounter ? null : k; // an accepted code (or an older one) is never accepted again
  }
  return null;
}
export const newSecret = () => crypto.randomBytes(20); // 160-bit, RFC 4226 recommendation
export function otpauthUri(secretB32: string, account: string, issuer = 'TradeBot Pro'): string {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

// ---- secrets at rest: AES-256-GCM with a 256-bit key (TRADEBOT_TOTP_KEY, base64) or a generated key file (0600)
export type Sealed = { iv: string; tag: string; data: string };
export function seal(key: Buffer, plain: Buffer): Sealed {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal(key: Buffer, s: Sealed): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]);
}

// ---- recovery codes: 10 × 10 characters (50 bits each), shown once; only scrypt verifiers are stored
export type RecoveryVerifier = { salt: string; hash: string; usedAt?: number };
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => { const b = crypto.randomBytes(10); let s = ''; for (const x of b) s += RC_ALPHABET[x & 31]; return s.slice(0, 5) + '-' + s.slice(5); });
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
export function recoveryVerifier(code: string): RecoveryVerifier {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(normCode(code), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex') };
}
/** Index of the unused verifier that matches, or -1. */
export function matchRecovery(code: string, list: RecoveryVerifier[]): number {
  const c = normCode(code); if (c.length !== 10) return -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i]; if (v.usedAt) continue;
    const h = crypto.scryptSync(c, v.salt, 32, { N: 16384, r: 8, p: 1 });
    if (crypto.timingSafeEqual(h, Buffer.from(v.hash, 'hex'))) return i;
  }
  return -1;
}
