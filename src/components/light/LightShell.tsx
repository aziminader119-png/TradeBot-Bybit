import {visibleLog} from '../../shared/visibleLog.ts';
/// <reference path="./imageTypes.d.ts"/>
import {TradeNotificationBell} from '../notifications/TradeNotifications.tsx';
import {updateStatus} from './uiStatus.ts';
import React, { useEffect, useMemo, useState } from 'react';
import { AlertItem, BotStateSummary, TradeLog } from '../../types/trading.ts';
import type { StrategyCycle } from '../../types/strategy.ts';
import { useRead } from './reports.tsx';
import { formatCount } from './format.tsx';
import { CLOSED_DEFAULT_DAYS, TRADES_URL, closedUrl, inPositionView, liveTradeRecords, liveTriggerRecords, savedThresholds } from './listCounts.ts';
import {PAGE_PATHS,linkClick} from './navigation.ts';
import { LIGHT_NAV } from './nav.tsx';
import { LightModal, postJson } from './Modal.tsx';

const TOP_GROUPS: {name:string; entry:string; tabs:{id:string;name:string}[]}[] = [
  {name:'Dashboard',entry:'dashboard',tabs:[{id:'dashboard',name:'Overview'}]},
  {name:'Positions',entry:'all_positions',tabs:[
    {id:'all_positions',name:'All Positions'},{id:'bot_positions',name:'BOT'},{id:'pump_positions',name:'Pump'},
    {id:'dump_positions',name:'Dump'},{id:'external_positions',name:'External'},{id:'mart_positions',name:'MART'},
    {id:'closed_positions',name:'Closed'},{id:'aged_positions',name:'Aged'},{id:'latest_opened',name:'Latest'},
    {id:'deep_loss_positions',name:'Deep Loss'},{id:'deep_profit_positions',name:'Deep Profit'},
    {id:'high_margin_positions',name:'High Margin'}]},
  {name:'Symbols',entry:'symbols',tabs:[{id:'symbols',name:'All Symbols'},{id:'symbol_trading',name:'Single Coin'}]},
  {name:'Strategies',entry:'bot_cycles',tabs:[{id:'bot_cycles',name:'BOT Cycles'},{id:'pump_short',name:'Pump Short'},{id:'dump_buy',name:'Dump Buy'}]},
  {name:'Analytics',entry:'pl_analytics',tabs:[{id:'pl_analytics',name:'P&L Analytics'},{id:'trade_history',name:'Trade History'},{id:'trigger_orders',name:'Trigger Orders'}]},
  {name:'Settings',entry:'security',tabs:[{id:'security',name:'Security'},{id:'smart_mart_alerts',name:'Smart MART Alerts'},
    {id:'alert_history',name:'Alert History'},{id:'logs',name:'Logs'}]}
];

// The original real trading controls and account figures remain operational beneath a unified top navigation.
// Every figure comes from the server (WebSocket snapshot + REST); "—" when not available.

const fmt = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

export function usePolled<T>(url: string | null, ms: number, map: (d: any) => T | null): T | null {
  const read = useRead<any>(url, ms);
  return read.data ? map(read.data) : null;
}

/** Last successful Bybit position snapshot; wallet/API errors must not hide positions.
 * The position-sync timestamp remains visible so stale data is clearly labelled. */
export function syncedPositions(state: BotStateSummary | null) {
  const c: any = (state as any)?.connection;
  if (!state?.settings?.isApiKeyConfigured || !(Number(c?.positionsSyncedAt) > 0)) return null;
  return (state?.positions || []).filter((p) => !p.paper && !p.missingOnExchangeSince && p.size > 0);
}

export const LightShell: React.FC<{
  state: BotStateSummary | null; wsConnected: boolean; lastUpdated: number; activeTab: string; onTab: (t: string) => void; onRefresh: () => void; children: React.ReactNode;
}> = ({ state, wsConnected, lastUpdated, activeTab, onTab, onRefresh, children }) => {
  const [modal, setModal] = useState<null | 'start' | 'stop'>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const configured = Boolean(state?.settings?.isApiKeyConfigured);
  const conn: any = (state as any)?.connection;
  const w: any = state?.wallet;

  const symbols = usePolled<number>('/api/symbols', 300000, (d) => (Array.isArray(d.symbols) ? d.symbols.length : null));
  // Already in the authenticated WS/REST state snapshot: no duplicate 15s account polling.
  const usdtBal = typeof w?.usdtWalletBalance === 'number' && Number.isFinite(w.usdtWalletBalance)
    ? w.usdtWalletBalance : null;
  const pos = syncedPositions(state);
  const cycles = Object.values(((state as any)?.strategyCycles || {}) as Record<string, any>).filter((c) => c.status !== 'CLOSED');
  const running = state?.systemMetrics?.tradingState === 'RUNNING';
  const pinRequired = Boolean((state?.settings as any)?.hasSecurityPin);
  // ---- sidebar list counts: the same sources and category rules as each page's default view (before search, side
  // filters and pagination); "—" while loading / unavailable. Shared cached reads only (no per-menu loops, no exchange
  // call per tick): the snapshot, /api/trades and /api/alerts (local), Closed Positions (shared Bybit read, every 10 seconds).
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const health=updateStatus(Boolean(state),wsConnected,lastUpdated,now);
  const has=Boolean(w?.valuesAvailable)&&!health.stale;
  const tradesRead = useRead<{ trades: TradeLog[] }>(state ? TRADES_URL : null, 30000);
  // Closed P&L is historical reporting, not a live ticker. Keep a shared count cached
  // for one minute instead of initiating an authenticated Bybit read every 10 seconds
  // from every dashboard view. Trade events still trigger an explicit refresh.
  const closedRead = useRead<{ rows: any[]; days: number }>(configured ? closedUrl(CLOSED_DEFAULT_DAYS) : null, 60000);
  const pumpRead = useRead<{ trades: { symbol: string; status: string }[] }>('/api/pump-short/positions', 5000);
  const dumpRead = useRead<{ trades: { status: string }[] }>('/api/dump-buy/positions', 5000);
  const counts: Record<string, number | null> = useMemo(() => {
    const allCycles = ((state as any)?.strategyCycles || {}) as Record<string, StrategyCycle>;
    const thresholds = savedThresholds(state);
    const aged = (state?.settings as any)?.agedPositions;
    const activePump = pumpRead.data?.trades?.filter(t => !['CLOSED', 'RELEASED'].includes(t.status)) || [];
    const pumpSymbols = new Set(activePump.filter(t => ['OPEN', 'ENTRY_PENDING', 'EXIT_PENDING'].includes(t.status)).map(t => t.symbol));
    const inView = (v: any) => (pos ? pos.filter((p) => inPositionView(p, v, { cycles: allCycles, thresholds, now, aged })).length : null);
    return {
      symbols, all_positions: pos ? pos.length : null, latest_opened: pos ? pos.length : null,
      pump_positions: pumpRead.data ? activePump.length : null,
      dump_positions: dumpRead.data?.trades ? dumpRead.data.trades.filter(t => t.status !== 'CLOSED').length : null,
      bot_positions: pos ? pos.filter((p) => p.owner === 'bot').length : null,
      external_positions: pos ? pos.filter((p) => inPositionView(p, 'external', { cycles: allCycles, thresholds, now, aged }) &&
        !(p.side === 'Sell' && pumpSymbols.has(p.symbol))).length : null,
      aged_positions: inView('aged'), deep_loss_positions: inView('loss'), deep_profit_positions: inView('profit'),
      high_margin_positions: inView('margin'), mart_positions: inView('mart'),
      bot_cycles: state ? Object.keys(allCycles).length : null,
      trigger_orders: state ? liveTriggerRecords(state).length : null,
      trade_history: state && tradesRead.data ? liveTradeRecords(state, tradesRead.data.trades || []).length : null,
      closed_positions: closedRead.data && closedRead.data.days === CLOSED_DEFAULT_DAYS && Array.isArray(closedRead.data.rows) ? closedRead.data.rows.length : null,
      // the one alert service (snapshot summary): Smart MART definitions and stored raised alerts
      smart_mart_alerts: state?.indicatorAlerts ? state.indicatorAlerts.smartRules : null,
      alert_history: state?.indicatorAlerts ? state.indicatorAlerts.events : null,
      logs: state ? (state.recentLogs || []).filter(visibleLog).length : null,
    };
  }, [symbols, pos, state, now, tradesRead.data, closedRead.data, pumpRead.data, dumpRead.data]);
  const title = LIGHT_NAV.find((n) => n.id === activeTab)?.label || (activeTab === 'symbol_trading' ? 'Futures' : 'Dashboard');
  const currentGroup = TOP_GROUPS.find((g) => g.tabs.some((t) => t.id === activeTab)) || TOP_GROUPS[0];
  const upnl = has ? w.unrealizedPnl : null;

  const openStartStop = () => {
    if (!state) return;
    if (!running && !(configured && conn?.state === 'CONNECTED')) return;
    setErr(null); setPin(''); setModal(running ? 'stop' : 'start');
  };
  const confirmStartStop = async () => {
    setBusy(true); setErr(null);
    const r = modal === 'start' ? await postJson('/api/trading/mode', { mode: 'REAL', confirm: true, pin }) : await postJson('/api/trading/mode', { mode: 'OFF' });
    setBusy(false);
    if (!r.ok) { setErr(r.data?.error || r.data?.message || `HTTP ${r.status}`); return; }
    setModal(null); onRefresh();
  };
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    window.location.reload();
  };

  return (
    <div className="page page-dashboard tb-unified-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app">
        <main className="main" id="dashboard">
           <div className="tb-top-nav">
             <button className="tb-top-brand" type="button" onClick={() => onTab('dashboard')} aria-label="TradeBot Pro Dashboard">
               <img src="/tradebot-icon-v1.png" alt="" /><span>TRADEBOT <em>PRO</em></span>
             </button>
             <nav className="tb-primary-nav" aria-label="Primary navigation">
               {TOP_GROUPS.map((g) => <a key={g.name} href={PAGE_PATHS[g.entry]}
                 className={currentGroup.name === g.name ? 'active' : undefined}
                 aria-current={currentGroup.name === g.name ? 'page' : undefined}
                 onClick={(e) => linkClick(e, PAGE_PATHS[g.entry])}>{g.name}</a>)}
             </nav>
             <div className="tb-top-health"><span className={running ? 'tb-live-dot' : 'tb-off-dot'}/>
               {running ? 'RUNNING' : 'STOPPED'}</div>
           </div>
          <header className="top" data-testid="t-topbar">
            <div className="top-heading">
                            <span className={`header-start-text${running ? ' is-on' : ''}`} role="button" tabIndex={0} data-testid="start-stop"
                aria-disabled={!running && !(configured && conn?.state === 'CONNECTED') ? 'true' : undefined}
                title={running ? 'Pause the bot (no TP close / reopen until started again)' : configured && conn?.state === 'CONNECTED' ? 'Start managing all saved bot cycles' : 'Connect the Bybit API first'}
                onClick={openStartStop} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStartStop(); } }}>
                {running ? 'STOP' : 'START'}
              </span>
              <strong>{title}</strong>
              <span className={'data-health '+health.tone} role="status" title={lastUpdated?'Last received '+new Date(lastUpdated).toLocaleTimeString():'Waiting for server'}>{health.label}</span>

            </div>
            <div className="stats" data-testid="header-stats">
              <div className="stat"><div className="name">BOT Positions</div><div className="value">{counts.bot_positions ?? '—'}</div></div>
              <div className="stat"><div className="name">External</div><div className="value">{counts.external_positions ?? '—'}</div></div>
              <div className="stat"><div className="name">Symbols</div><div className="value">{symbols ?? '—'}</div></div>
              <div className="stat"><div className="name">Wallet Balance</div><div className="value" data-testid="hs-wallet">{has ? fmt(usdtBal) : '—'}</div></div>
              <div className="stat"><div className="name">Total Equity</div><div className="value" data-testid="hs-equity">{has ? fmt(w.totalEquity) : '—'}</div></div>
              <div className="stat"><div className="name">Free Margin</div><div className="value" data-testid="hs-free">{has ? fmt(w.availableBalance) : '—'}</div></div>
              <div className="stat"><div className="name">Used Margin</div><div className="value" data-testid="hs-used">{has ? fmt(w.usedMargin) : '—'}</div></div>
              <div className="stat"><div className="name">Unrealized P&amp;L</div><div className={`value${upnl === null ? '' : upnl < 0 ? ' red' : upnl > 0 ? ' green' : ''}`} data-testid="hs-upnl">{upnl === null ? '—' : `${upnl > 0 ? '+' : ''}${fmt(upnl, 3)}`}</div></div>
            </div>
            <div className="header-actions"><TradeNotificationBell/>
              <button className="header-action-btn logout-btn" type="button" title="Logout" onClick={logout}>Logout</button>
            </div>
          </header>
          <nav className="tb-sub-nav" aria-label={currentGroup.name + ' tabs'}>
            {currentGroup.tabs.filter((t) => t.id !== 'symbol_trading' || activeTab === 'symbol_trading').map((t) => (
              <a key={t.id} href={t.id === 'symbol_trading' ? window.location.pathname : PAGE_PATHS[t.id]}
                className={activeTab === t.id ? 'active' : undefined}
                aria-current={activeTab === t.id ? 'page' : undefined}
                onClick={(e) => { if (t.id !== 'symbol_trading') linkClick(e, PAGE_PATHS[t.id]); }}>
                {t.name}{t.id in counts && counts[t.id] !== null ? <small>{formatCount(counts[t.id], t.id === 'closed_positions')}</small> : null}
              </a>
            ))}
          </nav>
          <div className="page-body" id="main-content" tabIndex={-1}>{children}</div>
          <LightModal open={modal !== null} title={modal === 'stop' ? 'Pause the bot' : 'Start the bot'} confirmLabel={modal === 'stop' ? 'Pause' : 'Start'} busy={busy} error={err} onClose={() => !busy && setModal(null)} onConfirm={confirmStartStop} testid="start-stop-modal">
            {modal === 'stop'
              ? <>No TP close or reopen happens until you start again. Open positions stay on Bybit.</>
              : <>
                  The bot will manage all {cycles.length} saved bot cycle(s): sides are closed at their TP and reopened with <b>real market orders</b> on Bybit. External positions are never touched.
                  {pinRequired && <div className="pin-row"><label htmlFor="startPin">Security PIN</label><input id="startPin" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></div>}
                </>}
          </LightModal>
        </main>
      </div>
    </div>
  );
};

/** Placeholder for design pages that are not available in this version (no data). */
export const LightPlaceholder: React.FC<{ label: string }> = ({ label }) => (
  <div className="content" data-testid="coming-soon">
    <section className="section"><div className="legend">{label}</div>
      <div className="account-status">Not available in this version yet. No data is shown and nothing here affects the bot or your Bybit account.</div>
    </section>
  </div>
);



