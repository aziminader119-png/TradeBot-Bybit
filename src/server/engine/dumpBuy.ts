import type { PumpCandle } from './pumpShort.ts';

export interface DumpCandidate {
  symbol: string;
  peak: number;
  trough: number;
  lastPrice: number;
  dropPct: number;
  peakAt: number;
  excludedBuy: boolean;
}

/** BUY exit is the configured recovery from actual entry toward the pre-dump peak. */
export function dumpBuyEntryTarget(entryPrice:number,peak:number,recoveryPct=50):number {
  if(!(entryPrice>0&&peak>entryPrice&&recoveryPct>0&&recoveryPct<=100))throw Error('Invalid Dump BUY recovery target');
  return entryPrice+(peak-entryPrice)*recoveryPct/100;
}

/** Highest earlier candle HIGH followed by a later LOW, with current price still down
 * at least minDropPct from that high. Same-candle high/low ordering is not assumed. */
export function findDump(candles: readonly PumpCandle[], now: number, days: number, minDropPct: number, lastPrice: number) {
  if (!(Number.isInteger(days) && days >= 1 && days <= 365 && minDropPct > 0 && minDropPct < 100 && lastPrice > 0)) return null;
  const rows = candles.filter(c => c.t >= now - days * 86400000 && c.t <= now && Number.isFinite(c.h) && Number.isFinite(c.l) && c.h >= c.l && c.l > 0).sort((a,b) => a.t-b.t);
  if (rows.length < 2) return null;
  let high = rows[0].h, highAt = rows[0].t, best: { peak: number; trough: number; peakAt: number; dropPct: number } | null = null;
  for (let i=1;i<rows.length;i++) {
    const c=rows[i];
    const dropPct=(high-c.l)/high*100;
    if (dropPct >= minDropPct && (!best || dropPct > best.dropPct)) best={peak:high,trough:c.l,peakAt:highAt,dropPct};
    if (c.h > high) { high=c.h; highAt=c.t; }
  }
  // Never advertise a historical crash that has already recovered.
  if (!best || (best.peak-lastPrice)/best.peak*100 < minDropPct) return null;
  return { ...best, dropPct: (best.peak-lastPrice)/best.peak*100 };
}
