import React, { useEffect, useMemo, useState } from 'react';
import { BotPosition, BotStateSummary } from '../../types/trading.ts';
import type { StrategyConfig, StrategyCycle } from '../../types/strategy.ts';
import { syncedPositions } from './LightShell.tsx';
import { movePct } from './positionData.ts';
import { Pager, RowsPicker, SortTh, compactTargetPrice, num, price, sortRows, tone, usePaged, useSort } from './table.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { DateTime, Liq, SymbolSide } from './format.tsx';
import { PositionCloseButton, PositionOwnershipActions, usePumpOwnership } from './PositionOwnership.tsx';
import {BulkCloseSelected} from './BulkCloseSelected.tsx';

// BOT Positions page of the approved light design. Rows = real Bybit positions from the last successful sync that
// the backend marks as bot-owned (owner === 'bot'); nothing else is shown. Everything comes from the WebSocket
// snapshot, so a TP change saved on the Dashboard shows here immediately. MART and SL have no data in this
// version ("—"). No order or ownership action is offered here (managing / resolving cycles stays on Bot Cycles).

type SideF = 'ALL' | 'Buy' | 'Sell';
type K = 'symbol' | 'size' | 'value' | 'entry' | 'mark' | 'liq' | 'upnl' | 'upnlPct' | 'open' | 'age' | 'status' | 'tp';

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

export const LightBotPositions: React.FC<{ state: BotStateSummary | null; onGoCycles: () => void }> = ({ state, onGoCycles }) => {
  const pumpOwnership = usePumpOwnership();
  const [q, setQ] = useState('');
  const [sideF, setSideF] = useState<SideF>('ALL');
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [sort, toggleSort] = useSort<K>();
  const [checked,setChecked]=useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const conn: any = (state as any)?.connection;
  const configured = Boolean(state?.settings?.isApiKeyConfigured);
  const synced = syncedPositions(state);
  const cycles: Record<string, StrategyCycle> = ((state as any)?.strategyCycles || {}) as Record<string, StrategyCycle>;
  const strategies: Record<string, StrategyConfig> = ((state as any)?.strategies || {}) as Record<string, StrategyConfig>;
  const managedIds = new Set<string>(state?.systemMetrics?.managedCycleIds || []);
  const running = state?.systemMetrics?.tradingState === 'RUNNING';

  const data = useMemo(() => (synced || []).filter((p) => p.owner === 'bot').map((p) => {
    const c = cycles[p.symbol];
    const st = status(p, c, managedIds, running);
    const tp = botTp(p, c, strategies[p.symbol]);
    const opened = typeof p.cycleStartTime === 'number' && p.cycleStartTime > 0 ? p.cycleStartTime : null;
    return { p, st, tp, opened };
  }), [synced, cycles, strategies, state?.systemMetrics]);
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
    const f = data.filter((d) => (!s || d.p.symbol.includes(s)) && (sideF === 'ALL' || d.p.side === sideF));
    const base = [...f].sort((a, b) => a.p.symbol.localeCompare(b.p.symbol) || (a.p.side === 'Buy' ? -1 : 1));
    return sortRows<D, K>(base, sort, (d, k) => {
      switch (k) {
        case 'symbol': return d.p.symbol;
        case 'size': return d.p.size;
        case 'value': return d.p.notional;
        case 'entry': return d.p.entryPrice;
        case 'mark': return d.p.markPrice;
        case 'liq': return d.p.liqPrice ?? null;
        case 'upnl': return d.p.unrealizedPnl;
        case 'upnlPct': return movePct(d.p);
        case 'open': return d.opened;
        case 'age': return d.opened === null ? null : now - d.opened;
        case 'status': return d.st.text;
        case 'tp': return d.tp?.price ?? null;
      }
    });
  }, [data, q, sideF, sort, now]);
  const pg = usePaged(filtered, size, page);
  const livePos=new Map((synced||[]).filter(p=>p.size>0&&!p.missingOnExchangeSince).map(p=>[p.id,p]));
  const checkedPositions=checked.map(id=>livePos.get(id)).filter((p):p is BotPosition=>Boolean(p));
  const visibleIds=pg.slice.filter(d=>d.p.size>0&&!d.p.missingOnExchangeSince).map(d=>d.p.id);
  const selectedOnPage=visibleIds.length>0&&visibleIds.every(id=>checked.includes(id));
  const toggleAllVisible=(value:boolean)=>setChecked(prev=>value
    ? [...new Set([...prev,...visibleIds])]
    : prev.filter(id=>!visibleIds.includes(id)));
  const toggleRow=(id:string,value:boolean)=>setChecked(prev=>value?[...new Set([...prev,id])]:prev.filter(v=>v!==id));

  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };
  const v = (x: string | number) => (synced ? x : '—');

  const emptyText = !configured ? 'Connect the Bybit API on the Dashboard to see your positions.'
    : !synced ? 'Not synced with Bybit.'
    : data.length === 0 ? 'No open BOT position on Bybit.' : 'No matching positions';

  return (
    <div className="workspace lp-botpos" data-testid="bot-positions-page">
      <div className="page-summary" data-testid="botpos-summary">
        <div className="summary-item"><div className="k">Total BOT Positions</div><div className="v" data-testid="sum-total">{v(sum.total)}</div></div>
        <div className="summary-item"><div className="k">BUY Positions</div><div className="v green" data-testid="sum-buy">{v(sum.buy)}</div></div>
        <div className="summary-item"><div className="k">SELL Positions</div><div className="v red" data-testid="sum-sell">{v(sum.sell)}</div></div>
        <div className="summary-item"><div className="k">BUY Profit</div><div className="v green" data-testid="sum-buy-profit">{v(usd(sum.buyProfit))}</div></div>
        <div className="summary-item"><div className="k">BUY Loss</div><div className="v red" data-testid="sum-buy-loss">{v(usd(sum.buyLoss))}</div></div>
        <div className="summary-item"><div className="k">SELL Profit</div><div className="v green" data-testid="sum-sell-profit">{v(usd(sum.sellProfit))}</div></div>
        <div className="summary-item"><div className="k">SELL Loss</div><div className="v red" data-testid="sum-sell-loss">{v(usd(sum.sellLoss))}</div></div>
        <div className="summary-item"><div className="k">Total P&amp;L</div><div className={`v ${synced ? tone(sum.pnl) : ''}`} data-testid="sum-pnl">{v(usd(sum.pnl))}</div></div>
        <div className="summary-item" title="Bot positions the bot is not acting on right now (paused, incomplete or needing review)"><div className="k">Paused / Review</div><div className="v" data-testid="sum-paused">{v(sum.paused)}</div></div>
      </div>

      <div className="lp-toolbar">
        <div className="tb-left">
          <input className="search" type="search" placeholder="Search by Symbol..." aria-label="Search by symbol" value={q} onChange={(e) => reset(setQ)(e.target.value)} data-testid="botpos-search" />
          <BulkCloseSelected positions={checkedPositions} onClosed={ids=>setChecked(prev=>prev.filter(id=>!ids.includes(id)))}/>
          {checked.length>0&&<button type="button" className="tb-v19-clear-selection" onClick={()=>setChecked([])}>Clear selection</button>}
          <button className="tb-bulk" type="button" disabled title="Not available in this version" data-testid="bulk-release">Bulk Release All From BOT</button>
        </div>

        <FilterChoices<SideF> label="Side" className="tb-right" testId="side-filter" optionAttribute="data-filter" value={sideF} options={[{value:'ALL',label:'All Sides'},{value:'Buy',label:'BUY'},{value:'Sell',label:'SHORT'}]} onChange={reset(setSideF)}/>
      </div>

      <div className="table-wrap" role="region" tabIndex={0} aria-label="BOT positions table">
        <table className="lp-table botpos-table tb-unified-positions" data-testid="botpos-table">
          <thead><tr>
            <SortTh k="symbol" s={sort} onSort={toggleSort}>Symbol</SortTh>
            <th>Owner</th>
            <SortTh k="size" s={sort} onSort={toggleSort}>Size</SortTh>
            <SortTh k="value" s={sort} onSort={toggleSort}>Value $</SortTh>
            <SortTh k="entry" s={sort} onSort={toggleSort}>Entry</SortTh>
            <SortTh k="mark" s={sort} onSort={toggleSort}>Mark</SortTh>
            <SortTh k="liq" s={sort} onSort={toggleSort}>Liq</SortTh>
            <SortTh k="tp" s={sort} onSort={toggleSort} title="Internal BOT take profit; no exchange stop loss">TP / SL</SortTh>
            <th className="tb-v19-select-col" title="Select visible positions"><input type="checkbox"
               aria-label="Select all visible positions" checked={selectedOnPage} disabled={!visibleIds.length}
               onChange={e=>toggleAllVisible(e.target.checked)} /></th>
            <SortTh k="upnl" s={sort} onSort={toggleSort}>P&amp;L $</SortTh>
            <SortTh k="upnlPct" s={sort} onSort={toggleSort} title="Unleveraged price move, not exchange ROE">P&amp;L %</SortTh>
            <SortTh k="open" s={sort} onSort={toggleSort}>Open Time</SortTh>
            <SortTh k="age" s={sort} onSort={toggleSort}>Age</SortTh>
            <th title="MART record">MART</th>
            <th>Act</th>
          </tr></thead>
          <tbody>
            {pg.slice.length === 0 ? <tr><td colSpan={15} className="empty" data-testid="botpos-empty">{emptyText}</td></tr>
              : pg.slice.map(({ p, st, tp, opened }) => (
                <tr key={p.id} data-pos={p.id}>
                  <td className="symbol" data-col="symbol"><span className="tb-sym-compact"><SymbolSide symbol={p.symbol} leverage={p.leverage} side={p.side}/>
                    <a className="bybit-icon" title={`Open ${p.symbol} on Bybit Futures`} target="_blank" rel="noopener noreferrer"
                       href={`https://www.bybit.com/trade/usdt/${p.symbol}`} aria-label={`Open ${p.symbol} on Bybit Futures`}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M20 13v7H4V4h7"/></svg>
                    </a></span></td>
                  <td data-col="owner"><span className="tb-cell-primary">BOT</span><span className={`tb-cell-secondary ${st.cls}`}>{st.text}</span></td>
                  <td data-col="size">{p.size}</td>
                  <td data-col="value">{num(p.notional, 2)}</td>
                  <td data-col="entry">{price(p.entryPrice)}</td>
                  <td data-col="mark">{price(p.markPrice)}</td>
                  <td data-col="liq"><Liq value={p.liqPrice} fmt={price}/></td>
                  <td data-col="tp"><span className="tb-cell-primary green">TP&nbsp;{tp ? compactTargetPrice(tp.price) : '—'}</span><span className="tb-cell-secondary">SL&nbsp; —</span></td>
                  <td className="tb-v19-select-col" data-col="select"><input type="checkbox"
                    aria-label={`Select ${p.symbol} ${p.side} position`}
                    checked={checked.includes(p.id)} disabled={p.size<=0||Boolean(p.missingOnExchangeSince)}
                    onChange={e=>toggleRow(p.id,e.target.checked)} /></td>
                  <td className={tone(p.unrealizedPnl)} data-col="upnl">{Number.isFinite(p.unrealizedPnl) ? `${p.unrealizedPnl > 0 ? '+' : ''}${num(p.unrealizedPnl, 4)}` : '—'}</td>
                  <td className={tone(movePct(p))} data-col="upnlPct">{movePct(p) === null ? '—' : `${movePct(p)! > 0 ? '+' : ''}${num(movePct(p), 2)}%`}</td>
                  <td data-col="open"><DateTime ts={opened}/></td>
                  <td data-col="age">{age(opened === null ? null : now - opened)}</td>
                  <td data-col="mart">{p.martTriggered ? 'MART' : '—'}</td>
                  <td data-col="actions"><div className="tb-v19-row-actions"><PositionCloseButton id={p.id} symbol={p.symbol} side={p.side} quantity={p.size} unrealizedPnl={p.unrealizedPnl}/><PositionOwnershipActions id={p.id} symbol={p.symbol} side={p.side} owner={p.owner} refresh={pumpOwnership.refresh}/><button type="button" className="row-act" onClick={onGoCycles}>Cycle</button></div></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="tb-paging-row"><div className="tb-paging-rows"><RowsPicker size={size} onSize={reset(setSize)} /></div><Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="positions" onPage={setPage} /></div>
    </div>
  );
};

