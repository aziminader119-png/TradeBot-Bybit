import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { base32Encode, matchRecovery, newRecoveryCodes, newSecret, otpauthUri, recoveryVerifier, seal, unseal, verifyTotp, type RecoveryVerifier, type Sealed } from './totp.ts';

// Phase 2 security gate. It runs on the raw Node HTTP server BEFORE Express and before the
// WebSocket upgrade, so every /api route and the /ws stream are protected even if a route forgets.
//
//  - Host allowlist (blocks DNS-rebinding): localhost / 127.0.0.1 / [::1] + TRADEBOT_ALLOWED_HOSTS.
//  - Login with an admin password (scrypt hash in data/auth.json). First run: either
//    TRADEBOT_ADMIN_PASSWORD, or a one-time setup token printed ONLY to the server console.
//  - Session cookie: random 256-bit id, HttpOnly, SameSite=Strict, Secure when TRADEBOT_COOKIE_SECURE=1.
//  - Every /api request needs a valid session, except the auth endpoints themselves.
//  - State-changing requests (anything but GET/HEAD) additionally need:
//      * Content-Type: application/json   (blocks HTML form posts),
//      * Origin, when present, equal to this server's own origin, and Sec-Fetch-Site not cross-site,
//      * X-CSRF-Token equal to the session's token (only readable by same-origin JS).
//  - CORS preflights are refused; no Access-Control-* headers are ever sent.
//  - WebSocket /ws: same Host + Origin checks and a valid session cookie.
//  - Login throttling: 5 failures per IP -> 15 minute lock.
//  - Account security (Security page): username, password change, TOTP 2FA (Google Authenticator) with recovery
//    codes. Every change needs the current password (and a 2FA code once 2FA is on); failures are rate limited;
//    every event is written to data/security-audit.log (never a password, code or secret).

const COOKIE = 'tb_session';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const MIN_PASSWORD = 10;
const LOGIN_EMAIL=(process.env.TRADEBOT_LOGIN_EMAIL||'naderazimi274@gmail.com').trim().toLowerCase();
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if(!EMAIL_RE.test(LOGIN_EMAIL))throw Error('TRADEBOT_LOGIN_EMAIL must be a valid email address');

interface Session { id: string; csrf: string; created: number; lastSeen: number }
interface StoredAuth {
  salt: string; hash: string; N: number; r: number; p: number; createdAt: number;
  username?: string; passwordChangedAt?: number; usernameChangedAt?: number;
  totp?: { secret: Sealed; enabledAt: number; lastCounter: number | null };
  pendingTotp?: { secret: Sealed; createdAt: number };
  recovery?: RecoveryVerifier[];
}
const STRONG_MIN = 12;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const CHALLENGE_MS = 5 * 60 * 1000;
/** Strong password rule for password CHANGES (first-run setup keeps its existing 10-character minimum). */
export function passwordProblem(pw: unknown, username?: string): string | null {
  if (typeof pw !== 'string' || pw.length < STRONG_MIN) return `Use at least ${STRONG_MIN} characters`;
  if (pw.length > 256) return 'Password is too long';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Use at least three of: lower-case, upper-case, digits, symbols';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username';
  return null;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface AuthGateOptions {
  dataDir?: string;
  allowedHosts?: string[]; // extra hostnames (without port)
  cookieSecure?: boolean;
  adminPassword?: string; // initial password (only used when no auth.json exists)
  log?: (msg: string) => void;
}

export class AuthGate {
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; until: number }>();
  private sensitive = new Map<string, { count: number; until: number }>();
  private challenges = new Map<string, { created: number; ip: string; attempts: number }>();
  private dataDir: string;
  private keyCache: Buffer | null = null;
  private authFile: string;
  private allowedHosts: Set<string>;
  private cookieSecure: boolean;
  private setupToken: string | null = null;
  private log: (msg: string) => void;
  private onLogout: ((sessionId: string) => void) | null = null;

  constructor(opts: AuthGateOptions = {}) {
    const dataDir = opts.dataDir || path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.authFile = path.join(dataDir, 'auth.json');
    this.allowedHosts = new Set([...LOOPBACK_HOSTS, ...(opts.allowedHosts || []).map((h) => h.trim().toLowerCase()).filter(Boolean)]);
    this.cookieSecure = Boolean(opts.cookieSecure);
    this.log = opts.log || ((m) => console.log(m));

    if (!this.hasPassword()) {
      if (opts.adminPassword) {
        if (opts.adminPassword.length < MIN_PASSWORD) throw new Error(`Admin password must be at least ${MIN_PASSWORD} characters`);
        this.writePassword(opts.adminPassword);
        this.log('[Auth] Admin password initialised from TRADEBOT_ADMIN_PASSWORD. Remove it from the environment now.');
      } else {
        this.setupToken = crypto.randomBytes(18).toString('base64url');
        this.log(`[Auth] No admin password yet. One-time setup token (console only): ${this.setupToken}`);
      }
    }
  }

  public setLogoutListener(fn: (sessionId: string) => void): void {
    this.onLogout = fn;
  }

  public hasPassword(): boolean {
    return fs.existsSync(this.authFile);
  }

  public getSetupTokenForTests(): string | null {
    return this.setupToken;
  }

  // ---------- password storage ----------
  private writePassword(password: string): void {
    const prev = this.readAuth();
    const salt = crypto.randomBytes(16).toString('hex');
    const N = 16384, r = 8, p = 1;
    const hash = crypto.scryptSync(password, salt, 64, { N, r, p }).toString('hex');
    // keep username and 2FA enrollment; replace only the password verifier
    const rec: StoredAuth = { ...(prev || {}), salt, hash, N, r, p, createdAt: prev?.createdAt || Date.now(), ...(prev ? { passwordChangedAt: Date.now() } : {}) } as StoredAuth;
    this.writeAuth(rec);
  }
  private readAuth(): StoredAuth | null {
    try { return JSON.parse(fs.readFileSync(this.authFile, 'utf-8')); } catch { return null; }
  }
  private writeAuth(rec: StoredAuth): void {
    const tmp = this.authFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, this.authFile);
  }

  private verifyPassword(password: string): boolean {
    try {
      const rec = this.readAuth();
      if (!rec || typeof password !== 'string') return false;
      const hash = crypto.scryptSync(password, rec.salt, 64, { N: rec.N, r: rec.r, p: rec.p }).toString('hex');
      return safeEqual(hash, rec.hash);
    } catch {
      return false;
    }
  }

  // ---------- 2FA secrets at rest (AES-256-GCM key: TRADEBOT_TOTP_KEY or data/totp.key, 0600) ----------
  private totpKey(): Buffer {
    if (this.keyCache) return this.keyCache;
    const env = process.env.TRADEBOT_TOTP_KEY;
    if (env) { const k = Buffer.from(env, 'base64'); if (k.length !== 32) throw Error('TRADEBOT_TOTP_KEY must be 32 bytes, base64'); return (this.keyCache = k); }
    const file = path.join(this.dataDir, 'totp.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (k.length !== 32) throw Error('data/totp.key is invalid');
    return (this.keyCache = k);
  }
  private audit(event: string, req: IncomingMessage | null, ok: boolean, detail?: string): void {
    try {
      const file = path.join(this.dataDir, 'security-audit.log');
      try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch { /* new file */ }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ok, ip: req ? this.clientIp(req) : undefined, detail }) + '\n', { mode: 0o600 });
    } catch { /* auditing must never break authentication */ }
  }
  /** 5 failed sensitive checks (password / 2FA) per IP -> 15 minute lock for those actions. */
  private sensitiveLocked(req: IncomingMessage): boolean { const f = this.sensitive.get(this.clientIp(req)); return Boolean(f && f.until > Date.now()); }
  private sensitiveFail(req: IncomingMessage): void {
    const ip = this.clientIp(req), cur = this.sensitive.get(ip) || { count: 0, until: 0 };
    cur.count++; if (cur.count >= 5) { cur.until = Date.now() + 15 * 60 * 1000; cur.count = 0; }
    this.sensitive.set(ip, cur);
  }
  /** TOTP code or unused recovery code against the stored enrollment; records use (replay protection). */
  private checkSecondFactor(rec: StoredAuth, code: unknown): 'totp' | 'recovery' | null {
    if (!rec.totp || typeof code !== 'string') return null;
    const c = code.trim();
    if (/^\d{6}$/.test(c)) {
      const counter = verifyTotp(unseal(this.totpKey(), rec.totp.secret), c, Date.now(), rec.totp.lastCounter);
      if (counter === null) return null;
      rec.totp.lastCounter = counter; this.writeAuth(rec); return 'totp';
    }
    const i = matchRecovery(c, rec.recovery || []);
    if (i < 0) return null;
    rec.recovery![i].usedAt = Date.now(); this.writeAuth(rec); return 'recovery';
  }
  /** Sign out every other session (password / 2FA changes). */
  private dropOtherSessions(keep: string): void {
    for (const id of [...this.sessions.keys()]) if (id !== keep) { this.sessions.delete(id); this.onLogout?.(id); }
  }
  private rotateSession(res: ServerResponse, old: Session): Session {
    this.sessions.delete(old.id); this.onLogout?.(old.id);
    return this.createSession(res);
  }

  // ---------- sessions ----------
  private parseCookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  public getSession(req: IncomingMessage): Session | null {
    const id = this.parseCookies(req)[COOKIE];
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  public isSessionValid(id: string): boolean {
    const s = this.sessions.get(id);
    return Boolean(s && Date.now() - s.lastSeen <= SESSION_IDLE_MS);
  }

  private createSession(res: ServerResponse): Session {
    const s: Session = { id: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url'), created: Date.now(), lastSeen: Date.now() };
    this.sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict${this.cookieSecure ? '; Secure' : ''}; Max-Age=${SESSION_IDLE_MS / 1000}`);
    return s;
  }

  private destroySession(res: ServerResponse, s: Session | null): void {
    if (s) {
      this.sessions.delete(s.id);
      this.onLogout?.(s.id);
    }
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${this.cookieSecure ? '; Secure' : ''}; Max-Age=0`);
  }

  // ---------- request checks ----------
  private hostOk(req: IncomingMessage): boolean {
    const host = (req.headers.host || '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return this.allowedHosts.has(name);
  }

  // Origin must be exactly this server's own origin (scheme + Host header).
  private originOk(req: IncomingMessage, requirePresent: boolean): boolean {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (!origin) return !requirePresent;
    if (origin === 'null') return false;
    const host = req.headers.host || '';
    return origin === `http://${host}` || origin === `https://${host}`;
  }

  private clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress || 'unknown';
  }

  private send(res: ServerResponse, status: number, body: any): true {
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
    }
    res.end(JSON.stringify(body));
    return true;
  }

  private readJson(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('Body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  public setSecurityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }

  /**
   * Handle an HTTP request. Returns true when the gate has fully answered it (auth endpoints or a
   * refusal); false when the request is authorised and should continue to the Express app.
   */
  public async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    this.setSecurityHeaders(res);
    const url = new URL(req.url || '/', 'http://local');
    const p = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    if (!this.hostOk(req)) return this.send(res, 403, { error: 'Host not allowed' });

    const isApi = p === '/api' || p.startsWith('/api/');
    if (!isApi) return false; // static frontend files carry no data

    if (method === 'OPTIONS') return this.send(res, 403, { error: 'Cross-origin requests are not allowed' });

    const stateChanging = method !== 'GET' && method !== 'HEAD';
    if (stateChanging) {
      if (!this.originOk(req, false)) return this.send(res, 403, { error: 'Cross-origin request refused' });
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) return this.send(res, 415, { error: 'Content-Type must be application/json' });
    } else if (!this.originOk(req, false)) {
      return this.send(res, 403, { error: 'Cross-origin request refused' });
    }

    // ----- auth endpoints (no session required) -----
    if (p === '/api/auth/status' && method === 'GET') {
      const s = this.getSession(req);
      return this.send(res, 200, { authenticated: Boolean(s), setupRequired: !this.hasPassword(), usernameRequired: false, emailRequired:true, csrfToken: s ? s.csrf : undefined });
    }

    if (p === '/api/auth/setup' && method === 'POST') {
      if (this.hasPassword() || !this.setupToken) return this.send(res, 409, { error: 'Admin password already set' });
      let body: any;
      try { body = await this.readJson(req); } catch (e: any) { return this.send(res, 400, { error: e.message }); }
      if (typeof body.setupToken !== 'string' || !safeEqual(body.setupToken, this.setupToken)) {
        return this.send(res, 403, { error: 'Invalid setup token (see the server console)' });
      }
      if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD) {
        return this.send(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters` });
      }
      this.writePassword(body.password);
      this.setupToken = null;
      const s = this.createSession(res);
      this.log('[Auth] Admin password set via setup token.');
      return this.send(res, 200, { success: true, csrfToken: s.csrf });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const ip = this.clientIp(req);
      const f = this.failures.get(ip);
      if (f && f.until > Date.now()) return this.send(res, 429, { error: 'Too many failed logins. Try again later.' });
      let body: any;
      try { body = await this.readJson(req); } catch (e: any) { return this.send(res, 400, { error: e.message }); }
      if (!this.hasPassword()) return this.send(res, 409, { error: 'Setup required' });
      const rec = this.readAuth();
      // a username is checked only once the administrator has set one (existing installs keep password-only login)
      // Email identity is a server-controlled account allowlist, never trusted from the frontend.
      const userOk = typeof body.email==='string' && body.email.trim().toLowerCase()===LOGIN_EMAIL;
      if (typeof body.password !== 'string' || !this.verifyPassword(body.password) || !userOk) {
        const cur = this.failures.get(ip) || { count: 0, until: 0 };
        cur.count++;
        if (cur.count >= 5) { cur.until = Date.now() + 15 * 60 * 1000; cur.count = 0; }
        this.failures.set(ip, cur);
        this.audit('login', req, false);
        return this.send(res, 401, { error: 'Invalid email or password' });
      }
      if (rec?.totp) {
        // password verified: a second step with the authenticator (or a recovery code) is required
        for (const [id, c] of this.challenges) if (Date.now() - c.created > CHALLENGE_MS) this.challenges.delete(id);
        const challenge = crypto.randomBytes(32).toString('base64url');
        this.challenges.set(challenge, { created: Date.now(), ip, attempts: 0 });
        this.audit('login.password', req, true);
        return this.send(res, 200, { success: true, twoFactorRequired: true, challenge });
      }
      this.failures.delete(ip);
      const s = this.createSession(res);
      this.audit('login', req, true);
      return this.send(res, 200, { success: true, csrfToken: s.csrf });
    }

    if (p === '/api/auth/login/2fa' && method === 'POST') {
      const ip = this.clientIp(req);
      const f = this.failures.get(ip);
      if (f && f.until > Date.now()) return this.send(res, 429, { error: 'Too many failed logins. Try again later.' });
      let body: any;
      try { body = await this.readJson(req); } catch (e: any) { return this.send(res, 400, { error: e.message }); }
      const ch = typeof body.challenge === 'string' ? this.challenges.get(body.challenge) : undefined;
      if (!ch || ch.ip !== ip || Date.now() - ch.created > CHALLENGE_MS) { if (ch) this.challenges.delete(body.challenge); return this.send(res, 401, { error: 'Sign-in expired. Enter your password again.' }); }
      const rec = this.readAuth();
      const used = rec ? this.checkSecondFactor(rec, body.code) : null;
      if (!used) {
        ch.attempts++;
        const cur = this.failures.get(ip) || { count: 0, until: 0 };
        cur.count++; if (cur.count >= 5) { cur.until = Date.now() + 15 * 60 * 1000; cur.count = 0; }
        this.failures.set(ip, cur);
        if (ch.attempts >= 5) this.challenges.delete(body.challenge);
        this.audit('login.2fa', req, false);
        return this.send(res, 401, { error: 'Invalid authentication code' });
      }
      this.challenges.delete(body.challenge);
      this.failures.delete(ip);
      const s = this.createSession(res);
      this.audit('login.2fa', req, true, used === 'recovery' ? 'recovery code used' : undefined);
      return this.send(res, 200, { success: true, csrfToken: s.csrf, recoveryCodeUsed: used === 'recovery', recoveryCodesLeft: used === 'recovery' ? (rec!.recovery || []).filter((r) => !r.usedAt).length : undefined });
    }

    // ----- everything else under /api needs a session -----
    const session = this.getSession(req);
    if (!session) return this.send(res, 401, { error: 'Authentication required' });

    if (stateChanging) {
      const token = String(req.headers['x-csrf-token'] || '');
      if (!token || !safeEqual(token, session.csrf)) return this.send(res, 403, { error: 'Missing or invalid CSRF token' });
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      this.destroySession(res, session);
      return this.send(res, 200, { success: true });
    }

    if (p.startsWith('/api/auth/')) return this.handleAccount(req, res, p, method, session);

    return false; // authorised: continue to Express
  }

  // ---------- account security (session + CSRF already verified) ----------
  private async handleAccount(req: IncomingMessage, res: ServerResponse, p: string, method: string, session: Session): Promise<true> {
    const rec = this.readAuth();
    if (!rec) return this.send(res, 409, { error: 'Setup required' });
    if (p === '/api/auth/account' && method === 'GET') {
      return this.send(res, 200, {
        username: rec.username || null, passwordChangedAt: rec.passwordChangedAt || rec.createdAt || null, usernameChangedAt: rec.usernameChangedAt || null,
        twoFactor: { enabled: Boolean(rec.totp), enabledAt: rec.totp?.enabledAt || null, pending: Boolean(rec.pendingTotp), recoveryCodesLeft: rec.totp ? (rec.recovery || []).filter((r) => !r.usedAt).length : 0 },
        otherSessions: [...this.sessions.keys()].filter((id) => id !== session.id && this.isSessionValid(id)).length,
      });
    }
    if (method !== 'POST') return this.send(res, 404, { error: 'Not found' });
    if (this.sensitiveLocked(req)) return this.send(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
    let body: any;
    try { body = await this.readJson(req); } catch (e: any) { return this.send(res, 400, { error: e.message }); }
    const event = p.slice('/api/auth/'.length);
    const needPassword = () => {
      if (this.verifyPassword(body.currentPassword)) return true;
      this.sensitiveFail(req); this.audit(event, req, false, 'wrong current password'); return false;
    };
    // with 2FA enabled, account changes also need an authenticator / recovery code
    const needSecond = () => {
      if (!rec.totp) return true;
      if (this.checkSecondFactor(rec, body.code)) return true;
      this.sensitiveFail(req); this.audit(event, req, false, 'invalid 2FA code'); return false;
    };
    switch (p) {
      case '/api/auth/username': {
        const u = typeof body.username === 'string' ? body.username.trim() : '';
        if (!USERNAME_RE.test(u)) return this.send(res, 400, { error: 'Username: 3–32 letters, digits, dot, dash or underscore' });
        if (rec.username && rec.username.toLowerCase() === u.toLowerCase()) return this.send(res, 409, { error: 'That is already the username' });
        if (!needPassword()) return this.send(res, 403, { error: 'Current password is incorrect' });
        if (!needSecond()) return this.send(res, 403, { error: 'Invalid authentication code' });
        const fresh = this.readAuth()!; fresh.username = u; fresh.usernameChangedAt = Date.now(); this.writeAuth(fresh);
        this.audit('username', req, true);
        return this.send(res, 200, { success: true, username: u });
      }
      case '/api/auth/password': {
        const problem = passwordProblem(body.newPassword, rec.username);
        if (problem) return this.send(res, 400, { error: problem });
        if (!needPassword()) return this.send(res, 403, { error: 'Current password is incorrect' });
        if (body.newPassword === body.currentPassword) return this.send(res, 400, { error: 'Choose a password different from the current one' });
        if (!needSecond()) return this.send(res, 403, { error: 'Invalid authentication code' });
        this.writePassword(body.newPassword);
        this.dropOtherSessions(session.id);
        const s = this.rotateSession(res, session);
        this.audit('password', req, true, 'other sessions signed out');
        return this.send(res, 200, { success: true, csrfToken: s.csrf });
      }
      case '/api/auth/2fa/setup': {
        if (rec.totp) return this.send(res, 409, { error: '2FA is already enabled' });
        if (!needPassword()) return this.send(res, 403, { error: 'Current password is incorrect' });
        const secret = newSecret(), b32 = base32Encode(secret);
        const fresh = this.readAuth()!; fresh.pendingTotp = { secret: seal(this.totpKey(), secret), createdAt: Date.now() }; this.writeAuth(fresh);
        this.audit('2fa.setup', req, true);
        // shown once for enrollment; never logged or stored in plain text
        return this.send(res, 200, { success: true, secret: b32, otpauthUri: otpauthUri(b32, fresh.username || 'admin') });
      }
      case '/api/auth/2fa/enable': {
        if (rec.totp) return this.send(res, 409, { error: '2FA is already enabled' });
        if (!rec.pendingTotp || Date.now() - rec.pendingTotp.createdAt > 30 * 60 * 1000) return this.send(res, 409, { error: 'Start the enrollment again' });
        const secret = unseal(this.totpKey(), rec.pendingTotp.secret);
        const counter = typeof body.code === 'string' ? verifyTotp(secret, body.code.trim(), Date.now(), null) : null;
        if (counter === null) { this.sensitiveFail(req); this.audit('2fa.enable', req, false); return this.send(res, 400, { error: 'Code does not match. Check the time on your phone and try the current code.' }); }
        const codes = newRecoveryCodes();
        const fresh = this.readAuth()!;
        fresh.totp = { secret: fresh.pendingTotp!.secret, enabledAt: Date.now(), lastCounter: counter };
        fresh.recovery = codes.map(recoveryVerifier); delete fresh.pendingTotp; this.writeAuth(fresh);
        this.dropOtherSessions(session.id);
        this.audit('2fa.enable', req, true);
        return this.send(res, 200, { success: true, recoveryCodes: codes });
      }
      case '/api/auth/2fa/cancel': {
        const fresh = this.readAuth()!; delete fresh.pendingTotp; this.writeAuth(fresh);
        return this.send(res, 200, { success: true });
      }
      case '/api/auth/2fa/disable': {
        if (!rec.totp) return this.send(res, 409, { error: '2FA is not enabled' });
        if (!needPassword()) return this.send(res, 403, { error: 'Current password is incorrect' });
        if (!needSecond()) return this.send(res, 403, { error: 'Invalid authentication code' });
        const fresh = this.readAuth()!; delete fresh.totp; delete fresh.recovery; delete fresh.pendingTotp; this.writeAuth(fresh);
        this.audit('2fa.disable', req, true);
        return this.send(res, 200, { success: true });
      }
      case '/api/auth/2fa/recovery-codes': {
        if (!rec.totp) return this.send(res, 409, { error: '2FA is not enabled' });
        if (!needPassword()) return this.send(res, 403, { error: 'Current password is incorrect' });
        if (!needSecond()) return this.send(res, 403, { error: 'Invalid authentication code' });
        const codes = newRecoveryCodes();
        const fresh = this.readAuth()!; fresh.recovery = codes.map(recoveryVerifier); this.writeAuth(fresh);
        this.audit('2fa.recovery-codes', req, true);
        return this.send(res, 200, { success: true, recoveryCodes: codes });
      }
    }
    return this.send(res, 404, { error: 'Not found' });
  }

  /** Authorise a WebSocket upgrade. Returns the session id, or null to refuse. */
  public authorizeUpgrade(req: IncomingMessage): { ok: true; sessionId: string } | { ok: false; status: number; reason: string } {
    if (!this.hostOk(req)) return { ok: false, status: 403, reason: 'Host not allowed' };
    if (!this.originOk(req, true)) return { ok: false, status: 403, reason: 'Origin not allowed' };
    const s = this.getSession(req);
    if (!s) return { ok: false, status: 401, reason: 'Authentication required' };
    return { ok: true, sessionId: s.id };
  }
}
