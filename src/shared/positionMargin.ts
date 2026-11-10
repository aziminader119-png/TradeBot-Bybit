// One margin model for every position page, the sidebar counts and alerts (display only; trading never reads it).
//   exchange : Bybit-reported position initial margin (`positionIM`) from the last successful position sync.
//   estimate : position value / leverage — shown and labelled as an estimate, never as a Bybit value.
//   unavailable : neither is known.
// Portfolio-margin accounts have no comparable per-position margin, so their positions are always estimates.
export type MarginSource = 'exchange' | 'estimate' | 'unavailable';
export type MarginInfo = { value: number | null; source: MarginSource; at: number | null };
type MarginFields = { exchangeMargin?: number | null; exchangeMarginAt?: number | null; notional?: number; leverage?: number; margin?: number };

export function exchangeMarginOf(positionIM: unknown, accountMarginMode: string | null | undefined): number | null {
  if (accountMarginMode === 'PORTFOLIO_MARGIN') return null;
  const v = typeof positionIM === 'string' && positionIM.trim() !== '' ? Number(positionIM) : typeof positionIM === 'number' ? positionIM : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function positionMargin(p: MarginFields): MarginInfo {
  if (typeof p.exchangeMargin === 'number' && Number.isFinite(p.exchangeMargin) && p.exchangeMargin > 0) return { value: p.exchangeMargin, source: 'exchange', at: p.exchangeMarginAt ?? null };
  if (typeof p.notional === 'number' && typeof p.leverage === 'number' && Number.isFinite(p.notional) && Number.isFinite(p.leverage) && p.notional > 0 && p.leverage > 0) return { value: p.notional / p.leverage, source: 'estimate', at: null };
  // the bot's stored estimate (value / leverage, refreshed on every price tick) when value or leverage is not on the record
  if (typeof p.margin === 'number' && Number.isFinite(p.margin) && p.margin > 0) return { value: p.margin, source: 'estimate', at: null };
  return { value: null, source: 'unavailable', at: null };
}

/** High Margin rule: strictly ABOVE the threshold (a margin exactly equal to it is excluded). Each side is its own position. */
export function isHighMargin(p: MarginFields, threshold: number): boolean {
  const m = positionMargin(p);
  return Number.isFinite(threshold) && threshold > 0 && m.value !== null && m.value > threshold;
}

/** Position snapshot age: stale when the last successful Bybit position sync is older than this (sync runs every 10 s). */
export const POSITION_SYNC_STALE_MS = 60000;
export function syncAge(syncedAt: number | null | undefined, now: number): { at: number | null; stale: boolean } {
  if (!syncedAt) return { at: null, stale: true };
  return { at: syncedAt, stale: now - syncedAt > POSITION_SYNC_STALE_MS };
}
