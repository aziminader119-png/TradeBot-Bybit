import {useRead, refreshReportRead} from './reports.tsx';
import {SymbolLink} from './SymbolLink.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BotStateSummary } from '../../types/trading.ts';
import type { StrategyCycle } from '../../types/strategy.ts';
import { HedgeStartDialog } from '../terminal/HedgeStartDialog.tsx';
import { ManualOrderDialog } from './ManualOrderDialog.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { Pager, RowsPicker, SortTh, price, signedPct, sortRows, tone, usePaged, useSort } from './table.tsx';

// Symbols page of the approved light design. Every row is a real Bybit USDT perpetual (GET /api/symbols, which
// lists only instruments loaded from Bybit), joined with the cached Bybit ticker fields (GET /api/instruments).
// 1H / 24H % come from Bybit's ticker; 2H–1M % from Bybit candles for the rows on screen ("—" = no candle that far back). The single action is "Start Buy + Sell": it opens
// the existing HedgeStartDialog (read-only preview + fresh Bybit position check, real orders only after its
// confirmation, using the saved Custom / Minimum + 1 USDT settings).

type Row = { symbol: string; lastPrice: number | null; change24hPct: number | null; turnover24h: number | null; maxLeverage: number; minQty: number; minNotional: number; cycle: string | null; positions: { side: string; owner: string; size: number }[] };
type Inst = { price1hPcnt?: number; fundingRate?: number; lastPrice?: number };
type Managed = 'BOTH' | 'LONG' | 'SHORT' | 'NONE';
type Mode = 'all' | 'both' | 'LONG' | 'SHORT' | 'none';
type SideF = 'all' | 'BUY' | 'SELL';
type K = 'symbol' | 'price' | 'h1' | 'h24' | 'funding' | 'managed' | 'turnover' | '2H' | '4H' | '12H' | '48H' | '72H' | '1W' | '1M';

const CHANGE_COLS = ['2H', '4H', '12H', '48H', '72H', '1W', '1M']; // from Bybit candles, visible page only (/api/futures/changes)
const MANAGED_LABEL: Record<Managed, string> = { BOTH: 'BUY / SHORT', LONG: 'BUY', SHORT: 'SHORT', NONE: '—' };
// managed position sides in the shared BUY / SHORT colours
const ManagedSides: React.FC<{ m: Managed }> = ({ m }) => m === 'NONE' ? <>—</> : <span className="managed-side-stack">{m !== 'SHORT' && <span className="pos-buy">BUY</span>}{m !== 'LONG' && <span className="pos-short">SHORT</span>}</span>;
// a side counts as managed while the bot holds it or will reopen it (not CLOSED / FAILED) in a cycle that is not closed
const LIVE_PHASES = new Set(['OPENING', 'OPEN', 'CLOSING', 'WAIT_TRIGGER', 'FROZEN']);

export function managedSides(c: StrategyCycle | undefined): Managed {
  if (!c || c.status === 'CLOSED') return 'NONE';
  const b = LIVE_PHASES.has(c.sides?.Buy?.phase), s = LIVE_PHASES.has(c.sides?.Sell?.phase);
  return b && s ? 'BOTH' : b ? 'LONG' : s ? 'SHORT' : 'NONE';
}

const ExtIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M20 13v7H4V4h7" /></svg>
);

export const LightSymbols: React.FC<{ state: BotStateSummary | null; onRefresh: () => void; onGoSymbol?: (symbol: string) => void }> = ({ state, onRefresh, onGoSymbol }) => {
  const catalogue = useRead<{symbols: Row[]}>('/api/symbols', 60000);
  const rows = catalogue.data?.symbols || null, error = catalogue.error;
  const inst = state?.tickers || {};
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('all');
  const [sideF, setSideF] = useState<SideF>('all');
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [sort, toggleSort] = useSort<K>();
  const initialOrder = useRef(new Map<string, number>());
  const [history, setHistory] = useState<Record<string, Record<string, number | null>>>({});
  const historyRef = useRef(history);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyProgress, setHistoryProgress] = useState({ done: 0, total: 0 });
  const frozenSort = useRef(new Map<string, number | string | null>());
  const [dialogSymbol, setDialogSymbol] = useState<string | null>(null);
  const [singleOrder, setSingleOrder] = useState<{ symbol: string; side: 'Buy' | 'Sell'; value: number } | null>(null);
  const pinRequired = Boolean((state?.settings as any)?.hasSecurityPin);
  const openSingle = async (symbol: string, side: 'Buy' | 'Sell') => {
    let value = 10;
    try {
      const response = await fetch('/api/hedge/settings');
      const settings = (await response.json()).settings;
      const configured = Number(side === 'Buy' ? settings?.buyNotionalUsdt : settings?.sellNotionalUsdt);
      if (Number.isFinite(configured) && configured > 0) value = configured;
    } catch { /* User can edit the amount before placing an order. */ }
    setSingleOrder({ symbol, side, value });
  };
  const cycles: Record<string, StrategyCycle> = ((state as any)?.strategyCycles || {}) as Record<string, StrategyCycle>;

  const exchangePositions = useMemo(() => {
    const bySymbol = new Map<string, Row['positions']>();
    for (const p of state?.positions || []) if (!p.missingOnExchangeSince && !p.paper && p.size > 0) {
      const list = bySymbol.get(p.symbol) || []; list.push({side:p.side, owner:p.owner, size:p.size}); bySymbol.set(p.symbol,list);
    }
    return bySymbol;
  }, [state?.positions]);
  const data = useMemo(() => (rows || []).map((r) => {
    const i = inst[r.symbol];
    const lastPrice = typeof i?.lastPrice === 'number' && i.lastPrice > 0 ? i.lastPrice : r.lastPrice;
    const priced = typeof lastPrice === 'number' && lastPrice > 0; // no ticker yet → no ticker-derived values
    return {
      ...r, lastPrice, base: r.symbol.replace(/USDT$/, ''),
      change24hPct: i?.price24hPcnt ?? r.change24hPct,
      turnover24h: i?.turnover24h ?? r.turnover24h,
      maxLeverage: i?.maxLeverage ?? r.maxLeverage,
      cycle: state ? cycles[r.symbol]?.status || null : r.cycle,
      positions: state?.connection?.positionsSyncedAt ? exchangePositions.get(r.symbol) || [] : r.positions || [],
      h1: priced && typeof i?.price1hPcnt === 'number' && Number.isFinite(i.price1hPcnt) ? i.price1hPcnt : null,
      funding: priced && typeof i?.fundingRate === 'number' && Number.isFinite(i.fundingRate) ? i.fundingRate : null,
      managed: managedSides(cycles[r.symbol]),
    };
  }), [rows, inst, cycles, exchangePositions, state?.connection?.positionsSyncedAt]);
  type D = (typeof data)[number];
  // Keep the original row order stable while live tickers update every few seconds.
  if (initialOrder.current.size === 0) {
    [...data].sort((a, b) => (b.turnover24h ?? 0) - (a.turnover24h ?? 0)).forEach((r, index) => initialOrder.current.set(r.symbol, index));
  } else for (const r of data) if (!initialOrder.current.has(r.symbol)) initialOrder.current.set(r.symbol, initialOrder.current.size);
  const sortValue = (r: D, k: K): number | string | null => k === 'symbol' ? r.symbol : k === 'price' ? r.lastPrice : k === 'h1' ? r.h1 : k === 'h24' ? r.change24hPct : k === 'funding' ? r.funding : k === 'turnover' ? r.turnover24h : k === 'managed' ? MANAGED_LABEL[r.managed] : historyRef.current[r.symbol]?.[k] ?? null;
  const sortClick = async (k: K) => {
    if (CHANGE_COLS.includes(k) && !historyLoaded) {
      if (historyBusy) return;
      setHistoryBusy(true); setHistoryError('');
      try {
        const symbols = data.map(r => r.symbol).filter(s => !(s in historyRef.current));
        const chunks: string[][] = [];
        // Small, paced batches avoid Bybit rate limits and overloaded candle-cache requests.
        for (let i = 0; i < symbols.length; i += 10) chunks.push(symbols.slice(i, i + 10));
        const next = { ...historyRef.current };
        let index = 0, completed = data.length - symbols.length;
        setHistoryProgress({ done: completed, total: data.length });
        const failures: string[] = [];
        const worker = async () => {
          while (index < chunks.length) {
            const chunk = chunks[index++];
            let ok = false;
            for (let attempt = 0; attempt < 3 && !ok; attempt++) {
              try {
                const response = await fetch('/api/futures/changes?symbols=' + chunk.join(','), { cache: 'no-store' });
                if (!response.ok) throw Error(`HTTP ${response.status}`);
                const payload = await response.json();
                if (!payload.changes) throw Error('Missing historical data');
                Object.assign(next, payload.changes);
                completed += chunk.length; setHistoryProgress({ done: completed, total: data.length });
                historyRef.current = { ...next }; setHistory({ ...next });
                ok = true;
              } catch {
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
              }
            }
            if (!ok) failures.push(...chunk);
          }
        };
        await Promise.all([worker(), worker()]);
        if (failures.length) throw Error(`${failures.length} symbols could not be loaded; saved data is kept. Click again to retry missing symbols.`);
        historyRef.current = next; setHistory(next); setHistoryLoaded(true);
      } catch (e: any) { setHistoryError(e.message || 'Historical sort unavailable'); return; }
      finally { setHistoryBusy(false); }
    }
    const values = new Map<string, number | string | null>();
    for (const row of data) values.set(row.symbol, sortValue(row, k));
    frozenSort.current = values;
    toggleSort(k);
  };

  const overview = useMemo(() => {
    const c = { BOTH: 0, LONG: 0, SHORT: 0, NONE: 0 } as Record<Managed, number>;
    for (const r of data) c[r.managed]++;
    const f = data.map((r) => r.funding).filter((v): v is number => v !== null);
    return { ...c, avgFunding: f.length ? f.reduce((a, b) => a + b, 0) / f.length : null };
  }, [data]);

  const filtered = useMemo(() => {
    const s = q.trim().toUpperCase();
    const f = data.filter((r) => (!s || r.symbol.includes(s))
      && (mode === 'all' || (mode === 'both' && r.managed === 'BOTH') || (mode === 'none' && r.managed === 'NONE') || (mode === r.managed))
      && (sideF === 'all' || (sideF === 'BUY' && (r.managed === 'LONG' || r.managed === 'BOTH')) || (sideF === 'SELL' && (r.managed === 'SHORT' || r.managed === 'BOTH'))));
    // default order: 24h turnover (most traded first), as on the previous Symbols page
    const base = [...f].sort((a, b) => (initialOrder.current.get(a.symbol) ?? 0) - (initialOrder.current.get(b.symbol) ?? 0));
    return sortRows<D, K>(base, sort, (r) => frozenSort.current.get(r.symbol) ?? null);
  }, [data, q, mode, sideF, sort, history]);
  const pg = usePaged(filtered, size, page);
  const visibleSymbols = pg.slice.map((r) => r.symbol).join(',');
  const changes = useRead<{ changes: Record<string, Record<string, number | null>> }>(visibleSymbols ? '/api/futures/changes?symbols=' + visibleSymbols : null, 60000);
  useEffect(() => {
    if (!changes.data?.changes) return;
    historyRef.current = { ...historyRef.current, ...changes.data.changes };
  }, [changes.data]);
  const chg = (symbol: string, k: string) => changes.data?.changes?.[symbol]?.[k] ?? history[symbol]?.[k] ?? historyRef.current[symbol]?.[k] ?? null;
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  const fundingTxt = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(4)}%`);

  return (
    <div className="workspace lp-symbols" data-testid="symbols-page">
      <section className="lp-panel symbols-overview" data-testid="symbols-overview">
        <div className="section-title">Symbol Overview</div>
        <div className="overview-grid">
          <div className="overview-card"><div className="k">Total Symbols</div><div className="v" data-testid="ov-total">{rows ? `${rows.length} symbols` : '—'}</div></div>
          <div className="overview-card"><div className="k">Both Sides</div><div className="v" data-testid="ov-both">{rows ? overview.BOTH : '—'}</div></div>
          <div className="overview-card"><div className="k">Long Only</div><div className="v green" data-testid="ov-long">{rows ? overview.LONG : '—'}</div></div>
          <div className="overview-card"><div className="k">Short Only</div><div className="v red" data-testid="ov-short">{rows ? overview.SHORT : '—'}</div></div>
          <div className="overview-card"><div className="k">Not Managed</div><div className="v" data-testid="ov-none">{rows ? overview.NONE : '—'}</div></div>
          <div className="overview-card"><div className="k">Avg Funding</div><div className="v orange" data-testid="ov-funding">{fundingTxt(overview.avgFunding)}</div></div>
        </div>
      </section>

      <section className="lp-panel symbols-panel">
        {error && <div className="lp-error" data-testid="symbols-error" role="alert">Symbol list from Bybit unavailable: {error} <button type="button" onClick={()=>refreshReportRead('/api/symbols')}>Retry</button></div>}
        <div className="lp-toolbar">
          <div className="tb-left"><input className="search" type="search" placeholder="Search by Symbol (e.g. BTC)..." aria-label="Search symbols" value={q} onChange={(e) => reset(setQ)(e.target.value)} data-testid="symbol-search" /></div>
          <FilterChoices<Mode> label="Management" className="management-filter" testId="mgmt-filter" optionAttribute="data-mode" value={mode} options={[{value:'all',label:'All'},{value:'both',label:'Both'},{value:'LONG',label:'BUY'},{value:'SHORT',label:'SHORT'},{value:'none',label:'None'}]} onChange={reset(setMode)}/>

          <FilterChoices<SideF> label="Side" className="tb-right" testId="side-filter" optionAttribute="data-side" value={sideF} options={[{value:'all',label:'All Sides'},{value:'BUY',label:'BUY'},{value:'SELL',label:'SHORT'}]} onChange={reset(setSideF)}/>
        </div>
        {historyBusy && <div role="status" className="ft-muted">Loading historical changes: {historyProgress.done} / {historyProgress.total} symbols…</div>}
        {historyError && <div role="alert" className="lp-error">{historyError} — click the column again to retry.</div>}
        <div className="aged-table-title"><span>All Symbols</span></div>
        <div className="table-wrap" role="region" tabIndex={0} aria-label="Symbols table">
          <table className="lp-table symbols-table" data-testid="symbols-table">
            <colgroup><col style={{ width: '10%' }} /><col style={{ width: '4.5%' }} /><col style={{ width: '8.5%' }} />{Array.from({ length: 9 }, (_, i) => <col key={i} style={{ width: '4.8%' }} />)}<col style={{ width: '8%' }} /><col style={{ width: '9.5%' }} /><col style={{ width: '12.3%' }} /></colgroup>
            <thead><tr>
              <SortTh k="symbol" s={sort} onSort={sortClick}>Symbol</SortTh>
              <th>Bybit</th>
              <SortTh k="price" s={sort} onSort={sortClick} title="Last traded price from Bybit's ticker">Last Price</SortTh>
              <SortTh k="h1" s={sort} onSort={sortClick} title="From Bybit's ticker (prevPrice1h)">1H %</SortTh>
              {CHANGE_COLS.slice(0, 3).map((t) => <SortTh key={t} k={t} s={sort} onSort={sortClick} title="Bybit candle history, sorted across all symbols">{t} %</SortTh>)}
              <SortTh k="h24" s={sort} onSort={sortClick} title="From Bybit's ticker (price24hPcnt)">24H %</SortTh>
              {CHANGE_COLS.slice(3).map((t) => <SortTh key={t} k={t} s={sort} onSort={sortClick} title="Bybit candle history, sorted across all symbols">{t} %</SortTh>)}
              <SortTh k="funding" s={sort} onSort={sortClick} title="Current funding rate from Bybit's ticker">Funding Rate</SortTh>
              <SortTh k="managed" s={sort} onSort={sortClick} title="Sides the bot holds or will reopen in this symbol's hedge cycle">Managed Sides</SortTh>
              <th>Trade</th>
            </tr></thead>
            <tbody>
              {!rows ? <tr><td colSpan={15} className="empty">{error?'Bybit symbol list unavailable.':'Loading the Bybit symbol list…'}</td></tr>
                : pg.slice.length === 0 ? <tr><td colSpan={15} className="empty">{rows.length ? 'No matching symbols' : 'No symbols loaded from Bybit'}</td></tr>
                : pg.slice.map((r) => {
                  const busy = Boolean(r.cycle && r.cycle !== 'CLOSED') || r.positions.length > 0;
                  const ext = r.positions.filter((p) => p.owner !== 'bot').length;
                  return (
                    <tr key={r.symbol} data-symbol={r.symbol}>
                      <td className="symbol" title={r.symbol}><SymbolLink symbol={r.symbol} title="Open Futures workspace" className="symbol-link">{r.symbol}</SymbolLink><small className="maxlev">{r.maxLeverage ? `${r.maxLeverage} X` : '—'}</small></td>
                      <td><a className="bybit-icon" title={`Open ${r.symbol} on Bybit`} target="_blank" rel="noopener noreferrer" href={`https://www.bybit.com/trade/usdt/${r.symbol}`}><ExtIcon /></a></td>
                      <td data-col="price">{price(r.lastPrice)}</td>
                      <td className={`change ${tone(r.h1)}`} data-col="h1">{signedPct(r.h1)}</td>
                      {CHANGE_COLS.slice(0, 3).map((t) => <td key={t} className={`change ${tone(chg(r.symbol, t))}`} data-col={'c' + t}>{signedPct(chg(r.symbol, t))}</td>)}
                      <td className={`change ${tone(r.change24hPct)}`} data-col="h24">{signedPct(r.change24hPct)}</td>
                      {CHANGE_COLS.slice(3).map((t) => <td key={t} className={`change ${tone(chg(r.symbol, t))}`} data-col={'c' + t}>{signedPct(chg(r.symbol, t))}</td>)}
                      <td className={tone(r.funding)} data-col="funding">{fundingTxt(r.funding)}</td>
                      <td data-col="managed"><ManagedSides m={r.managed} />{ext > 0 && <small className="ext-note" title="Open positions not opened by the bot; never changed">{ext} external</small>}</td>
                      <td className="trade-cell">
                        <div className="symbol-trade-actions">
                          <button type="button" className={`trade${busy ? ' muted' : ''}`} data-testid={`start-${r.symbol}`} title="Open a bot-managed Buy + Short hedge after confirmation" onClick={() => setDialogSymbol(r.symbol)}>Start Buy + Sell</button>
                          <div className="symbol-trade-singles">
                            <button type="button" className="trade pos-buy" onClick={() => void openSingle(r.symbol, 'Buy')}>Buy Only</button>
                            <button type="button" className="trade pos-short" onClick={() => void openSingle(r.symbol, 'Sell')}>Short Only</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="tb-paging-row"><div className="tb-paging-rows"><RowsPicker size={size} onSize={reset(setSize)} /></div><Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="symbols" onPage={setPage} /></div>
      </section>

      {dialogSymbol && <HedgeStartDialog symbol={dialogSymbol} pinRequired={pinRequired} onClose={() => setDialogSymbol(null)} onDone={onRefresh} />}
      {singleOrder && <ManualOrderDialog key={singleOrder.symbol + singleOrder.side} symbol={singleOrder.symbol} side={singleOrder.side} initialValue={singleOrder.value} enabled={state?.systemMetrics?.tradingMode === 'REAL' && state?.systemMetrics?.tradingState === 'RUNNING'} onClose={() => setSingleOrder(null)} onDone={onRefresh} />}
    </div>
  );
};



