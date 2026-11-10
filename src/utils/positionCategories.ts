// Phase 4: one definition of every position category, shared by the sidebar counts and the pages.
// Thresholds were inconsistent before (page vs sidebar vs title); confirm or change them here.
import type { BotPosition } from '../types/trading.ts';

export const AGED_DAYS = 10;
export const DEEP_LOSS_PCT = -15; // price move from entry, against the position
export const DEEP_PROFIT_PCT = 5; // price move from entry, in favour of the position
export const HIGH_MARGIN_USDT = 50;

/** Whole days since the position's recorded open time; null when the open time is unknown. */
export function ageDays(p: BotPosition, now = Date.now()): number | null {
  const t = p.cycleStartTime;
  if (!t || t <= 0 || t > now) return null;
  return Math.floor((now - t) / 86400000);
}

export const CATEGORY_FILTERS: Record<string, (p: BotPosition) => boolean> = {
  aged_positions: (p) => (ageDays(p) ?? -1) >= AGED_DAYS,
  deep_loss_positions: (p) => p.priceChangePct <= DEEP_LOSS_PCT,
  deep_profit_positions: (p) => p.priceChangePct >= DEEP_PROFIT_PCT,
  high_margin_positions: (p) => p.margin >= HIGH_MARGIN_USDT,
  mart_positions: (p) => p.martTriggered,
};

export const CATEGORY_TITLES: Record<string, string> = {
  aged_positions: `Aged Positions (open ≥ ${AGED_DAYS} days; positions with unknown open time excluded)`,
  deep_loss_positions: `Deep Loss Positions (price ≤ ${DEEP_LOSS_PCT}% from entry)`,
  deep_profit_positions: `Deep Profit Positions (price ≥ +${DEEP_PROFIT_PCT}% from entry)`,
  high_margin_positions: `High Margin Positions (margin ≥ ${HIGH_MARGIN_USDT} USDT)`,
  mart_positions: 'Mart Positions',
};

export const countCategory = (positions: BotPosition[], id: string) => positions.filter(CATEGORY_FILTERS[id] || (() => true)).length;
