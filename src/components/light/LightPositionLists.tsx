import {createPortal} from 'react-dom';
import React, { useEffect, useMemo, useState } from 'react';
import { BotPosition, BotStateSummary } from '../../types/trading.ts';
import type { StrategyConfig, StrategyCycle } from '../../types/strategy.ts';
import { movePct } from './positionData.ts';
import { positionMargin, syncAge } from '../../shared/positionMargin.ts';
import { AGED_DEFAULT_HOURS, inPositionView, savedThresholds, viewThreshold } from './listCounts.ts';
import { FilterChoices } from './FilterChoices.tsx';
import { DateTime, Liq, SymbolSide } from './format.tsx';
import { syncedPositions } from './LightShell.tsx';
import { Pager, RowsPicker, SortTh, num, price, sortRows, tone, usePaged, useSort } from './table.tsx';

// Read-only lists. No trading or ownership mutations; data comes from the existing synced snapshot.
type SideF = 'ALL' | 'Buy' | 'Sell';
type OwnerF = 'ALL' | 'bot' | 'external';
type K = 'symbol' | 'size' | 'value' | 'entry' | 'mark' | 'liq' | 'upnl' | 'open' | 'age' | 'status' | 'tp' | 'risk';

const age = (ms: number | null) => {
  if (ms === null || ms < 0) return '—';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${m % 60}m` : `${m}m`;
};
const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

function status(p: BotPosition, c: StrategyCycle | undefined, managedIds: Set<string>, running: boolean): { text: string; cls: string; rank: number } {
  if (!c || c.cycleId !== p.cycleId || c.status === 'CLOSED') return { text: 'No active cycle', cls: 'red', rank: 0 };
  if (c.status === 'INCOMPLETE' || c.status === 'NEEDS_REVIEW') return { text: c.status === 'INCOMPLETE' ? 'Incomplete' : 'Needs review', cls: 'red', rank: 1 };
  const phase = c.sides?.[p.side]?.phase;
  const managed = running || managedIds.has(c.cycleId);
  const base = managed ? 'Managed' : 'Paused';
  const extra = phase && phase !== 'OPEN' ? ` · ${phase === 'WAIT_TRIGGER' ? 'reopening' : phase.toLowerCase()}` : '';
  return { text: base + extra, cls: managed ? 'green' : 'orange', rank: managed ? 3 : 2 };
}

/** The bot's own TP for this side: from the side's average entry (underlying price move, not ROI), as the engine does. */
function botTp(p: BotPosition, c: StrategyCycle | undefined, cfg: StrategyConfig | undefined): { price: number; pct: number } | null {
  if (!c || c.cycleId !== p.cycleId) return null;
  const s = c.sides?.[p.side];
  const sc = p.side === 'Buy' ? cfg?.buy : cfg?.sell;
  if (!s || !sc || !s.tpEnabled || !s.avgEntryPrice || !(sc.tpPct > 0)) return null;
  return { price: p.side === 'Buy' ? s.avgEntryPrice * (1 + sc.tpPct / 100) : s.avgEntryPrice * (1 - sc.tpPct / 100), pct: sc.tpPct };
}

function MarginCell({ p }: { p: BotPosition }) {
  const m = positionMargin(p);
  if (m.value === null) return <span className="na" title="Margin unavailable">—</span>;
  return <span data-margin-source={m.source} title={m.source === 'exchange' ? 'Bybit positionIM at the last position sync' : 'Estimate: position value ÷ leverage (Bybit reported no comparable position margin)'}>{num(m.value, 4)}{m.source === 'estimate' && <small className="tp-pct"> est.</small>}</span>;
}

export const LightPositionLists: React.FC<{ state: BotStateSummary | null; onGoCycles: () => void; fixedSymbol?: string; summaryTarget?: HTMLElement|null; view: 'all' | 'external' | 'latest' | 'aged' | 'loss' | 'profit' | 'margin' | 'mart' }> = ({ state, onGoCycles, view, fixedSymbol, summaryTarget }) => {
  const title = { all: 'All Positions', external: 'External Positions', latest: 'Latest Opened', aged: 'Aged Positions', loss: 'Deep Loss Positions', profit: 'Deep Profit Positions', margin: 'High Margin Positions', mart: 'Mart Positions' }[view];
  const savedAged = (state?.settings as any)?.agedPositions as { minHours: number; maxHours: number | null } | undefined;
  const [minHours, setMinHours] = useState(savedAged?.minHours ?? AGED_DEFAULT_HOURS);
  const [maxHours, setMaxHours] = useState<number | null>(savedAged?.maxHours ?? null);
  const agedLoaded = React.useRef(Boolean(savedAged));
  useEffect(() => { if (savedAged && !agedLoaded.current) { agedLoaded.current = true; setMinHours(savedAged.minHours); setMaxHours(savedAged.maxHours); } }, [savedAged]);
  // Deep Loss / Deep Profit / High Margin use ONLY the thresholds saved on the Dashboard (live snapshot; server defaults
  // 70 % / 5 % / 50 USDT); the same rules feed the sidebar counts.
  const thresholds = savedThresholds(state);
  const threshold = viewThreshold(view, thresholds);
  const risk = view === 'loss' || view === 'profit' || view === 'margin';
  const [q, setQ] = useState('');
  const [sideF, setSideF] = useState<SideF>('ALL');
  const [ownerF, setOwnerF] = useState<OwnerF>('ALL');
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [sort, toggleSort] = useSort<K>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const conn: any = (state as any)?.connection;
  const configured = Boolean(state?.settings?.isApiKeyConfigured);
  const synced = syncedPositions(state);
  const sync = syncAge(conn?.positionsSyncedAt, now);
  const cycles: Record<string, StrategyCycle> = ((state as any)?.strategyCycles || {}) as Record<string, StrategyCycle>;
  const strategies: Record<string, StrategyConfig> = ((state as any)?.strategies || {}) as Record<string, StrategyConfig>;
  const managedIds = new Set<string>(state?.systemMetrics?.managedCycleIds || []);
  const running = state?.systemMetrics?.tradingState === 'RUNNING';

  const data = useMemo(() => (synced || []).filter((p) => (!fixedSymbol || p.symbol === fixedSymbol) && inPositionView(p, view, { cycles, thresholds, now, minHours, maxHours })).map((p) => {
    const c = cycles[p.symbol];
    const st = p.owner === 'bot' ? status(p, c, managedIds, running) : { text: 'External', cls: '', rank: 3 };
    const tp = p.owner === 'bot' ? botTp(p, c, strategies[p.symbol]) : p.tpPrice > 0 ? { price: p.tpPrice, pct: 0 } : null;
    const opened = typeof p.cycleStartTime === 'number' && p.cycleStartTime > 0 ? p.cycleStartTime : null;
    return { p, st, tp, opened };
  }), [synced, cycles, strategies, state?.systemMetrics, view, minHours, maxHours, now, threshold, thresholds, fixedSymbol]);
  type D = (typeof data)[number];

  const sum = useMemo(() => {
    const buy = data.filter((d) => d.p.side === 'Buy'), sell = data.filter((d) => d.p.side === 'Sell');
    const s = (a: D[], f: (v: number) => boolean) => a.reduce((t, d) => t + (f(d.p.unrealizedPnl || 0) ? d.p.unrealizedPnl || 0 : 0), 0);
    return {
      total: data.length, buy: buy.length, sell: sell.length,
      buyProfit: s(buy, (v) => v > 0), buyLoss: s(buy, (v) => v < 0), sellProfit: s(sell, (v) => v > 0), sellLoss: s(sell, (v) => v < 0),
      pnl: data.reduce((t, d) => t + (d.p.unrealizedPnl || 0), 0), paused: data.filter((d) => d.st.rank < 3).length,
    };
  }, [data]);

  const filtered = useMemo(() => {
    const s = q.trim().toUpperCase();
    const f = data.filter((d) => (!s || d.p.symbol.includes(s)) && (sideF === 'ALL' || d.p.side === sideF) && (ownerF === 'ALL' || d.p.owner === ownerF) && (view !== 'aged' || (d.opened !== null && now - d.opened >= minHours * 3600000 && (maxHours === null || now - d.opened <= maxHours * 3600000))));
    const base = [...f].sort((a, b) => view === 'latest' || view === 'aged'
      ? (a.opened === null && b.opened === null ? 0 : a.opened === null ? 1 : b.opened === null ? -1 : view === 'latest' ? b.opened - a.opened : a.opened - b.opened) || a.p.id.localeCompare(b.p.id)
      : a.p.symbol.localeCompare(b.p.symbol) || a.p.side.localeCompare(b.p.side));
    return sortRows<D, K>(base, sort, (d, k) => {
      switch (k) {
        case 'risk': return view === 'margin' ? positionMargin(d.p).value : movePct(d.p);
        case 'symbol': return d.p.symbol;
        case 'size': return d.p.size;
        case 'value': return d.p.notional;
        case 'entry': return d.p.entryPrice;
        case 'mark': return d.p.markPrice;
        case 'liq': return d.p.liqPrice ?? null;
        case 'upnl': return d.p.unrealizedPnl;
        case 'open': return d.opened;
        case 'age': return d.opened === null ? null : now - d.opened;
        case 'status': return d.st.text;
        case 'tp': return d.tp?.price ?? null;
      }
    });
  }, [data, q, sideF, ownerF, sort, now, view, minHours, maxHours, threshold]);
  const pg = usePaged(filtered, size, page);
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };
  const v = (x: string | number) => (synced ? x : '—');

  const emptyText = !configured ? 'Connect the Bybit API on the Dashboard to see your positions.'
    : !synced ? `Not synced with Bybit (${conn?.error?.message || conn?.state || 'no connection'}).`
    : data.length === 0 ? 'No open positions in this category.' : 'No matching positions';

  const summary=(
      <div className="page-summary" data-testid="botpos-summary">
        <div className="summary-item"><div className="k">Total Positions</div><div className="v" data-testid="sum-total">{v(sum.total)}</div></div>
        <div className="summary-item"><div className="k">BUY Positions</div><div className="v green" data-testid="sum-buy">{v(sum.buy)}</div></div>
        <div className="summary-item"><div className="k">SELL Positions</div><div className="v red" data-testid="sum-sell">{v(sum.sell)}</div></div>
        <div className="summary-item"><div className="k">BUY Profit</div><div className="v green" data-testid="sum-buy-profit">{v(usd(sum.buyProfit))}</div></div>
        <div className="summary-item"><div className="k">BUY Loss</div><div className="v red" data-testid="sum-buy-loss">{v(usd(sum.buyLoss))}</div></div>
        <div className="summary-item"><div className="k">SELL Profit</div><div className="v green" data-testid="sum-sell-profit">{v(usd(sum.sellProfit))}</div></div>
        <div className="summary-item"><div className="k">SELL Loss</div><div className="v red" data-testid="sum-sell-loss">{v(usd(sum.sellLoss))}</div></div>
        <div className="summary-item"><div className="k">Total P&amp;L</div><div className={`v ${synced ? tone(sum.pnl) : ''}`} data-testid="sum-pnl">{v(usd(sum.pnl))}</div></div>
        <div className="summary-item" title="Bot positions the bot is not acting on right now (paused, incomplete or needing review)"><div className="k">Paused / Review</div><div className="v" data-testid="sum-paused">{v(sum.paused)}</div></div>
      </div>
  );
  return (
    <div className="workspace lp-botpos" data-testid={`${view}-positions-page`}>
      {summaryTarget===undefined?summary:summaryTarget?createPortal(summary,summaryTarget):null}

      {(!fixedSymbol || data.length>0) && <>
      <div className="lp-toolbar">
        <div className="tb-left">
          <input className="search" type="search" placeholder="Search by Symbol..." aria-label="Search by symbol" value={q} onChange={(e) => reset(setQ)(e.target.value)} data-testid="botpos-search" />
          {view === 'aged' && <label>Minimum age (hours): <input type="number" min="0" step="1" value={minHours} style={{ width: 80 }} onChange={(e) => { setMinHours(Math.max(0, Number(e.target.value) || 0)); setPage(1); }} /></label>}
          {view === 'aged' && <label>Maximum age (hours): <input type="number" min="0" step="1" value={maxHours ?? ''} placeholder="none" style={{ width: 80 }} onChange={(e) => { setMaxHours(e.target.value === '' ? null : Math.max(0, Number(e.target.value))); setPage(1); }} /></label>}
        </div>
        <RowsPicker size={size} onSize={reset(setSize)} />
        {view !== 'external' && view !== 'mart' && <FilterChoices<OwnerF> label="Owner" testId="owner-filter" optionAttribute="data-owner" value={ownerF} options={[{value:'ALL',label:'All Owners'},{value:'bot',label:'BOT'},{value:'external',label:'External'}]} onChange={reset(setOwnerF)}/>}
        <FilterChoices<SideF> label="Side" className="tb-right" testId="side-filter" optionAttribute="data-filter" value={sideF} options={[{value:'ALL',label:'All Sides'},{value:'Buy',label:'BUY'},{value:'Sell',label:'SHORT'}]} onChange={reset(setSideF)}/>
      </div>

      {!fixedSymbol && <p className={'lp-source-note lp-sync-note' + (synced && sync.stale ? ' orange' : '')} data-testid="positions-synced">{sync.at ? <>Last Bybit position sync: <DateTime ts={sync.at} />{synced && sync.stale ? ' — older than 60 s, values may be out of date' : ''}</> : 'No successful Bybit position sync yet.'}{view === 'margin' && <> · Margin = Bybit position margin (positionIM) at that sync; marked <b>est.</b> where Bybit gives no comparable value (value ÷ leverage). Included: strictly above {Number.isFinite(threshold) ? threshold + ' USDT' : 'the threshold'}, every owner, each side separately.</>}</p>}
      {view === 'mart' && <p className="lp-source-note">Only open BOT positions with a recorded MART addition. Additional MART stages and manual MART execution are not available.</p>}
      <div className="aged-table-title"><span>{fixedSymbol ? fixedSymbol + ' · Positions' : title}</span></div>
      {(view === 'latest' || view === 'aged') && <p style={{ fontSize: 13 }}>Times reflect the bot's first-recorded time, not the exchange fill time. Unknown times show —{view === 'aged' ? ' and are excluded from the age filter' : ''}.</p>}
      <div className="table-wrap" role="region" tabIndex={0} aria-label="Positions table">
        <table className="lp-table botpos-table" data-testid="botpos-table">
          <colgroup>{[9, 3, 5, 8.5, 8.5, 7.5, 7.5, 9.5, 8, 4.5, 3.5, 8.5, 8, 3, 5.5].map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
          <thead><tr>
            <SortTh k="symbol" s={sort} onSort={toggleSort}>Symbol</SortTh>
            <th className="c">Bybit</th>
            <SortTh k="size" s={sort} onSort={toggleSort}>Size</SortTh>
            <SortTh k="value" s={sort} onSort={toggleSort}>Position Value</SortTh>
            <SortTh k="entry" s={sort} onSort={toggleSort}>Average Entry</SortTh>
            <SortTh k="mark" s={sort} onSort={toggleSort}>Mark Price</SortTh>
            <SortTh k="liq" s={sort} onSort={toggleSort}>Liquidation</SortTh>
            <SortTh k="upnl" s={sort} onSort={toggleSort}>Unrealized P&amp;L</SortTh>
            <SortTh k="open" s={sort} onSort={toggleSort} title="When the bot first recorded this position as open">Open Time</SortTh>
            <SortTh k="age" s={sort} onSort={toggleSort}>Age</SortTh>
            <th>Owner</th>
            <SortTh k="status" s={sort} onSort={toggleSort} title="Managed = the bot is acting on this side now; Paused = waits until START">Status</SortTh>
            <SortTh k="tp" s={sort} onSort={toggleSort} title="BOT: internal TP. External: existing Bybit TP, read only.">TP</SortTh>
            {risk ? <SortTh k="risk" s={sort} onSort={toggleSort} title={view === 'margin' ? 'Bybit position margin (positionIM) from the last sync; est. = value ÷ leverage where Bybit reports none' : undefined}>{view === 'margin' ? 'Margin (USDT)' : 'Price Move %'}</SortTh> : <th title="No stop-loss in this version">SL</th>}
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {pg.slice.length === 0 ? <tr><td colSpan={15} className="empty" data-testid="botpos-empty">{emptyText}</td></tr>
              : pg.slice.map(({ p, st, tp, opened }) => (
                <tr key={p.id} data-pos={p.id}>
                  <td className="symbol" data-col="symbol"><SymbolSide symbol={p.symbol} leverage={p.leverage} side={p.side} /></td>
                  <td className="c"><a className="bybit-icon" title={`Open ${p.symbol} on Bybit`} target="_blank" rel="noopener noreferrer" href={`https://www.bybit.com/trade/usdt/${p.symbol}`}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M20 13v7H4V4h7" /></svg></a></td>
                  <td data-col="size">{p.size}</td>
                  <td data-col="value">{num(p.notional, 2)}</td>
                  <td data-col="entry">{price(p.entryPrice)}</td>
                  <td data-col="mark">{price(p.markPrice)}</td>
                  <td data-col="liq"><Liq value={p.liqPrice} fmt={price} /></td>
                  <td className={tone(p.unrealizedPnl)} data-col="upnl">{typeof p.unrealizedPnl === 'number' ? `${p.unrealizedPnl > 0 ? '+' : ''}${p.unrealizedPnl.toFixed(4)}` : '—'}</td>
                  <td data-col="open"><DateTime ts={opened} /></td>
                  <td data-col="age">{age(opened === null ? null : now - opened)}</td>
                  <td>{p.owner === 'bot' ? 'BOT' : 'External'}</td>
                  <td className={st.cls} data-col="status">{st.text}</td>
                  <td data-col="tp">{tp ? <>{price(tp.price)} <small className="tp-pct">{tp.pct > 0 ? tp.pct + '%' : 'Bybit'}</small></> : '—'}</td>
                  {risk ? <td className={view === 'margin' ? '' : tone(movePct(p))} data-col="risk">{view === 'margin' ? <MarginCell p={p} /> : num(movePct(p), 2) + '%'}</td> : <td className="na">—</td>}
                  <td>{p.owner === 'bot' ? <button type="button" className="row-act" onClick={onGoCycles} title="Open the Bot Cycles page (resume / resolve cycles)">Cycle</button> : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!fixedSymbol && <Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="positions" onPage={setPage} />}
      </>}
    </div>
  );
};


