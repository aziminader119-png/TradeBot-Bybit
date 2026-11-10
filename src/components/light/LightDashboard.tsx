import {TradeAlertSettings} from '../notifications/TradeNotifications.tsx';
import React, { useEffect, useState } from 'react';
import { BotStateSummary } from '../../types/trading.ts';
import type { StrategyCycle } from '../../types/strategy.ts';
import { LightModal, postJson, useToast } from './Modal.tsx';
import { syncedPositions } from './LightShell.tsx';
import { SideLabel, SymbolSide } from './format.tsx';
import { useRead } from './reports.tsx';
import { linkClick, navigate } from './navigation.ts';
import type { AccountInfo } from './LightSecurity.tsx';

// Dashboard content of the approved light design. Saves go to the server (/api/hedge/settings, /api/settings);
// nothing is stored only in the browser. Boxes without a backend in this version are shown disabled.

const LONG = '#39AA77', SHORT = '#ED4F5D'; // position-side colours (BUY / SHORT)
const boxStyle: React.CSSProperties = { minWidth: 0, border: '1px solid rgb(48,51,58)', borderRadius: 0, padding: '12px 12px 10px', background: 'rgb(16,16,20)', boxSizing: 'border-box' };
const legendStyle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: 'rgb(244,246,250)', padding: '0 8px', marginLeft: 2 };
const labelStyle = (color?: string): React.CSSProperties => ({ display: 'grid', gap: 6, minWidth: 0, fontSize: 11, ...(color ? { color } : {}) });
const str = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const fmt = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

type Hedge = { buyNotionalUsdt: number; sellNotionalUsdt: number; buyTpPct: number; sellTpPct: number; sizingMode?: 'CUSTOM' | 'MINIMUM' };
type Affected = { symbol: string; side: 'Buy' | 'Sell'; entry: number; price: number | null; movePct: number | null; newTpPct: number; tpPrice: number; managed: boolean };

const Box: React.FC<{ legend: string; children: React.ReactNode; onSave?: () => void; saving?: boolean; status?: string | null; error?: string | null; unavailable?: boolean; testid?: string; className?: string; inlineSave?: boolean }> = (p) => (
  <fieldset className={`tradebot-settings-box${p.className ? ' ' + p.className : ''}`} style={boxStyle} data-testid={p.testid}>
    <legend style={legendStyle}>{p.legend}</legend>
    {p.children}
    {p.unavailable && <div className="unavailable-note">Not available in this version</div>}
    {p.error && <div className="field-error" data-testid={p.testid ? `${p.testid}-error` : undefined}>{p.error}</div>}
    {!p.inlineSave && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
      <button className="save" type="button" disabled={p.unavailable || p.saving || !p.onSave} onClick={p.onSave}>{p.saving ? 'Saving…' : 'Save'}</button>
    </div>}
    {p.status && <small className="saved-status" data-testid={p.testid ? `${p.testid}-status` : undefined}>{p.status}</small>}
  </fieldset>
);

const PairInputs: React.FC<{ name: string; long: string; short: string; onLong?: (v: string) => void; onShort?: (v: string) => void; disabled?: boolean; testid?: string }> = (p) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0px,1fr))', gap: 8 }}>
    <label style={labelStyle(LONG)}>LONG<input aria-label={`${p.name} LONG`} type="number" min="0.000001" step="any" value={p.long} placeholder={p.disabled ? '—' : ''} disabled={p.disabled} onChange={(e) => p.onLong?.(e.target.value)} data-testid={p.testid ? `${p.testid}-long` : undefined} /></label>
    <label style={labelStyle(SHORT)}>SHORT<input aria-label={`${p.name} SHORT`} type="number" min="0.000001" step="any" value={p.short} placeholder={p.disabled ? '—' : ''} disabled={p.disabled} onChange={(e) => p.onShort?.(e.target.value)} data-testid={p.testid ? `${p.testid}-short` : undefined} /></label>
  </div>
);

const Unavailable2: React.FC<{ legend: string; a: string; b: string }> = ({ legend, a, b }) => (
  <Box legend={legend} unavailable>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0px,1fr))', gap: 8 }}>
      <label style={labelStyle()}>{a}<input type="number" disabled placeholder="—" aria-label={`${legend} ${a}`} /></label>
      <label style={labelStyle()}>{b}<input type="number" disabled placeholder="—" aria-label={`${legend} ${b}`} /></label>
    </div>
  </Box>
);

export const LightDashboard: React.FC<{ state: BotStateSummary | null; onRefresh: () => void }> = ({ state, onRefresh }) => {
  const account = useRead<AccountInfo>('/api/auth/account', 120000);
  const [toast, showToast] = useToast();
  const [pump, setPump] = useState({ minGrowthPct: '20', lookbackDays: '10', retracementPct: '50', positionNotionalUsdt: '30', maxPositions: '10' });
  const [pumpSaving, setPumpSaving] = useState(false);
  const [pumpStatus, setPumpStatus] = useState<string | null>(null);
  const [pumpError, setPumpError] = useState<string | null>(null);
  const [pumpExecution, setPumpExecution] = useState<{ armed: boolean; mode: string } | null>(null);
  const [pumpArmBusy, setPumpArmBusy] = useState(false);
  const [pumpArmError, setPumpArmError] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => void fetch('/api/pump-short/positions').then(r => r.json()).then(d =>
      setPumpExecution({ armed: Boolean(d.armed), mode: String(d.mode || 'OFF') })).catch(() => {});
    refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer);
  }, []);
  const armPump = async (enabled: boolean) => {
    if (!window.confirm(enabled ? 'Enable REAL Pump Short orders? Up to 10 simultaneous Pump Short positions may be opened.' : 'Stop Pump Short entries and exits? Existing positions will remain open.')) return;
    setPumpArmBusy(true); setPumpArmError(null);
    try {
      const r = await postJson('/api/pump-short/arm', { enabled, confirm: true });
      if (!r.ok) throw Error(r.data?.error || `HTTP ${r.status}`);
      setPumpExecution({ armed: Boolean(r.data.armed), mode: String(r.data.mode) });
      showToast(enabled ? 'Pump Short execution enabled' : 'Pump Short execution stopped');
    } catch (e: any) { setPumpArmError(e.message); }
    finally { setPumpArmBusy(false); }
  };
  useEffect(() => {
    fetch('/api/pump-short/settings').then(async r => {
      const d = await r.json();
      if (!r.ok || !d.settings) throw Error(d.error || 'Cannot load Pump Short settings');
      const s = d.settings;
      setPump({ minGrowthPct: String(s.minGrowthPct), lookbackDays: String(s.lookbackDays), retracementPct: String(s.retracementPct), positionNotionalUsdt: String(s.positionNotionalUsdt), maxPositions: String(s.maxPositions ?? 10) });
    }).catch(e => setPumpError(e.message));
  }, []);
  const savePump = async () => {
    const body = { minGrowthPct: Number(pump.minGrowthPct), lookbackDays: Number(pump.lookbackDays), retracementPct: Number(pump.retracementPct), positionNotionalUsdt: Number(pump.positionNotionalUsdt), maxPositions: Number(pump.maxPositions) };
    if (Object.values(pump).some(v => v.trim() === '') || !Number.isInteger(body.lookbackDays) || body.lookbackDays < 1 || body.lookbackDays > 365 || body.minGrowthPct <= 0 || body.retracementPct <= 0 || body.retracementPct > 100 || body.positionNotionalUsdt <= 0 || !Number.isInteger(body.maxPositions) || body.maxPositions < 1 || body.maxPositions > 200 || !Object.values(body).every(Number.isFinite)) {
      setPumpError('Enter valid values; days 1–365, exit 1–100%, max positions 1–200.');
      return;
    }
    setPumpSaving(true); setPumpError(null); setPumpStatus(null);
    try {
      const r = await postJson('/api/pump-short/settings', body);
      if (!r.ok) throw Error(r.data?.error || `HTTP ${r.status}`);
      setPumpStatus('Saved on server');
      showToast('Pump Short settings saved');
      onRefresh();
    } catch (e: any) { setPumpError(e.message); }
    finally { setPumpSaving(false); }
  };
  const [hedge, setHedge] = useState<Hedge | null>(null);
  const [hedgeLoading,setHedgeLoading]=useState(true),[hedgeLoadError,setHedgeLoadError]=useState<string|null>(null);
  const [mode, setMode] = useState<'CUSTOM' | 'MINIMUM'>('CUSTOM');
  const [size, setSize] = useState({ long: '', short: '' });
  const [tp, setTp] = useState({ long: '', short: '' });
  const [boxState, setBoxState] = useState<Record<string, { saving?: boolean; status?: string | null; error?: string | null }>>({});
  const [tpConfirm, setTpConfirm] = useState<Affected[] | null>(null);
  // Risk Thresholds (Deep Loss / Deep Profit page filters): saved on the server, shown from the live snapshot
  const savedRisk = (state?.settings as any)?.riskThresholds as { deepLossPct: number; deepProfitPct: number; highMarginUsdt?: number } | undefined;
  // High Margin Positions threshold (USDT, estimated margin) — needs a server that reports it
  const savedMargin = typeof savedRisk?.highMarginUsdt === 'number' ? savedRisk.highMarginUsdt : undefined;
  const [margin, setMargin] = useState<string | null>(null);
  useEffect(() => { if (savedMargin !== undefined && margin === null) setMargin(str(savedMargin)); }, [savedMargin]);
  const [risk, setRisk] = useState<{ loss: string; profit: string } | null>(null);
  useEffect(() => { if (savedRisk && risk === null) setRisk({ loss: str(savedRisk.deepLossPct), profit: str(savedRisk.deepProfitPct) }); }, [savedRisk?.deepLossPct, savedRisk?.deepProfitPct]);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadHedge = () => {setHedgeLoading(true);setHedgeLoadError(null);return fetch('/api/hedge/settings').then(async r=>{const d=await r.json();if(!r.ok||d.error||!d.settings)throw Error(d.error||'Strategy settings unavailable (HTTP '+r.status+')');return d;}).then(({ settings: h }) => {
    setHedge(h);
    setMode(h.sizingMode === 'MINIMUM' ? 'MINIMUM' : 'CUSTOM');
    setSize({ long: str(h.buyNotionalUsdt), short: str(h.sellNotionalUsdt) });
    setTp({ long: str(h.buyTpPct), short: str(h.sellTpPct) });
  }).catch(e=>setHedgeLoadError(e.message||'Strategy settings unavailable')).finally(()=>setHedgeLoading(false));};
  useEffect(() => { loadHedge(); }, []);

  // these settings need the updated bot server (it reports `sizingMode`); an older server is never sent partial saves
  const serverOk = Boolean(hedge && 'sizingMode' in hedge);
  const oldServer = Boolean(hedge && !serverOk);
  const setBox = (k: string, v: { saving?: boolean; status?: string | null; error?: string | null }) => setBoxState((s) => ({ ...s, [k]: v }));
  const positive = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

  const save = async (k: string, body: any, okText: string) => {
    setBox(k, { saving: true });
    const r = await postJson('/api/hedge/settings', body);
    if (r.status === 409 && r.data?.needsConfirmation) { setBox(k, {}); setTpConfirm(r.data.affected || []); return; }
    if (!r.ok) { setBox(k, { error: r.data?.error || `HTTP ${r.status}` }); return; }
    setBox(k, { status: 'Saved on server' });
    if (r.data?.settings) setHedge(r.data.settings);
    showToast(okText + (r.data?.tpApplied ? ` · applied to ${r.data.tpApplied.cycles} existing bot cycle(s)` : ''));
    onRefresh();
  };
  const saveSizing = () => save('sizing', { sizingMode: mode }, `Default position sizing: ${mode === 'MINIMUM' ? 'Minimum order + 1 USDT per side' : 'Custom Buy / Sell values'}`);
  const saveSize = () => {
    if (!positive(size.long) || !positive(size.short)) return setBox('size', { error: 'Enter LONG and SHORT values > 0' });
    save('size', { buyNotionalUsdt: Number(size.long), sellNotionalUsdt: Number(size.short) }, 'Position size saved');
  };
  const tpBody = () => ({ buyTpPct: Number(tp.long), sellTpPct: Number(tp.short) });
  const saveTp = () => {
    if (!positive(tp.long) || !positive(tp.short)) return setBox('tp', { error: 'Enter LONG and SHORT TP % > 0' });
    save('tp', tpBody(), `Take profit saved: LONG ${tp.long}% / SHORT ${tp.short}%`);
  };
  const confirmTp = async () => {
    setBox('tp', { saving: true });
    const r = await postJson('/api/hedge/settings', { ...tpBody(), confirmTp: true });
    setTpConfirm(null);
    if (!r.ok) { setBox('tp', { error: r.data?.error || `HTTP ${r.status}` }); return; }
    setBox('tp', { status: 'Saved on server' });
    if (r.data?.settings) setHedge(r.data.settings);
    showToast(`Take profit saved: LONG ${tp.long}% / SHORT ${tp.short}% · applied to ${r.data?.tpApplied?.cycles ?? 0} existing bot cycle(s)`);
    onRefresh();
  };

  const saveRisk = async () => {
    if (!risk || !positive(risk.loss) || !positive(risk.profit)) return setBox('risk', { error: 'Enter Deep Loss and Deep Profit % > 0' });
    setBox('risk', { saving: true });
    const r = await postJson('/api/risk-thresholds', { deepLossPct: Number(risk.loss), deepProfitPct: Number(risk.profit) });
    if (!r.ok) { setBox('risk', { error: r.data?.error || `HTTP ${r.status}` }); return; }
    const t = r.data?.thresholds;
    if (t) setRisk({ loss: str(t.deepLossPct), profit: str(t.deepProfitPct) });
    setBox('risk', { status: 'Saved on server' });
    showToast(`Risk thresholds saved: Deep Loss ${t?.deepLossPct}% / Deep Profit ${t?.deepProfitPct}%`);
    onRefresh();
  };

  // Aged Positions defaults (display filter only, saved on the server)
  const savedAged = (state?.settings as any)?.agedPositions as { minHours: number; maxHours: number | null } | undefined;
  const [aged, setAged] = useState<string | null>(null);
  useEffect(() => { if (savedAged && aged === null) setAged(String(savedAged.minHours / 24)); }, [savedAged?.minHours, savedAged?.maxHours]);
  const saveAged = async () => {
    if (aged === null || aged.trim() === '' || !Number.isFinite(Number(aged)) || Number(aged) < 0) return setBox('aged', { error: 'Enter a valid minimum age in days' });
    setBox('aged', { saving: true });
    const r = await postJson('/api/aged-settings', { minHours: Number(aged) * 24, maxHours: null });
    if (!r.ok) { setBox('aged', { error: r.data?.error || `HTTP ${r.status}` }); return; }
    const a = r.data?.aged; if (a) setAged(String(a.minHours / 24));
    setBox('aged', { status: 'Saved on server' });
    showToast(`Aged Positions: older than ${aged} days`);
  };
  const saveMargin = async () => {
    if (margin === null || !positive(margin)) return setBox('margin', { error: 'Enter a margin threshold > 0 USDT' });
    setBox('margin', { saving: true });
    const r = await postJson('/api/risk-thresholds', { highMarginUsdt: Number(margin) });
    if (!r.ok) { setBox('margin', { error: r.data?.error || `HTTP ${r.status}` }); return; }
    const t = r.data?.thresholds;
    if (t) setMargin(str(t.highMarginUsdt));
    setBox('margin', { status: 'Saved on server' });
    showToast(`High Margin threshold saved: position margin above ${t?.highMarginUsdt} USDT (all owners)`);
    onRefresh();
  };

  // ---- Bot Status (bot hedge cycles) + Bybit open positions (read-only), from the WebSocket snapshot
  const cycles = Object.values(((state as any)?.strategyCycles || {}) as Record<string, StrategyCycle>).filter((c) => c.status !== 'CLOSED');
  const strategies: Record<string, any> = (state as any)?.strategies || {};
  const pos = syncedPositions(state);
  const sides = cycles.flatMap((c) => (['Buy', 'Sell'] as const).map((sd) => ({ c, sd, s: c.sides[sd] })));
  const openSides = (c: StrategyCycle) => (['Buy', 'Sell'] as const).filter((sd) => c.sides[sd].phase === 'OPEN').length;
  const tpPending = sides.filter(({ c, sd, s }) => {
    const pct = (sd === 'Buy' ? strategies[c.symbol]?.buy : strategies[c.symbol]?.sell)?.tpPct;
    const px = (state as any)?.tickers?.[c.symbol]?.lastPrice;
    if (s.phase !== 'OPEN' || !s.tpEnabled || !s.avgEntryPrice || !(px > 0) || !(pct > 0)) return false;
    const move = ((px - s.avgEntryPrice) / s.avgEntryPrice) * 100 * (sd === 'Buy' ? 1 : -1);
    return move >= pct;
  }).length;
  const bot = pos ? pos.filter((p) => p.owner === 'bot') : null;
  const bySym = pos ? pos.reduce((m: Record<string, Set<string>>, p) => { (m[p.symbol] ||= new Set()).add(p.side); return m; }, {}) : null;
  const upnl = pos ? pos.reduce((t, p) => t + (p.unrealizedPnl || 0), 0) : null;

  // ---- API connection indicator: green ONLY after a successful authenticated connection
  const s: any = state?.settings || {};
  const conn: any = (state as any)?.connection;
  const apiState = !s.isApiKeyConfigured ? 'off' : conn?.state === 'CONNECTED' && conn?.keyInfo ? 'ok' : conn?.state === 'ERROR' ? 'error' : conn?.state === 'CONNECTING' || conn?.state === 'CHECKING' ? 'checking' : 'off';
  const saveApi = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) { setApiMsg({ ok: false, text: 'Enter both the API key and the API secret.' }); return; }
    setApiBusy(true); setApiMsg(null);
    // keeps the stored network / Bybit site; only key + secret come from this form
    const r = await postJson('/api/settings', { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), environment: s.environment || 'mainnet', ...(s.apiHost ? { apiHost: s.apiHost } : {}) });
    setApiBusy(false);
    if (!r.ok) { setApiMsg({ ok: false, text: r.data?.error || `HTTP ${r.status}` }); return; }
    setApiKey(''); setApiSecret('');
    const cs = r.data?.connection;
    setApiMsg(cs?.state === 'CONNECTED' ? { ok: true, text: 'Saved on the server. Connected to Bybit (authenticated, read-only sync).' } : { ok: false, text: `Saved, but the connection check failed: ${cs?.error?.message || cs?.state || 'unknown error'}` });
    onRefresh();
  };

  const bs = (k: string) => boxState[k] || {};
  return (
    <div className="content" data-testid="terminal-dashboard">
      <Box legend="Pump Short — New Strategy" testid="pump-short-settings" onSave={savePump} saving={pumpSaving} status={pumpStatus} error={pumpError} inlineSave>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(155px,1fr))', gap: 8 }}>
          <label style={labelStyle()}>Growth threshold (%)<input aria-label="Pump growth percent" type="number" min="0.1" step="0.1" value={pump.minGrowthPct} onChange={e => setPump(p => ({ ...p, minGrowthPct: e.target.value }))} /></label>
          <label style={labelStyle()}>Lookback (days)<input aria-label="Pump lookback days" type="number" min="1" max="365" step="1" value={pump.lookbackDays} onChange={e => setPump(p => ({ ...p, lookbackDays: e.target.value }))} /></label>
          <label style={labelStyle()}>Exit retracement (%)<input aria-label="Pump exit retracement percent" type="number" min="1" max="100" step="0.1" value={pump.retracementPct} onChange={e => setPump(p => ({ ...p, retracementPct: e.target.value }))} /></label>
          <label style={labelStyle()}>Position size (USDT)<input aria-label="Pump position size USDT" type="number" min="0.01" step="0.01" value={pump.positionNotionalUsdt} onChange={e => setPump(p => ({ ...p, positionNotionalUsdt: e.target.value }))} /></label>
          <label style={labelStyle()}>Max Pump Positions<input aria-label="Pump max positions" type="number" min="1" max="200" step="1" value={pump.maxPositions} onChange={e => setPump(p => ({ ...p, maxPositions: e.target.value }))} /></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 12 }}>Pump Short: <strong className={pumpExecution?.armed ? 'green' : 'red'}>{pumpExecution?.armed ? 'ARMED' : 'DISARMED'}</strong></span>
          <button type="button" disabled={pumpArmBusy || (pumpExecution?.armed ? false : pumpExecution?.mode !== 'REAL')} onClick={() => void armPump(!pumpExecution?.armed)}>
            {pumpExecution?.armed ? 'Stop Pump Short Entries & Exits' : 'Enable REAL Pump Short'}
          </button>
          <button type="button" onClick={() => navigate('/PumpShort')}>View Pump Scanner</button>
          <button type="button" onClick={() => navigate('/PumpPositions')}>Pump Positions</button>
          <span style={{ flex: 1 }} />
          <button className="save" type="button" disabled={pumpSaving} onClick={savePump}>{pumpSaving ? 'Saving…' : 'Save'}</button>
        </div>
        {pumpArmError && <p role="alert" className="field-error">{pumpArmError}</p>}
      </Box>
      {hedgeLoading&&<p role="status">Loading strategy settings…</p>}
      {hedgeLoadError&&<p className="lp-error" role="alert">{hedgeLoadError} <button type="button" onClick={()=>void loadHedge()}>Retry</button></p>}
      <section className="section" data-testid="bot-status"><div className="legend">Bot Status</div>
        <div className="metrics">
          <div className="metric"><div className="name">Managed Symbols</div><div className="val" data-testid="m-managed">{cycles.length}</div></div>
          <div className="metric"><div className="name">Live BOT Positions</div><div className="val">{bot ? bot.length : '—'}</div></div>
          <div className="metric"><div className="name">Fully Paired Symbols</div><div className="val">{cycles.filter((c) => openSides(c) === 2).length}</div></div>
          <div className="metric"><div className="name">One-Sided Managed Symbols</div><div className="val">{cycles.filter((c) => openSides(c) === 1).length}</div></div>
          <div className="metric"><div className="name">Waiting_Reopen</div><div className="val">{sides.filter((x) => x.s.phase === 'WAIT_TRIGGER').length}</div></div>
          <div className="metric"><div className="name">Opening</div><div className="val">{sides.filter((x) => x.s.phase === 'OPENING').length}</div></div>
          <div className="metric"><div className="name">Blocked</div><div className={`val${cycles.some((c) => c.status === 'INCOMPLETE' || c.status === 'NEEDS_REVIEW') ? ' red' : ''}`}>{cycles.filter((c) => c.status === 'INCOMPLETE' || c.status === 'NEEDS_REVIEW').length}</div></div>
          <div className="metric"><div className="name">TP Pending</div><div className={`val${tpPending ? ' orange' : ''}`}>{tpPending}</div></div>
        </div>
      </section>
      <section className="section" aria-label="Bybit live position totals" data-testid="bybit-positions"><div className="legend">Bybit Open Positions (Read-only)</div>
        <div className="metrics">
          <div className="metric"><div className="name">Open Positions</div><div className="val">{pos ? pos.length : '—'}</div></div>
          <div className="metric"><div className="name">Long Positions</div><div className="val">{pos ? pos.filter((p) => p.side === 'Buy').length : '—'}</div></div>
          <div className="metric"><div className="name">Short Positions</div><div className="val">{pos ? pos.filter((p) => p.side === 'Sell').length : '—'}</div></div>
          <div className="metric"><div className="name">Symbols with Both Sides</div><div className="val">{bySym ? Object.values(bySym).filter((x) => x.size === 2).length : '—'}</div></div>
          <div className="metric"><div className="name">Open Symbols</div><div className="val">{bySym ? Object.keys(bySym).length : '—'}</div></div>
          <div className="metric"><div className="name">Unrealized PnL (USDT)</div><div className={`val${upnl === null ? '' : upnl < 0 ? ' red' : upnl > 0 ? ' green' : ''}`}>{upnl === null ? '—' : `${upnl > 0 ? '+' : ''}${fmt(upnl, 4)}`}</div></div>
        </div>
      </section>

      {oldServer && <div className="field-error" style={{ fontSize: 13 }} data-testid="old-server">These settings need the updated bot server: restart the bot on the new version to save Position Sizing, Position Size and Take Profit here.</div>}
      <div id="position-size-section" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,190px),1fr))', gap: 12, alignItems: 'stretch', marginBottom: 20 }}>
        <Box legend="Position Sizing" className="preview-mode" onSave={serverOk ? saveSizing : undefined} {...bs('sizing')} testid="box-sizing">
          <div className="mode-options">
            <label><input type="radio" name="sizeMode" value="minimum" checked={mode === 'MINIMUM'} onChange={() => setMode('MINIMUM')} data-testid="mode-minimum" /> Minimum order + 1 USDT per side</label>
            <label><input type="radio" name="sizeMode" value="custom" checked={mode === 'CUSTOM'} onChange={() => setMode('CUSTOM')} data-testid="mode-custom" /> Custom Buy / Sell values</label>
          </div>
        </Box>
        <Box legend="Position Size USDT" onSave={serverOk ? saveSize : undefined} {...bs('size')} testid="box-size">
          <PairInputs name="Position Size" long={size.long} short={size.short} onLong={(v) => setSize({ ...size, long: v })} onShort={(v) => setSize({ ...size, short: v })} testid="size" />
        </Box>
        <Box legend="Take Profit(%)" onSave={serverOk ? saveTp : undefined} {...bs('tp')} testid="box-tp">
          <PairInputs name="Take Profit" long={tp.long} short={tp.short} onLong={(v) => setTp({ ...tp, long: v })} onShort={(v) => setTp({ ...tp, short: v })} testid="tp" />
        </Box>
        <Box legend="MART Size USDT" unavailable><PairInputs name="MART Size" long="" short="" disabled /></Box>
        <Box legend="MART (%)" unavailable><PairInputs name="MART Loss" long="" short="" disabled /></Box>
        <Box legend="Freeze (%)" unavailable><PairInputs name="Freeze" long="" short="" disabled /></Box>
      </div>
      <div id="threshold-settings" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 12, alignItems: 'stretch', marginBottom: 20 }}>
        <Box legend="Risk Thresholds" onSave={savedRisk ? saveRisk : undefined} {...bs('risk')} error={bs('risk').error ?? (state && !savedRisk ? 'Needs the updated bot server (restart the bot on the new version).' : null)} testid="box-risk">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0px,1fr))', gap: 8 }}>
            <label style={labelStyle()}>Deep Loss (%)<input type="number" min="0.000001" step="any" aria-label="Risk Thresholds Deep Loss" value={risk?.loss ?? ''} placeholder={savedRisk ? '' : '—'} disabled={!savedRisk} onChange={(e) => setRisk({ loss: e.target.value, profit: risk?.profit ?? '' })} data-testid="risk-loss" /></label>
            <label style={labelStyle()}>Deep Profit (%)<input type="number" min="0.000001" step="any" aria-label="Risk Thresholds Deep Profit" value={risk?.profit ?? ''} placeholder={savedRisk ? '' : '—'} disabled={!savedRisk} onChange={(e) => setRisk({ loss: risk?.loss ?? '', profit: e.target.value })} data-testid="risk-profit" /></label>
          </div>
        </Box>
        <Box legend="High Margin Positions" onSave={savedMargin !== undefined ? saveMargin : undefined} {...bs('margin')} error={bs('margin').error ?? (state && savedMargin === undefined ? 'Needs the updated bot server (restart the bot on the new version).' : null)} testid="box-margin">
          <label style={labelStyle()} title="Bybit position margin (positionIM) where reported, otherwise value ÷ leverage (labelled est.); all owners, strictly above">Margin Threshold (USDT)<input type="number" min="0.000001" step="any" aria-label="High Margin Threshold USDT" value={margin ?? ''} placeholder={savedMargin !== undefined ? '' : '—'} disabled={savedMargin === undefined} onChange={(e) => setMargin(e.target.value)} data-testid="margin-threshold" /></label>
        </Box>
        <Box legend="Aged Positions Settings" onSave={savedAged ? saveAged : undefined} {...bs('aged')} testid="box-aged">
          <label style={labelStyle()} title="Show positions continuously open longer than this number of days">Open longer than (days)<input type="number" min="0" step="0.5" aria-label="Aged Positions Settings Min Days" value={aged ?? ''} placeholder={savedAged ? '' : '—'} disabled={!savedAged} onChange={(e) => setAged(e.target.value)} data-testid="aged-min" /></label>
        </Box>
      </div>

      <section className="section" id="dashboard-settings" data-testid="dashboard-security-card"><div className="legend">User &amp; Security</div>
        <div className="account-actions"><span className="account-status">Username, password and Google Authenticator 2FA{account.data ? <span style={{ color: 'rgb(173,177,184)' }}> · 2FA {account.data.twoFactor.enabled ? 'enabled' : 'off'}{account.data.username ? ' · user ' + account.data.username : ''}</span> : null}</span><a className="report-button" href="/Security" onClick={(e) => linkClick(e, '/Security')} data-testid="dashboard-security-link">Open Security</a></div>
      </section>

      <section className="section" id="dashboard-bybit-api" data-testid="api-panel">
        <div className="legend">BYBIT API Connection <span className={`api-status-preview${apiState === 'ok' ? ' connected' : apiState === 'checking' ? ' checking' : ''}`} data-testid="api-status">● {apiState === 'ok' ? 'Connected' : apiState === 'error' ? 'Connection error' : apiState === 'checking' ? 'Checking…' : 'Disconnected'}</span></div>
        <div className="account-grid api-simple-grid" id="accountApiFields">
          <div className="account-field"><label htmlFor="dashApiKey">API Key</label><input autoComplete="off" id="dashApiKey" placeholder={s.apiKeyMasked ? `Stored ${s.apiKeyMasked} — enter a new key to replace` : 'Enter API key'} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
          <div className="account-field"><label htmlFor="dashApiSecret">API Secret</label><input autoComplete="off" id="dashApiSecret" placeholder={s.isApiKeyConfigured ? 'Stored on the server — enter a new secret to replace' : 'Enter API secret'} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} /></div>
          <button className="save" type="button" disabled={apiBusy} onClick={saveApi} data-testid="api-save">{apiBusy ? 'Saving…' : 'Save'}</button>
        </div>
        {(apiMsg || (apiState === 'error' && conn?.error)) && (
          <div className={apiMsg?.ok ? 'saved-status' : 'field-error'} style={{ textAlign: 'left' }} data-testid="api-msg">{apiMsg ? apiMsg.text : `Bybit: ${conn.error.message || conn.error.retMsg || 'connection failed'}`}</div>
        )}
      </section>

      <TradeAlertSettings/>
      <LightModal open={tpConfirm !== null} title="Apply new take profit to existing cycles" confirmLabel="Apply" busy={bs('tp').saving} onClose={() => setTpConfirm(null)} onConfirm={confirmTp} testid="tp-confirm">
        These running sides are already at or beyond the new TP. After you apply it, a managed side closes at its TP on the next price tick and reopens as usual; a side of a paused cycle only closes when the bot is started. Nothing else is closed or opened by this change.
        <table data-testid="tp-affected">
          <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Price</th><th>Move</th><th>New TP</th><th>Cycle</th></tr></thead>
          <tbody>{(tpConfirm || []).map((a) => (
            <tr key={`${a.symbol}-${a.side}`}><td><SymbolSide symbol={a.symbol} leverage={(() => { const c = (state as any)?.strategyCycles?.[a.symbol]; return c ? (a.side === 'Buy' ? c.leverageBuy ?? c.leverage : c.leverageSell ?? c.leverage) : null; })()} side={a.side} /></td><td><SideLabel side={a.side} /></td><td>{a.entry}</td><td>{a.price ?? '—'}</td><td>{a.movePct === null ? 'no price' : `${a.movePct >= 0 ? '+' : ''}${a.movePct.toFixed(2)}%`}</td><td>{a.newTpPct}% → {Number(a.tpPrice.toPrecision(8))}</td><td>{a.managed ? 'managed' : 'paused'}</td></tr>
          ))}</tbody>
        </table>
      </LightModal>
      {toast}
    </div>
  );
};


