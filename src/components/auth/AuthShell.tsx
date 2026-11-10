import React, { useEffect, useState } from 'react';
import { setCsrfToken } from '../../security/apiClient.ts';

type Status = 'loading' | 'login' | 'setup' | 'twofactor' | 'ready' | 'error';

// Phase 2: nothing in the dashboard renders or connects (REST or WebSocket) until the user is
// authenticated. The first-run setup needs the one-time token printed in the server console.
export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<Status>('loading');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [usernameRequired, setUsernameRequired] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async () => {
    try {
      const r = await fetch('/api/auth/status');
      const d = await r.json();
      if (d.authenticated) {
        setCsrfToken(d.csrfToken);
        setStatus('ready');
      } else {
        setCsrfToken(null);
        setUsernameRequired(Boolean(d.usernameRequired));
        setStatus(d.setupRequired ? 'setup' : 'login');
      }
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    check();
    const onAuth = () => { setCsrfToken(null); setStatus('login'); };
    window.addEventListener('tb-auth-required', onAuth);
    return () => window.removeEventListener('tb-auth-required', onAuth);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = status === 'setup' ? '/api/auth/setup' : status === 'twofactor' ? '/api/auth/login/2fa' : '/api/auth/login';
      const body = status === 'setup' ? { setupToken: setupToken.trim(), password } : status === 'twofactor' ? { challenge, code: code.trim() } : { password, ...(usernameRequired || username ? { username: username.trim() } : {}) };
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { if (status === 'twofactor' && /expired/i.test(d.error || '')) { setStatus('login'); setChallenge(null); setCode(''); } throw new Error(d.error || 'Login failed'); }
      if (d.twoFactorRequired) { setChallenge(d.challenge); setPassword(''); setStatus('twofactor'); return; }
      if (d.recoveryCodeUsed) setNotice(`A recovery code was used. ${d.recoveryCodesLeft} left — generate new codes on the Security page if needed.`);
      setChallenge(null); setCode('');
      setCsrfToken(d.csrfToken);
      setPassword('');
      setSetupToken('');
      setStatus('ready');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (status === 'ready') {
    return (
      <>
        {children}
        {notice && <div role="status" style={{ position: 'fixed', left: 14, bottom: 12, zIndex: 80, background: '#1a1a20', border: '1px solid #dda052', color: '#dda052', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>{notice} <button type="button" onClick={() => setNotice('')} style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}>×</button></div>}
        <button
          type="button"
          className="tb-logout-float"
          onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); setCsrfToken(null); setStatus('login'); }}
          style={{ position: 'fixed', right: 14, bottom: 12, zIndex: 80, background: '#1a1a20', border: '1px solid #2c2c3a', color: '#adb1b8', padding: '6px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer' }}
        >
          Log out
        </button>
      </>
    );
  }

  const box: React.CSSProperties = { width: '100%', maxWidth: 380, background: '#131317', border: '1px solid #28282e', borderRadius: 6, padding: 24 };
  const input: React.CSSProperties = { width: '100%', background: '#101014', border: '1px solid #2c2c3a', color: '#fafafa', padding: '9px 12px', borderRadius: 3, fontSize: 16, marginTop: 6, boxSizing: 'border-box' };
  return (
    <div style={{ minHeight: '100vh', background: '#101014', color: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {status === 'loading' && <div>Checking session…</div>}
      {status === 'error' && <div>Cannot reach the TradeBot server.</div>}
      {(status === 'login' || status === 'setup' || status === 'twofactor') && (
        <form onSubmit={submit} style={box}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>TradeBot Pro</div>
          <div style={{ fontSize: 12, color: '#8d9098', marginBottom: 16 }}>
            {status === 'setup'
              ? 'First run: enter the one-time setup token shown in the server console, then choose an admin password (10+ characters).'
              : status === 'twofactor' ? 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'
              : 'Sign in with the admin account.'}
          </div>
          {status === 'twofactor' && (
            <label style={{ fontSize: 12, display: 'block' }}>
              Authentication code
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoFocus style={input} data-testid="login-2fa-code" />
            </label>
          )}
          {status === 'login' && usernameRequired && (
            <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" style={input} />
            </label>
          )}
          {status === 'setup' && (
            <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              Setup token
              <input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" style={input} />
            </label>
          )}
          {status !== 'twofactor' && <label style={{ fontSize: 12, display: 'block' }}>
            {status === 'setup' ? 'New admin password' : 'Password'}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={status === 'setup' ? 'new-password' : 'current-password'} style={input} />
          </label>}
          {error && <div style={{ color: '#ed4f5d', fontSize: 12, marginTop: 10 }}>{error}</div>}
          <button type="submit" disabled={busy} style={{ marginTop: 16, width: '100%', background: '#dda052', color: '#101014', border: 0, padding: '10px 0', fontWeight: 700, borderRadius: 3, cursor: 'pointer' }}>
            {busy ? 'Please wait…' : status === 'setup' ? 'Set password' : status === 'twofactor' ? 'Verify' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  );
};

