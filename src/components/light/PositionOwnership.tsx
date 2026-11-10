import React, { useEffect, useState } from 'react';
import { postJson } from './Modal.tsx';

export type PumpOwnership = { id: string; symbol: string; status: string };

export function usePumpOwnership() {
  const [trades, setTrades] = useState<PumpOwnership[]>([]);
  const refresh = async () => {
    try {
      const r = await fetch('/api/pump-short/positions');
      if (r.ok) setTrades((await r.json()).trades || []);
    } catch { /* Show legacy ownership when Pump data is unavailable. */ }
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, []);
  return { trades, refresh };
}

export function PositionOwnershipActions({ id, symbol, side, owner, pump, refresh }:
  { id: string; symbol: string; side: string; owner: string; pump?: PumpOwnership; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activePump = Boolean(pump && ['OPEN', 'ENTRY_PENDING', 'EXIT_PENDING'].includes(pump.status));
  const action = async (label: string, endpoint: string, body: object) => {
    if (!window.confirm(`${label} ${symbol} ${side}?\nThis changes strategy management only. The exchange position stays open; no order is placed.`)) return;
    setBusy(true); setError('');
    try {
      const r = await postJson(endpoint, body);
      if (!r.ok) throw Error(r.data?.error || r.data?.message || 'Management transfer rejected');
      await refresh();
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const addPump = async () => {
    if (!window.confirm(`Move ${symbol} SHORT to Pump Positions?\nThis adopts the existing Bybit position without opening a new trade. Pump may close it automatically after being armed.`)) return;
    setBusy(true); setError('');
    try {
      let result = await postJson('/api/pump-short/positions/adopt', { symbol, confirm: true });
      if (!result.ok && String(result.data?.error || '').startsWith('WAVE_LOW_REQUIRED:')) {
        const answer = window.prompt(`The scanner has no valid wave low for ${symbol}.\nEnter its confirmed pump wave LOW price (below your SHORT entry). This sets the Pump exit target:`);
        if (answer === null) return;
        const waveLow = Number(answer);
        if (!answer.trim() || !Number.isFinite(waveLow) || waveLow <= 0) throw Error('Enter a valid positive wave low');
        result = await postJson('/api/pump-short/positions/adopt', { symbol, waveLow, confirm: true });
      }
      if (!result.ok) throw Error(result.data?.error || 'Pump transfer rejected');
      await refresh();
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minWidth: 160 }}>
    {activePump ? <button type="button" disabled={busy || pump?.status !== 'OPEN'} className="row-act" onClick={() => void action('Remove from Pump', `/api/pump-short/positions/${pump!.id}/release`, { confirm: true })}>Remove Pump</button>
      : owner === 'bot' ? <button type="button" disabled={busy} className="row-act" onClick={() => void action('Remove from BOT', `/api/positions/${id}/transfer`, { targetOwner: 'external' })}>Remove BOT</button>
        : <>
          <button type="button" disabled={busy} className="row-act" onClick={() => void action('Add to BOT', `/api/positions/${id}/transfer`, { targetOwner: 'bot' })}>Add BOT</button>
          {side === 'Sell' && <button type="button" disabled={busy} className="row-act" onClick={() => void addPump()}>Move to Pump</button>}
        </>}
    {error && <small role="alert" className="red" title={error} style={{ flexBasis: '100%' }}>{error}</small>}
  </div>;
}
