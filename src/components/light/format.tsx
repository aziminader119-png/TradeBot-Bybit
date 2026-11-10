import {SymbolLink} from './SymbolLink.tsx';
import React from 'react';
import { dateTimeParts, formatCount, leverageText, positionSide } from './formatCore.ts';
export { dateTimeParts, formatCount, leverageText, positionSide };

// Shared display formatting for the whole UI: two-line timestamps, symbol / leverage / position side, liquidation
// prices and sidebar list counts. Display only: values are formatted from the original data, never stored.

export const BUY_COLOR = '#39AA77';
export const SHORT_COLOR = '#ED4F5D';
export const LIQ_COLOR = '#DDA052';

/** Plain-text version (for tooltips): date and time on two lines, or "—". */
export const dateTimeText = (ts: unknown, utc = false) => { const p = dateTimeParts(ts, utc); return p ? `${p.date}\n${p.time}` : '—'; };

/** The one timestamp component: date on the first line, time on the second; "—" when missing or invalid. */
export const DateTime: React.FC<{ ts: unknown; utc?: boolean }> = ({ ts, utc }) => {
  const p = dateTimeParts(ts, utc);
  if (!p) return <>—</>;
  return <span className="dt" data-ts={String(ts)}><span className="dt-d">{p.date}</span><span className="dt-t">{p.time}</span></span>;
};

export const SideLabel: React.FC<{ side: unknown }> = ({ side }) => {
  const k = positionSide(side);
  return k ? <span className={k === 'BUY' ? 'pos-buy' : 'pos-short'}>{k}</span> : <>—</>;
};

/** AKEUSDT on the first line; "25x SHORT" (or "25x BUY") on the second, fully in the position-side colour. */
export const SymbolSide: React.FC<{ symbol: string; leverage: unknown; side: unknown }> = ({ symbol, leverage, side }) => {
  const k = positionSide(side);
  return (
    <span className="sym-side">
      <SymbolLink symbol={symbol} className="sym-full symbol-nav-link">{symbol || '—'}</SymbolLink>
      <span className={`sym-lev ${k === 'BUY' ? 'pos-buy' : k === 'SHORT' ? 'pos-short' : ''}`}>{leverageText(leverage)} {k ?? '—'}</span>
    </span>
  );
};

/** Liquidation price in orange; missing stays "—". */
export const Liq: React.FC<{ value: unknown; fmt: (v: number) => string }> = ({ value, fmt }) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? <span className="liq">{fmt(value)}</span> : <>—</>;



