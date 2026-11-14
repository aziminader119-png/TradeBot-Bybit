import React, { useEffect, useState } from 'react';
import { setCsrfToken } from '../../security/apiClient.ts';
import './auth-v19.css';

type Status = 'loading' | 'login' | 'setup' | 'twofactor' | 'ready' | 'error';

// Phase 2: nothing in the dashboard renders or connects (REST or WebSocket) until the user is
// authenticated. The first-run setup needs the one-time token printed in the server console.
export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<Status>('loading');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
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
        // Email and password are the only enabled sign-in method.
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
      const body = status === 'setup' ? { setupToken: setupToken.trim(), password } : status === 'twofactor' ? { challenge, code: code.trim() } : { email:email.trim().toLowerCase(), password };
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

  return (
    <main className="tb-auth-v19">
      <div className="tb-auth-glow tb-auth-glow-left" aria-hidden="true" />
      <div className="tb-auth-glow tb-auth-glow-right" aria-hidden="true" />
      <header className="tb-auth-topbar">
        <div className="tb-auth-wordmark"><span className="tb-auth-brand-icon">T</span><strong>TRADEBOT <em>PRO</em></strong></div>
        <div className="tb-auth-top-status"><span className="tb-auth-status-dot" /> SECURE TRADING TERMINAL</div>
      </header>
      <div className="tb-auth-center">
        <div className="tb-auth-hero">
          <div className="tb-auth-eyebrow"><span className="tb-auth-eyebrow-line" /> BYBIT FUTURES MANAGEMENT</div>
          <h1>Welcome back<span>.</span></h1>
          <p>Access your private trading workspace.</p>
        </div>
        <section className="tb-auth-panel" aria-label="TradeBot Pro access">
          <div className="tb-auth-tabs" role="tablist" aria-label="Sign in method"><button type="button" role="tab" aria-selected="true" className="selected">Email</button><button type="button" role="tab" aria-selected="false" disabled title="Coming soon">Mobile</button></div>
          <div className="tb-auth-panel-header">
            <div className="tb-auth-panel-symbol" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5.5" y="10" width="13" height="10" rx="2"/>
                <path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3"/>
                <circle cx="12" cy="15" r="1"/>
              </svg>
            </div>
            <div><h2>{status === 'setup' ? 'Initialize terminal' : status === 'twofactor' ? 'Security verification' : 'Sign in to your account'}</h2>
            <p>{status === 'setup' ? 'Create your administrator credentials' : status === 'twofactor' ? 'Complete your second authentication step' : 'Enter your credentials to continue'}</p></div>
          </div>
          {status === 'loading' && <div className="tb-auth-message" role="status">Checking secure session…</div>}
          {status === 'error' && <div className="tb-auth-message" role="alert">Connection unavailable. <button type="button" onClick={() => void check()}>Retry</button></div>}
          {(status === 'login' || status === 'setup' || status === 'twofactor') && <form className="tb-auth-form" onSubmit={submit}>
            {status === 'setup' && <div className="tb-auth-help">Enter the one-time setup token from your server and create an admin password with at least 10 characters.</div>}
            {status === 'twofactor' && <div className="tb-auth-help">Use a code from your authenticator app, or a recovery code.</div>}
            {status === 'login' && <label className="tb-auth-field">
              <span>EMAIL ADDRESS</span>
              <input type="email" required autoComplete="email" inputMode="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} data-testid="login-email"/>
            </label>}
            {status === 'setup' && <label className="tb-auth-field">
              <span>SETUP TOKEN</span>
              <input required autoComplete="off" placeholder="One-time setup token" value={setupToken} onChange={e => setSetupToken(e.target.value)} />
            </label>}
            {status === 'twofactor' ? <label className="tb-auth-field">
              <span>AUTHENTICATION CODE</span>
              <input required autoComplete="one-time-code" inputMode="text" autoFocus placeholder="6-digit code or recovery code" value={code} onChange={e => setCode(e.target.value)} data-testid="login-2fa-code" />
            </label> : <label className="tb-auth-field">
              <span>{status === 'setup' ? 'NEW ADMIN PASSWORD' : 'PASSWORD'}</span>
              <input required type="password" minLength={status === 'setup' ? 10 : undefined} autoComplete={status === 'setup' ? 'new-password' : 'current-password'} placeholder={status === 'setup' ? 'Create a strong password' : 'Enter your password'} value={password} onChange={e => setPassword(e.target.value)} />
            </label>}
            {status === 'login' && <button type="button" className="tb-auth-forgot" disabled title="Password recovery is not enabled">Forgot password? <span>Coming soon</span></button>}
            {error && <div className="tb-auth-error" role="alert">{error}</div>}
            <button type="submit" className="tb-auth-submit" disabled={busy}>
              <span>{busy ? 'Please wait…' : status === 'setup' ? 'Create administrator account' : status === 'twofactor' ? 'Verify and continue' : 'Log In'}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
            {status === 'twofactor' && <button type="button" className="tb-auth-back" onClick={() => { setStatus('login'); setChallenge(null); setCode(''); setError(''); }}>Back to sign in</button>}
          </form>}
          {status === 'login' && <div className="tb-auth-extras">
            <div className="tb-auth-or"><span>or sign in with</span></div>
            <div className="tb-auth-providers">
              <button type="button" disabled title="Coming soon">Google</button>
              <button type="button" disabled title="Coming soon">Apple</button>
              <button type="button" disabled title="Coming soon">Web3</button>
            </div>
            <p>Don't have an account? <button type="button" disabled title="Registration is not enabled">Sign up</button></p>
          </div>}
        </section>
        <div className="tb-auth-security"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m12 3 8 4v5c0 5-3.5 7.7-8 9-4.5-1.3-8-4-8-9V7l8-4Z"/><path d="m9 12 2 2 4-4"/></svg><span>Protected session · Email and password sign-in</span></div>
      </div>
      <footer className="tb-auth-footer"><span>TRADEBOT PRO</span><span>PRIVATE TRADING WORKSPACE</span></footer>
    </main>
  );
};
