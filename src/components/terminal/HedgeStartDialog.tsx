import React, { useEffect, useState } from 'react';
import {useDialogFocus} from '../light/useDialogFocus.ts';
import { createPortal } from 'react-dom';
import { post, px } from '../dashboard/ApiCard.tsx';

// Shared "Start hedge" dialog (Symbols page + Dashboard launchpad).
//   GET  /api/hedge/preview/:symbol?sizing=CUSTOM|MINIMUM   read-only: sizing + max leverage + fresh Bybit position check
//   POST /api/hedge/start { symbol, confirm: true, sizing }  ONLY when the user clicks Confirm
// Sizing:
//   CUSTOM  = the dashboard Buy / Sell values (unchanged behaviour).
//   MINIMUM = Bybit's minimum order value + 1 USDT for each side, quantity rounded up to the qty step; rules and price are read
//             fresh from Bybit for the check; if any of them cannot be verified the server refuses and sends nothing.

export type HedgeSizing = 'CUSTOM' | 'MINIMUM';
const fmtMargin = (m: number) => (m < 1 ? m.toFixed(4) : m.toFixed(2));

/** Bybit order rules used by a MINIMUM preview (read fresh from Bybit by the server). */
export const RulesLine: React.FC<{ preview: any }> = ({ preview }) => {
  const r = preview?.rules;
  return (
    <div className="t-help" data-testid="min-rules">
      Bybit rules (read now): qty step <b>{r ? r.qtyStep : '—'}</b> · min order qty <b>{r ? r.minQty : '—'}</b> · min order value <b>{r ? `${r.minNotional} USDT` : '—'}</b> · target <b>{r ? `${r.minNotional + 1} USDT` : '—'}</b> · price <b>{px(preview?.price)}</b> ({preview?.priceSource || '—'}) · max leverage <b>{preview?.leverage?.max ? `${preview.leverage.max}x` : '—'}</b>
      {r?.missing?.length ? <span className="t-down"> · not returned by Bybit: {r.missing.join(', ')}</span> : null}
    </div>
  );
};

// A bot server older than this frontend ignores `sizing` (its preview has no `sizing` field) and would size with the
// Custom values: Minimum size must then be refused in the UI. Custom size keeps working.
export const NO_MINIMUM_ON_SERVER = 'This bot server does not support Minimum size yet (it needs the server update and a bot restart). Use Custom size.';
const previewSizing = (p: any): HedgeSizing => (p?.sizing === 'MINIMUM' ? 'MINIMUM' : 'CUSTOM');

/** Minimum-size quantities from a server preview (?sizing=MINIMUM): exact values the server would order. */
export const MinimumSizePreview: React.FC<{ preview: any }> = ({ preview }) => {
  if (preview && previewSizing(preview) !== 'MINIMUM') return <div className="t-msg bad" data-testid="min-unsupported">{NO_MINIMUM_ON_SERVER}</div>;
  const row = (label: string, q: any, isBuy: boolean) => (
    <tr>
      <td className={isBuy ? 'pos-buy' : 'pos-short'} style={{ fontWeight: 700 }}>{isBuy ? 'BUY' : 'SHORT'}</td>
      <td className="r t-num" data-testid={`min-qty-${label}`}>{q?.ok ? q.qty : '—'}</td>
      <td className="r t-num">{q?.ok ? `${q.actualNotional.toFixed(4)} USDT` : '—'}</td>
      <td className="r t-num">{q?.ok ? `${q.leverage}x` : '—'}</td>
      <td className="r t-num">{q?.ok ? `≈ ${fmtMargin(q.estMargin)} USDT` : '—'}</td>
      <td style={{ whiteSpace: 'normal' }} className={q?.ok ? 't-up' : 't-down'}>{q ? (q.ok ? 'OK' : q.error) : (preview?.blockers?.[0] || 'not available')}</td>
    </tr>
  );
  return (
    <div data-testid="min-size-preview">
      <div className="t-table-scroll" tabIndex={0} role="region" aria-label="Order preview table"><table className="t-table">
        <thead><tr><th>Side</th><th className="r">Quantity</th><th className="r">Est. value</th><th className="r">Leverage</th><th className="r">Est. margin</th><th>Check</th></tr></thead>
        <tbody>{row('Buy', preview?.buy, true)}{row('Sell', preview?.sell, false)}</tbody>
      </table></div>
      <RulesLine preview={preview} />
    </div>
  );
};

export const HedgeStartDialog: React.FC<{ symbol: string; pinRequired: boolean; onClose: () => void; onDone: () => void }> = ({ symbol, pinRequired, onClose, onDone }) => {
  // default option = the dashboard "Position Sizing" setting stored on the server; this start sends its own choice
  const [sizing, setSizing] = useState<HedgeSizing | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/hedge/settings').then((r) => r.json()).then((d) => alive && setSizing(d?.settings?.sizingMode === 'MINIMUM' ? 'MINIMUM' : 'CUSTOM')).catch(() => alive && setSizing('CUSTOM'));
    return () => { alive = false; };
  }, []);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef=useDialogFocus(true,busy,onClose);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!sizing) return;
    let alive = true;
    setPreview(null); setResult(null);
    fetch(`/api/hedge/preview/${encodeURIComponent(symbol)}?sizing=${sizing}`)
      .then((r) => r.json())
      .then((d) => alive && setPreview(d))
      .catch((e) => alive && setPreview({ symbol, ok: false, sizing, blockers: [e.message] }));
    return () => { alive = false; };
  }, [symbol, sizing]);

  const confirm = async () => {
    setBusy(true);
    const r = await post('/api/hedge/start', { symbol, confirm: true, pin, sizing });
    setBusy(false);
    setResult({ ok: r.ok, text: r.ok ? r.data.message : r.error });
    if (r.data?.preview) setPreview({ ...r.data.preview, done: r.ok });
    onDone();
  };

  const isMin = sizing === 'MINIMUM';
  const serverMismatch = Boolean(preview && previewSizing(preview) !== sizing);
  const sideRow = (label: string, qd: any, tpPct: number, isBuy: boolean) => (
    <tr>
      <td className={isBuy ? 'pos-buy' : 'pos-short'} style={{ fontWeight: 700 }}>{isBuy ? 'BUY' : 'SHORT'}</td>
      <td className="r t-num">{isMin ? 'minimum' : qd ? `${qd.notionalUsdt} USDT` : '—'}</td>
      <td className="r t-num">{qd ? `${qd.leverage}x` : '—'}</td>
      <td className="r t-num" data-testid={`dlg-qty-${label}`}>{qd?.ok || (qd && !isMin) ? qd.qty : '—'}</td>
      <td className="r t-num">{qd?.ok || (qd && !isMin) ? `${qd.actualNotional.toFixed(4)} USDT` : '—'}</td>
      <td className="r t-num">{qd?.ok || (qd && !isMin) ? `≈ ${fmtMargin(qd.estMargin)} USDT` : '—'}</td>
      <td className="r t-num">{qd && preview?.price ? `${tpPct}% → ${px(isBuy ? preview.price * (1 + tpPct / 100) : preview.price * (1 - tpPct / 100))}` : '—'}</td>
      <td style={{ whiteSpace: 'normal' }} className={qd?.ok ? 't-up' : 't-down'}>{qd ? (qd.ok ? 'OK' : qd.error) : '—'}</td>
    </tr>
  );

  const check = preview?.positionCheck;
  const segBtn = (v: HedgeSizing, label: string) => (
    <button type="button" className={`t-btn sm ${sizing === v ? 'long' : ''}`} disabled={busy || preview?.done} onClick={() => setSizing(v)} data-testid={`dlg-sizing-${v}`}>{label}</button>
  );
  // rendered into <body> so page styles (legacy tables, dashboard layout) never change the dialog
  return createPortal(
    <div className="t-modal-bg">
      <div ref={dialogRef} tabIndex={-1} className="t-modal" role="dialog" aria-modal="true" aria-label="Start hedge">
        <h2>Start hedge on <span className="t-mono">{symbol}</span></h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 10px' }} data-testid="dlg-sizing">
          <span className="t-label">Position size</span>
          {segBtn('CUSTOM', 'Custom Buy / Sell values')}
          {segBtn('MINIMUM', 'Minimum order + 1 USDT per side')}
        </div>
        {!preview ? <div className="t-sub">Checking {symbol} on Bybit (read-only)…</div> : (
          <>
            <div className="t-help" style={{ marginBottom: 6 }}>Price now {px(preview.price)} · checked on Bybit just now (read-only) · account margin mode {preview.marginMode || '—'}</div>
            <div style={{ fontSize: 13.5, marginBottom: 10 }} data-testid="hedge-leverage">
              Leverage for this cycle: {preview.leverage?.max ? <b>{preview.leverage.max}x — maximum permitted for {preview.symbol} on Bybit</b> : <b className="t-down">not available{preview.leverage?.error ? ` (${preview.leverage.error})` : ''}</b>}
            </div>
            {!serverMismatch && <div className="t-table-scroll" tabIndex={0} role="region" aria-label="Order preview table"><table className="t-table">
              <thead><tr><th>Side</th><th className="r">Value set</th><th className="r">Leverage</th><th className="r">Quantity</th><th className="r">Est. value</th><th className="r">Est. margin</th><th className="r">TP (at this price)</th><th>Check</th></tr></thead>
              <tbody>
                {sideRow('Buy', preview.buy, preview.settings?.buyTpPct, true)}
                {sideRow('Sell', preview.sell, preview.settings?.sellTpPct, false)}
              </tbody>
            </table></div>}
            {serverMismatch ? null : isMin ? (
              <div style={{ marginTop: 6 }}>
                <RulesLine preview={preview} />
                <div className="t-help" data-testid="dlg-min-help">Minimum size: each side targets Bybit's minimum order value + 1 USDT{preview.rules ? ` (${preview.rules.minNotional} + 1 = ${preview.rules.minNotional + 1} USDT)` : ''}; the quantity is rounded up to the quantity step (and is never below the minimum order quantity), at the symbol's maximum leverage. Each TP reopen repeats this with the rules and price read from Bybit at that moment. Your Custom Buy/Sell values are not changed.</div>
              </div>
            ) : (
              <div className="t-help" style={{ marginTop: 4 }}>Custom size: each side uses its own value from the dashboard (never split or raised). Quantity is rounded down to the {preview.symbol} quantity step, so the actual value can be slightly below the value set.</div>
            )}
            <div style={{ fontSize: 13, marginTop: 10 }}>
              Positions on Bybit for {preview.symbol}: {check === 'OK' ? <b className="t-up">none — OK to open</b> : check === 'FOUND' ? <b className="t-down">found (left untouched)</b> : check === 'ONE_WAY' ? <b className="t-down">one-way mode</b> : check === 'ERROR' ? <b className="t-down">check failed</b> : <b className="t-dim">not checked</b>}
            </div>
            {serverMismatch && <div className="t-msg bad" style={{ marginTop: 10 }} data-testid="min-unsupported">{NO_MINIMUM_ON_SERVER}</div>}
            {preview.blockers?.length > 0 && !preview.done && (
              <ul className="t-down" style={{ fontSize: 13, margin: '10px 0 0', paddingLeft: 18 }} data-testid="dlg-blockers">{preview.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>
            )}
            {preview.ok && !preview.done && (
              <div className="t-note" style={{ marginTop: 12, borderColor: 'rgba(239,68,68,.45)', background: 'rgba(239,68,68,.08)' }}>
                <span>
                  Confirming sends <b>two real market orders</b> to Bybit at about the same time: Buy {preview.buy?.qty} and Sell {preview.sell?.qty} {preview.symbol} (hedge mode{isMin ? ', minimum size' : ''}), and sets leverage <b>{preview.leverage?.max}x</b> (the {preview.symbol} maximum on Bybit) for both sides on this symbol — if Bybit refuses that leverage, no order is sent. After that the bot closes a side at its TP and reopens it {isMin ? 'at minimum size (minimum order value + 1 USDT) for the price at that moment' : 'with the same value'}; no TP order is placed on Bybit. Each fill is confirmed by Bybit; a rejected or partial side is reported and not retried. Other saved cycles are not resumed.
                </span>
              </div>
            )}
            {pinRequired && preview.ok && !preview.done && (
              <label className="t-field" style={{ marginTop: 10, maxWidth: 240 }}><span className="t-label">Security PIN</span><span className="t-input"><input type="password" value={pin} onChange={(e) => setPin(e.target.value)} /></span></label>
            )}
          </>
        )}
        {result && <div className={`t-msg ${result.ok ? 'ok' : 'bad'}`} style={{ marginTop: 10, fontSize: 13.5 }}>{result.text}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="t-btn" disabled={busy} onClick={onClose}>{preview?.done ? 'Close' : 'Cancel'}</button>
          {preview?.ok && !preview.done && !serverMismatch && <button type="button" className="t-btn short" disabled={busy} onClick={confirm} data-testid="dlg-confirm">{busy ? 'Opening…' : `Confirm: open real Buy + Sell (${isMin ? 'minimum size' : 'custom size'})`}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
};

