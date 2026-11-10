import React, { useEffect, useMemo, useState } from 'react';
// The one alert UI (builder, rule list, event list) used by Smart MART Alerts, Alert History and the chart.
// All alerts are evaluated on the server (src/server/alerts) and only notify; nothing here can trade.
import { INDICATORS, PRICE_SOURCES, type IndicatorKey, type Params } from '../../shared/indicators.ts';
import { ALERT_TIMEFRAMES, CONDITIONS, conditionSpec, describeRule, timeframeLabel, type AlertEvent, type AlertRule } from '../../shared/alertRules.ts';
import { postJson } from '../light/Modal.tsx';
import { refreshReportRead, useRead } from '../light/reports.tsx';
import { DateTime } from '../light/format.tsx';
import { Pager, RowsPicker, num, price, tone, usePaged } from '../light/table.tsx';
import { FilterChoices } from '../light/FilterChoices.tsx';
import { symbolPath } from '../light/navigation.ts';

export const RULES_URL = '/api/indicator-alerts';
export const historyUrl = (symbol?: string) => '/api/indicator-alerts/history?limit=2000' + (symbol ? '&symbol=' + encodeURIComponent(symbol) : '');
type RuleRow = AlertRule & { description: string };
export function useAlertRules() { return useRead<{ rules: RuleRow[]; unseen: number }>(RULES_URL, 30000); }
export function useAlertEvents(symbol?: string) { return useRead<{ events: AlertEvent[] }>(historyUrl(symbol), 30000); }
const reload = (symbol?: string) => { refreshReportRead(RULES_URL); refreshReportRead(historyUrl()); if (symbol) refreshReportRead(historyUrl(symbol)); };
async function send(method: 'POST' | 'DELETE', url: string, body?: any) {
  const r = method === 'POST' ? await postJson(url, body ?? {}) : await fetch(url, { method: 'DELETE', body: '{}' }).then(async (x) => ({ ok: x.ok, status: x.status, data: await x.json().catch(() => ({})) }));
  if (!r.ok) throw Error(r.data?.error || 'Request failed (' + r.status + ')');
  return r.data;
}

export type RuleDraft = Partial<AlertRule> & { indicator: IndicatorKey; params: Params };
export const blankRule = (symbol: string, smart: boolean, indicator: IndicatorKey = 'EMA', params?: Params): RuleDraft => {
  const p: Params = {}; for (const s of INDICATORS[indicator].params) p[s.name] = s.default;
  return { symbol, indicator, params: { ...p, ...(params || {}) }, timeframe: '60', condition: CONDITIONS[indicator][0][0].key, requirePosition: smart, side: 'Both', owner: 'all', lossBasis: 'price', mode: 'close', frequency: 'every', cooldownMin: 60, enabled: true };
};

/** Create or edit one alert rule. */
export function AlertRuleForm({ initial, onDone, lockSymbol }: { initial: RuleDraft; onDone: (r?: AlertRule) => void; lockSymbol?: boolean }) {
  const [d, setD] = useState<RuleDraft>(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => setD(initial), [initial]);
  const spec = INDICATORS[d.indicator], cond = conditionSpec(d.indicator, d.condition || '');
  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
  const chooseIndicator = (k: IndicatorKey) => { const b = blankRule(d.symbol || '', Boolean(d.requirePosition), k); set({ indicator: k, params: b.params, condition: b.condition, level: undefined, period2: undefined }); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = { ...d, symbol: String(d.symbol || '').toUpperCase() };
      const res = d.id ? await send('POST', RULES_URL + '/' + encodeURIComponent(d.id), body) : await send('POST', RULES_URL, body);
      reload(body.symbol); onDone(res.rule);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const editable = spec.params.filter((p) => p.kind !== 'color' && !(p.name === 'width'));
  return <form className="security-form alert-form" onSubmit={submit} data-testid="alert-form">
    <label>Symbol<input value={d.symbol || ''} onChange={(e) => set({ symbol: e.target.value.toUpperCase(), ...(e.target.value === '*' ? { requirePosition: false } : {}) })} placeholder="BTCUSDT or * for ALL" required readOnly={lockSymbol} pattern="(\*|[A-Za-z0-9]{2,30}USDT)" />{!lockSymbol && !d.requirePosition && <button type="button" onClick={() => set({ symbol: '*', requirePosition: false })}>All Bybit USDT perpetuals</button>}</label>
    <label>Indicator<select value={d.indicator} onChange={(e) => chooseIndicator(e.target.value as IndicatorKey)}>{Object.values(INDICATORS).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></label>
    {editable.map((p) => <label key={p.name}>{p.label}{p.kind === 'source'
      ? <select value={String(d.params[p.name])} onChange={(e) => set({ params: { ...d.params, [p.name]: e.target.value } })}>{PRICE_SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
      : <input type="number" step={p.step ?? 'any'} min={p.min} max={p.max} value={String(d.params[p.name] ?? '')} onChange={(e) => set({ params: { ...d.params, [p.name]: e.target.value === '' ? '' : Number(e.target.value) } })} required />}</label>)}
    <label>Timeframe<select value={d.timeframe} onChange={(e) => set({ timeframe: e.target.value as any })}>{ALERT_TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
    <label>Trigger condition<select value={d.condition} onChange={(e) => set({ condition: e.target.value })} data-testid="alert-condition">{CONDITIONS[d.indicator].map(([c]) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
    {cond?.needsPeriod2 && <label>Second period<input type="number" min={1} max={500} step={1} value={d.period2 ?? ''} onChange={(e) => set({ period2: Number(e.target.value) })} required /></label>}
    {cond?.level && <label>{cond.level === 'mult' ? 'Multiplier' : 'Level'}<input type="number" step="any" value={d.level ?? ''} onChange={(e) => set({ level: e.target.value === '' ? undefined : Number(e.target.value) })} required /></label>}
    <label>Signal<select value={d.mode} onChange={(e) => set({ mode: e.target.value as any })}><option value="close">Confirmed candle close</option><option value="intrabar">Intrabar (unconfirmed, forming candle)</option></select></label>
    <label className="check"><input type="checkbox" disabled={d.symbol === '*'} checked={Boolean(d.requirePosition)} onChange={(e) => set({ requirePosition: e.target.checked })} /> Only for my open positions (Smart MART recovery)</label>
    {d.requirePosition && <>
      <label>Position side<select value={d.side} onChange={(e) => set({ side: e.target.value as any })}><option value="Both">BUY and SELL</option><option value="Buy">BUY</option><option value="Sell">SELL</option></select></label>
      <label>Owner<select value={d.owner} onChange={(e) => set({ owner: e.target.value as any })}><option value="all">All</option><option value="bot">BOT</option><option value="external">External</option></select></label>
      <label>Minimum loss %<input type="number" min={0} step="any" value={d.minLossPct ?? ''} onChange={(e) => set({ minLossPct: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="optional" /></label>
      <label>Loss measured as<select value={d.lossBasis} onChange={(e) => set({ lossBasis: e.target.value as any })}><option value="price">Underlying price move from entry</option><option value="roi">Leveraged ROI (P&amp;L ÷ position margin)</option></select></label>
    </>}
    <label>Frequency<select value={d.frequency} onChange={(e) => set({ frequency: e.target.value as any })}><option value="every">Every signal</option><option value="once">Once, then disable</option></select></label>
    <label>Cooldown (minutes)<input type="number" min={0} max={10080} step={1} value={d.cooldownMin ?? 0} onChange={(e) => set({ cooldownMin: Number(e.target.value) })} /></label>
    <label>Name<input value={d.name || ''} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="optional" /></label>
    <label className="check"><input type="checkbox" checked={d.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
    <p className="lp-source-note">Notification only: an alert never opens, closes or adds to a position and never changes TP, leverage, margin, freeze or ownership.</p>
    <div className="lp-risk-filter"><button className="report-button" type="submit" disabled={busy} data-testid="alert-save">{busy ? 'Saving…' : d.id ? 'Save alert' : 'Create alert'}</button><button type="button" onClick={() => onDone()}>Cancel</button></div>
    {error && <p className="red" role="alert">{error}</p>}
  </form>;
}

/** Alert definitions with search, filters, edit, enable/disable and delete. */
export function AlertRulesTable({ filter, symbol, onEdit }: { filter?: (r: RuleRow) => boolean; symbol?: string; onEdit: (r: RuleRow) => void }) {
  const read = useAlertRules();
  const [q, setQ] = useState(''), [state, setState] = useState<'all' | 'on' | 'off'>('all'), [size, setSize] = useState(20), [page, setPage] = useState(1), [error, setError] = useState('');
  const rows = useMemo(() => (read.data?.rules || []).filter((r) => (!filter || filter(r)) && (!symbol || r.symbol === symbol) && (state === 'all' || (state === 'on') === r.enabled) && (!q.trim() || (r.name + ' ' + r.symbol + ' ' + r.description).toUpperCase().includes(q.trim().toUpperCase()))), [read.data, q, state, symbol, filter]);
  const pg = usePaged(rows, size, page);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); reload(symbol); } catch (e: any) { setError(e.message); } };
  return <div data-testid="alert-rules">
    <div className="lp-toolbar"><div className="tb-left"><input className="search" type="search" placeholder="Search alerts..." aria-label="Search alerts" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div><RowsPicker size={size} onSize={(n) => { setSize(n); setPage(1); }} />
      <FilterChoices<'all' | 'on' | 'off'> label="State" className="tb-right" value={state} options={[{ value: 'all', label: 'All' }, { value: 'on', label: 'Enabled' }, { value: 'off', label: 'Disabled' }]} onChange={(v) => { setState(v); setPage(1); }} /></div>
    {error && <p className="red" role="alert">{error}</p>}
    <div className="table-wrap" role="region" tabIndex={0} aria-label="Alert definitions"><table className="lp-table lp-report-table"><thead><tr><th>Name</th><th>Symbol</th><th>Rule</th><th>Positions</th><th>Signal</th><th>Cooldown</th><th>Last alert</th><th>State</th><th>Actions</th></tr></thead><tbody>
      {pg.slice.length === 0 ? <tr><td colSpan={9} className="empty">{read.loading ? 'Loading alerts…' : read.error ? 'Alerts unavailable: ' + read.error : 'No alerts yet.'}</td></tr> : pg.slice.map((r) => <tr key={r.id} data-rule={r.id}>
        <td>{r.name}</td><td><a className="symbol-link" href={symbolPath(r.symbol)} target="_blank" rel="noopener noreferrer">{r.symbol}</a></td><td>{r.description}</td>
        <td>{r.requirePosition ? `${r.side === 'Both' ? 'BUY+SELL' : r.side === 'Buy' ? 'BUY' : 'SELL'} · ${r.owner === 'all' ? 'All' : r.owner === 'bot' ? 'BOT' : 'External'}${r.minLossPct ? ` · loss ≥ ${r.minLossPct}% (${r.lossBasis === 'roi' ? 'ROI' : 'price'})` : ''}` : 'Market (no position needed)'}</td>
        <td>{r.mode === 'close' ? 'Candle close' : 'Intrabar'}{r.frequency === 'once' ? ' · once' : ''}</td><td>{r.cooldownMin ? r.cooldownMin + ' min' : '—'}</td><td><DateTime ts={r.lastTriggeredAt ?? null} /></td>
        <td className={r.enabled ? 'green' : 'orange'}>{r.enabled ? 'Enabled' : 'Disabled'}</td>
        <td><button type="button" className="row-act" onClick={() => onEdit(r)}>Edit</button> <button type="button" className="row-act" onClick={() => act(() => send('POST', RULES_URL + '/' + encodeURIComponent(r.id) + '/enabled', { enabled: !r.enabled }))}>{r.enabled ? 'Disable' : 'Enable'}</button> <button type="button" className="row-act" onClick={() => { if (window.confirm('Delete this alert? Its history and all trading records are kept.')) void act(() => send('DELETE', RULES_URL + '/' + encodeURIComponent(r.id))); }}>Delete</button></td>
      </tr>)}
    </tbody></table></div>
    <Pager from={pg.from} to={pg.to} total={rows.length} page={pg.page} pages={pg.pages} noun="alerts" onPage={setPage} />
  </div>;
}

const paramText = (e: AlertEvent) => Object.entries(e.params).filter(([k]) => k !== 'color' && k !== 'width').map(([k, v]) => k + ' ' + v).join(', ') + (e.period2 ? ', period 2 ' + e.period2 : '');
export const eventLink = (e: AlertEvent) => symbolPath(e.symbol) + '?alert=' + encodeURIComponent(e.id);

/** Raised alerts. Clicking one opens its symbol chart with the triggering candle marked. */
export function AlertEventsTable({ filter, symbol, title = 'ALERT HISTORY' }: { filter?: (e: AlertEvent) => boolean; symbol?: string; title?: string }) {
  const read = useAlertEvents(symbol);
  const [q, setQ] = useState(''), [mode, setMode] = useState<'all' | 'close' | 'intrabar'>('all'), [size, setSize] = useState(20), [page, setPage] = useState(1);
  const rows = useMemo(() => (read.data?.events || []).filter((e) => (!filter || filter(e)) && (mode === 'all' || e.mode === mode) && (!q.trim() || (e.symbol + ' ' + e.ruleName + ' ' + e.indicator + ' ' + e.conditionLabel).toUpperCase().includes(q.trim().toUpperCase()))), [read.data, q, mode, filter]);
  const pg = usePaged(rows, size, page);
  const unseen = rows.filter((e) => e.status === 'new').map((e) => e.id);
  return <div data-testid="alert-events">
    <div className="lp-toolbar"><div className="tb-left"><input className="search" type="search" placeholder="Search alert history..." aria-label="Search alert history" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div><RowsPicker size={size} onSize={(n) => { setSize(n); setPage(1); }} />
      <FilterChoices<'all' | 'close' | 'intrabar'> label="Signal" className="tb-right" value={mode} options={[{ value: 'all', label: 'All' }, { value: 'close', label: 'Confirmed close' }, { value: 'intrabar', label: 'Intrabar' }]} onChange={(v) => { setMode(v); setPage(1); }} />
      {unseen.length > 0 && <button type="button" className="row-act" onClick={() => void send('POST', RULES_URL + '/history/seen', { ids: unseen }).then(() => reload(symbol))}>Mark {unseen.length} as seen</button>}</div>
    <div className="aged-table-title"><span>{title}</span></div>
    <div className="table-wrap" role="region" tabIndex={0} aria-label={title}><table className="lp-table lp-report-table"><thead><tr><th>Signal time</th><th>Symbol</th><th>Position</th><th>P&amp;L</th><th>Indicator</th><th>Parameters</th><th>Timeframe</th><th>Condition</th><th>Trigger price</th><th>Status</th></tr></thead><tbody>
      {pg.slice.length === 0 ? <tr><td colSpan={10} className="empty">{read.loading ? 'Loading…' : read.error ? 'History unavailable: ' + read.error : 'No alerts raised yet.'}</td></tr> : pg.slice.map((e) => <tr key={e.id} data-event={e.id}>
        <td title={'Raised ' + new Date(e.at).toISOString()}><DateTime ts={e.candleTime * 1000} /></td>
        <td><a className="symbol-link" href={eventLink(e)} target="_blank" rel="noopener noreferrer" title="Open the chart at this signal">{e.symbol}</a></td>
        <td>{e.positionSide ? `${e.positionSide === 'Buy' ? 'BUY' : 'SELL'} · ${e.positionOwner === 'bot' ? 'BOT' : 'External'}` : 'Market'}</td>
        <td className={e.positionPnl !== undefined ? tone(e.positionPnl) : ''}>{e.positionPnl !== undefined ? num(e.positionPnl, 4) + (e.positionLossPct !== undefined ? ` (${e.positionLossPct >= 0 ? '−' : '+'}${Math.abs(e.positionLossPct).toFixed(2)}% ${e.lossBasis === 'roi' ? 'ROI' : 'price'})` : '') : '—'}</td>
        <td>{INDICATORS[e.indicator]?.label || e.indicator}</td><td>{paramText(e)}</td><td>{timeframeLabel(e.timeframe)}</td>
        <td>{e.conditionLabel}{e.mode === 'intrabar' ? ' · intrabar (unconfirmed)' : ''}</td><td>{price(e.price)}</td>
        <td className={e.status === 'new' ? 'orange' : ''}>{e.status === 'new' ? 'New' : 'Seen'}</td>
      </tr>)}
    </tbody></table></div>
    <Pager from={pg.from} to={pg.to} total={rows.length} page={pg.page} pages={pg.pages} noun="alerts" onPage={setPage} />
  </div>;
}

/** Builder + rules + events for one scope (page or chart). */
export function AlertManager({ smart, symbol, initialDraft, eventsTitle }: { smart: boolean; symbol?: string; initialDraft?: RuleDraft | null; eventsTitle?: string }) {
  const [draft, setDraft] = useState<RuleDraft | null>(initialDraft || null);
  useEffect(() => { if (initialDraft) setDraft(initialDraft); }, [initialDraft]);
  const ruleFilter = useMemo(() => (smart ? (r: RuleRow) => r.requirePosition || r.symbol === '*' : undefined), [smart]);
  const eventFilter = useMemo(() => (smart ? (e: AlertEvent) => Boolean(e.positionId) || Boolean(e.marketWide) : undefined), [smart]);
  return <>
    <section className="section"><div className="legend">{draft?.id ? 'Edit alert' : 'New alert'}</div>
      {draft ? <AlertRuleForm initial={draft} lockSymbol={Boolean(symbol)} onDone={() => setDraft(null)} /> : <div className="lp-risk-filter"><button type="button" className="report-button" data-testid="alert-new" onClick={() => setDraft(blankRule(symbol || '', smart))}>{smart ? 'New Smart MART alert' : 'New indicator alert'}</button>{smart && !symbol && <><button type="button" className="report-button" onClick={() => setDraft({ ...blankRule('*', false, 'EMA', { period: 50 }), condition: 'price_cross_above', name: 'Market-wide EMA50 BUY', cooldownMin: 0 })}>All Bybit Futures · EMA BUY</button><button type="button" className="report-button" onClick={() => setDraft({ ...blankRule('*', false, 'EMA', { period: 50 }), condition: 'price_cross_below', name: 'Market-wide EMA50 SELL', cooldownMin: 0 })}>All Bybit Futures · EMA SELL</button></>}</div>}
    </section>
    <section className="section"><div className="legend">{smart ? 'Smart MART alerts' : 'Alerts'}</div><AlertRulesTable symbol={symbol} filter={ruleFilter} onEdit={(r) => setDraft({ ...r })} /></section>
    <section className="section"><div className="legend">History</div><AlertEventsTable symbol={symbol} filter={eventFilter} title={eventsTitle || (smart ? 'SMART MART ALERT HISTORY' : 'ALERT HISTORY')} /></section>
  </>;
}

export function alertSummary(rules: RuleRow[] | undefined, events: AlertEvent[] | undefined, smart: boolean): [string, string | number][] {
  const r = (rules || []).filter((x) => !smart || x.requirePosition || x.symbol === '*'), e = (events || []).filter((x) => !smart || x.positionId || x.marketWide);
  const day = Date.now() - 86400000;
  return [[smart ? 'Smart MART Alerts' : 'Alerts', rules ? r.length : '—'], ['Enabled', rules ? r.filter((x) => x.enabled).length : '—'], ['Raised (24h)', events ? e.filter((x) => x.at >= day).length : '—'], ['New', events ? e.filter((x) => x.status === 'new').length : '—'], ['Delivery', 'Notification only']];
}
export { describeRule };
