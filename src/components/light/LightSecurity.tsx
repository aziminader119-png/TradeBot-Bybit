import React, { useMemo, useState } from 'react';
import type { BotStateSummary } from '../../types/trading.ts';
import { ReportSummary, refreshReportRead, useRead } from './reports.tsx';
import { postJson } from './Modal.tsx';
import { DateTime } from './format.tsx';
import { setCsrfToken } from '../../security/apiClient.ts';
import qrcode from '../../vendor/qrcode-generator/qrcode.mjs';

// Security page: Security PIN (trading confirmations), admin username / password, Google Authenticator 2FA with
// recovery codes. Every change is verified on the server (current password; a 2FA code once 2FA is on) and audited.
// Secrets are shown once and never written to browser storage.
export type AccountInfo = { username: string | null; passwordChangedAt: number | null; usernameChangedAt: number | null; twoFactor: { enabled: boolean; enabledAt: number | null; pending: boolean; recoveryCodesLeft: number }; otherSessions: number };
const ACCOUNT_URL = '/api/auth/account';

function useAction() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const run = async (fn: () => Promise<string | void>) => { setBusy(true); setError(''); setMessage(''); try { const m = await fn(); if (m) setMessage(m); refreshReportRead(ACCOUNT_URL); } catch (e: any) { setError(e.message || 'Request failed'); } finally { setBusy(false); } };
  const out = <>{error && <p className="red" role="alert">{error}</p>}{message && <p className="green" role="status">{message}</p>}</>;
  return { busy, run, out };
}
async function post(url: string, body: any) { const r = await postJson(url, body); if (!r.ok) throw Error(r.data?.error || 'Request failed (' + r.status + ')'); return r.data; }

function QrSvg({ text }: { text: string }) {
  const svg = useMemo(() => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); }, [text]);
  return <div className="totp-qr" role="img" aria-label="Authenticator enrollment QR code" style={{ width: 200, height: 200, background: '#fff', padding: 4 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return <div className="recovery-codes" data-testid="recovery-codes"><p><b>Recovery codes — shown only once.</b> Store them offline. Each code signs in once if the phone is unavailable.</p>
    <ol style={{ columns: 2, fontFamily: 'monospace', fontSize: 14 }}>{codes.map((c) => <li key={c}>{c}</li>)}</ol>
    <div className="lp-risk-filter"><button type="button" onClick={() => { void navigator.clipboard?.writeText(codes.join('\n')).catch(() => {}); }}>Copy</button><button type="button" className="report-button" onClick={onDone}>I have saved them</button></div></div>;
}

export const LightSecurity: React.FC<{ state: BotStateSummary | null; onRefresh: () => void }> = ({ state, onRefresh }) => {
  const account = useRead<AccountInfo>(ACCOUNT_URL, 60000);
  const a = account.data, tfa = a?.twoFactor.enabled;
  // PIN (unchanged behaviour)
  const pin = useAction(); const has = Boolean(state?.settings?.hasSecurityPin);
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [repeat, setRepeat] = useState('');
  const savePin = (e: React.FormEvent) => { e.preventDefault(); void pin.run(async () => { if (next.trim().length < 4 || next !== repeat) throw Error('Use at least 4 characters and matching confirmation.'); const r = await postJson('/api/settings', { securityPin: next, currentPin: current }); if (!r.ok) throw Error(r.data?.error || 'PIN update failed'); setCurrent(''); setNext(''); setRepeat(''); onRefresh(); return 'Security PIN saved.'; }); };
  // username
  const user = useAction(); const [uName, setUName] = useState(''), [uPass, setUPass] = useState(''), [uCode, setUCode] = useState('');
  const saveUser = (e: React.FormEvent) => { e.preventDefault(); void user.run(async () => { const d = await post('/api/auth/username', { username: uName.trim(), currentPassword: uPass, code: uCode || undefined }); setUPass(''); setUCode(''); setUName(''); return 'Username changed to ' + d.username + '. Use it at the next sign-in.'; }); };
  // password
  const pw = useAction(); const [cur, setCur] = useState(''), [np, setNp] = useState(''), [np2, setNp2] = useState(''), [pCode, setPCode] = useState('');
  const savePw = (e: React.FormEvent) => { e.preventDefault(); void pw.run(async () => { if (np !== np2) throw Error('The new passwords do not match.'); const d = await post('/api/auth/password', { currentPassword: cur, newPassword: np, code: pCode || undefined }); setCsrfToken(d.csrfToken); setCur(''); setNp(''); setNp2(''); setPCode(''); return 'Password changed. All other sessions were signed out.'; }); };
  // 2FA
  const tf = useAction(); const [tPass, setTPass] = useState(''), [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null), [tCode, setTCode] = useState(''), [codes, setCodes] = useState<string[] | null>(null);
  const start = (e: React.FormEvent) => { e.preventDefault(); void tf.run(async () => { const d = await post('/api/auth/2fa/setup', { currentPassword: tPass }); setTPass(''); setEnroll({ secret: d.secret, otpauthUri: d.otpauthUri }); }); };
  const enable = (e: React.FormEvent) => { e.preventDefault(); void tf.run(async () => { const d = await post('/api/auth/2fa/enable', { code: tCode.trim() }); setEnroll(null); setTCode(''); setCodes(d.recoveryCodes); return '2FA enabled. Other sessions were signed out.'; }); };
  const cancel = () => void tf.run(async () => { await post('/api/auth/2fa/cancel', {}); setEnroll(null); setTCode(''); });
  const disable = (e: React.FormEvent) => { e.preventDefault(); void tf.run(async () => { await post('/api/auth/2fa/disable', { currentPassword: tPass, code: tCode.trim() }); setTPass(''); setTCode(''); return '2FA disabled.'; }); };
  const regen = () => void tf.run(async () => { const d = await post('/api/auth/2fa/recovery-codes', { currentPassword: tPass, code: tCode.trim() }); setTPass(''); setTCode(''); setCodes(d.recoveryCodes); return 'New recovery codes generated; the previous ones no longer work.'; });
  const codeField = (v: string, set: (s: string) => void) => tfa ? <label>2FA code (or recovery code)<input autoComplete="one-time-code" value={v} onChange={(e) => set(e.target.value)} required /></label> : null;

  return <div className="content" data-testid="security-page">
    <ReportSummary items={[['Admin Login', a ? 'Authenticated' : '—'], ['Username', a ? a.username || 'Not set (password only)' : '—'], ['Password changed', a?.passwordChangedAt ? new Date(a.passwordChangedAt).toLocaleDateString() : '—'], ['2FA', a ? (tfa ? 'Enabled' : 'Off') : '—'], ['Recovery codes left', a && tfa ? a.twoFactor.recoveryCodesLeft : '—'], ['Security PIN', state ? (has ? 'Configured' : 'Not set') : '—']]} />
    {account.error && <p className="red" role="alert">{account.error}</p>}
    <section className="section"><div className="legend">Username</div><form onSubmit={saveUser} className="security-form" data-testid="username-form">
      <p className="lp-source-note">{a?.username ? <>Current username: <b>{a.username}</b>{a.usernameChangedAt ? <> · changed <DateTime ts={a.usernameChangedAt} /></> : null}. Sign-in asks for it.</> : 'No username yet: sign-in uses the password only. Setting one makes it required at sign-in.'}</p>
      <label>New username<input autoComplete="username" value={uName} onChange={(e) => setUName(e.target.value)} pattern="[A-Za-z0-9._\-]{3,32}" title="3–32 letters, digits, dot, dash or underscore" required /></label>
      <label>Current password<input type="password" autoComplete="current-password" value={uPass} onChange={(e) => setUPass(e.target.value)} required /></label>
      {codeField(uCode, setUCode)}
      <button className="report-button" type="submit" disabled={user.busy || !a}>{user.busy ? 'Saving…' : 'Change username'}</button>
    </form>{user.out}</section>
    <section className="section"><div className="legend">Password</div><form onSubmit={savePw} className="security-form" data-testid="password-form">
      <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={12} value={np} onChange={(e) => setNp(e.target.value)} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" value={np2} onChange={(e) => setNp2(e.target.value)} required /></label>
      {codeField(pCode, setPCode)}
      <p className="lp-source-note">At least 12 characters with three of: lower-case, upper-case, digits, symbols. Changing it signs out every other session{a ? ` (${a.otherSessions} now)` : ''}.</p>
      <button className="report-button" type="submit" disabled={pw.busy || !a}>{pw.busy ? 'Saving…' : 'Change password'}</button>
    </form>{pw.out}</section>
    <section className="section" data-testid="twofa-section"><div className="legend">Google Authenticator (2FA)</div>
      {codes ? <Codes codes={codes} onDone={() => setCodes(null)} />
        : enroll ? <form onSubmit={enable} className="security-form">
          <p>Scan with Google Authenticator (or any TOTP app), then enter the 6-digit code to activate. 2FA is not active until this code is verified.</p>
          <QrSvg text={enroll.otpauthUri} />
          <label>Setup key (manual entry)<input readOnly value={enroll.secret.replace(/(.{4})/g, '$1 ').trim()} onFocus={(e) => e.currentTarget.select()} /></label>
          <label>Code from the app<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={tCode} onChange={(e) => setTCode(e.target.value)} required data-testid="totp-enable-code" /></label>
          <div className="lp-risk-filter"><button className="report-button" type="submit" disabled={tf.busy}>Activate 2FA</button><button type="button" onClick={cancel} disabled={tf.busy}>Cancel</button></div>
        </form>
          : tfa ? <form onSubmit={disable} className="security-form">
            <p className="green">2FA is enabled{a?.twoFactor.enabledAt ? <> since <DateTime ts={a.twoFactor.enabledAt} /></> : null}. {a?.twoFactor.recoveryCodesLeft} recovery code(s) left.</p>
            <label>Current password<input type="password" autoComplete="current-password" value={tPass} onChange={(e) => setTPass(e.target.value)} required /></label>
            <label>2FA code (or recovery code)<input autoComplete="one-time-code" value={tCode} onChange={(e) => setTCode(e.target.value)} required /></label>
            <div className="lp-risk-filter"><button type="button" onClick={regen} disabled={tf.busy || !tPass || !tCode}>Generate new recovery codes</button><button className="report-button" type="submit" disabled={tf.busy}>Disable 2FA</button></div>
          </form>
            : <form onSubmit={start} className="security-form">
              <p>Off. Enabling adds a 6-digit authenticator code to every sign-in and to account changes. You receive one-time recovery codes in case the phone is lost.</p>
              <label>Current password<input type="password" autoComplete="current-password" value={tPass} onChange={(e) => setTPass(e.target.value)} required /></label>
              <button className="report-button" type="submit" disabled={tf.busy || !a} data-testid="totp-start">Set up 2FA</button>
            </form>}
      {tf.out}
    </section>
    <section className="section"><div className="legend">Security PIN</div><form onSubmit={savePin} className="security-form">
      {has && <label>Current PIN<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>}
      <label>New PIN<input type="password" autoComplete="new-password" minLength={4} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
      <label>Confirm PIN<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></label>
      <button className="report-button" type="submit" disabled={pin.busy || !state}>{pin.busy ? 'Saving…' : 'Save PIN'}</button>
    </form>{pin.out}</section>
    <p className="lp-source-note">Bybit API keys are managed on the Dashboard (BYBIT API Connection), separately from the admin account. Locked out of 2FA with no recovery code? On the server, an administrator can run <code>node scripts/disable-2fa.mjs</code> in the app folder (keeps the password).</p>
  </div>;
};
