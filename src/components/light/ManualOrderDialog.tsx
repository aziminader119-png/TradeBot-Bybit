import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LightModal, postJson } from './Modal.tsx';
import { num, price } from './table.tsx';

type Side = 'Buy' | 'Sell';
type Props = { symbol: string; side: Side; initialValue?: number; enabled: boolean; onClose: () => void; onDone?: () => void };
type Instrument = { qtyStep: number | null; minQty: number | null; minNotional: number | null; maxLeverage: number | null };
const up = (value: number, step: number) => Math.ceil((value / step) - 1e-9) * step;

/** Shared read-only quote -> explicit REAL order confirmation for a single external position. */
export function ManualOrderDialog({ symbol, side, initialValue, enabled, onClose, onDone }: Props) {
  const [mode, setMode] = useState<'value' | 'qty'>('value');
  const [input, setInput] = useState(String(initialValue && initialValue > 0 ? initialValue : 10));
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState('');
  const sent = useRef(false);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    let current = true;
    setInstrument(null); setLivePrice(null); setQuote(null); setError('');
    Promise.all([
      fetch('/api/futures/instrument/' + encodeURIComponent(symbol), { cache: 'no-store' }).then(async r => { const d = await r.json(); if (!r.ok) throw Error(d.error || 'Instrument unavailable'); return d.instrument as Instrument; }),
      fetch('/api/futures/market-price/' + encodeURIComponent(symbol), { cache: 'no-store' }).then(async r => { const d = await r.json(); if (!r.ok) throw Error(d.error || 'Price unavailable'); return Number(d.price); }),
    ]).then(([rules, last]) => { if (current) { setInstrument(rules); setLivePrice(last); } })
      .catch(e => { if (current) setError(e.message || 'Exchange rules unavailable'); });
    return () => { current = false; };
  }, [symbol]);

  const minQty = useMemo(() => {
    const step = Number(instrument?.qtyStep), min = Number(instrument?.minQty), notional = Number(instrument?.minNotional);
    if (!(step > 0 && min > 0 && notional > 0 && livePrice && livePrice > 0)) return null;
    return Number(up(Math.max(min, notional / livePrice), step).toPrecision(12));
  }, [instrument, livePrice]);
  const minValue = minQty && livePrice ? Math.ceil(minQty * livePrice * 1e6) / 1e6 : null;
  const value = Number(input);
  const notional = mode === 'qty' ? value * (livePrice || 0) : value;
  const valid = Number.isFinite(value) && value > 0 && Number.isFinite(notional) && notional > 0;

  // A server quote is always required before the REAL confirm action appears.
  useEffect(() => {
    setQuote(null); setError('');
    if (!valid || !instrument || !livePrice || sent.current) return;
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch('/api/futures/preview/' + encodeURIComponent(symbol) + '?' + new URLSearchParams({ side, value: String(notional) }), { cache: 'no-store' })
        .then(async r => { const d = await r.json(); if (!r.ok) throw Error(d.error || 'Quote rejected'); return d; })
        .then(d => { if (current) setQuote(d); })
        .catch(e => { if (current) setError(e.message || 'Quote rejected'); })
        .finally(() => { if (current) setLoading(false); });
    }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [symbol, side, mode, notional, valid, instrument, livePrice]);

  const chooseMinimum = () => {
    if (minQty === null || minValue === null) return;
    // Small rounding allowance protects notional-mode conversion from a floating-point floor.
    setInput(String(mode === 'qty' ? minQty : Number((minValue + Math.max(1e-6, minValue * 0.0001)).toPrecision(12))));
  };
  const confirm = async () => {
    if (!quote || sending || sent.current || !enabled || !valid) return;
    sent.current = true; setSending(true); setError('');
    try {
      const response = await postJson('/api/futures/order', { symbol, side, value: quote.notionalUsdt, requestId: requestId.current, confirm: true });
      if (!response.ok) throw Error(response.data?.error || 'Order outcome uncertain. Check Trade History before retrying.');
      setDone('Bybit confirmed the order. Check All Positions for the updated position.');
      onDone?.();
    } catch (e: any) {
      setError((e.message || 'Order outcome unknown') + ' This request will not be repeated.');
    } finally { setSending(false); }
  };
  const rows: [string, React.ReactNode][] = [
    ['Order Price', quote ? price(quote.price) + ' (Last Traded)' : '—'],
    ['Qty', quote?.quote?.qty ?? '—'],
    ['Order Cost', quote ? num(quote.quote.estMargin, 6) + ' USDT' : '—'],
    ['Order Value', quote ? num(quote.quote.actualNotional, 6) + ' USDT' : '—'],
    ['Estimated Liq. Price', '—'],
    ['Leverage', quote ? 'Cross / ' + quote.leverage + 'x max' : '—'],
    ['Time in Force', 'Immediate-Or-Cancel'],
    ['Opening Fee (estimated)', quote ? num(quote.quote.estOpenFee, 6) + ' USDT' : '—'],
  ];
  return <LightModal open title={'Market ' + (side === 'Buy' ? 'Buy ' : 'Short ') + symbol} busy={sending} error={error}
    onClose={onClose} onConfirm={quote && enabled && !done && !sent.current ? () => void confirm() : undefined}
    confirmLabel={side === 'Buy' ? 'Confirm BUY' : 'Confirm SHORT'} testid="manual-futures-confirmation">
    <div className="manual-order-inputs">
      <div className="manual-order-toggle" role="group" aria-label="Order amount units"><button type="button" className={mode === 'value' ? 'active' : ''} disabled={sending} onClick={() => { setMode('value'); setInput(''); }}>Value (USDT)</button><button type="button" className={mode === 'qty' ? 'active' : ''} disabled={sending} onClick={() => { setMode('qty'); setInput(''); }}>Quantity</button></div>
      <label>{mode === 'value' ? 'Position Value (USDT)' : 'Order Quantity (' + symbol.replace(/USDT$/, '') + ')'}<input type="number" min="0" step="any" value={input} disabled={sending || Boolean(done)} onChange={e => setInput(e.target.value)} /></label>
      <button type="button" className="manual-minimum" disabled={minQty === null || Boolean(done)} onClick={chooseMinimum}>Use smallest valid order</button>
      <small>Bybit minimum: {minQty ?? '—'} {symbol.replace(/USDT$/, '')} · approximately {minValue === null ? '—' : num(minValue, 6)} USDT. The server checks a fresh price and lot size again.</small>
    </div>
    <div className="manual-order-summary">{rows.map(([label, output]) => <div key={label}><span>{label}</span><strong>{output}</strong></div>)}</div>
    <p className="ft-muted">{loading ? 'Checking order with Bybit…' : 'Single external position. No Pump or BOT strategy is automatically enabled.'}</p>
    {!enabled && <p className="red">REAL trading is not enabled. Review only; no order can be sent.</p>}
    {done && <p className="green" role="status">{done}</p>}
  </LightModal>;
}
