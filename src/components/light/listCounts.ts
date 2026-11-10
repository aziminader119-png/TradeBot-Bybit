import type { AlertItem, BotPosition, BotStateSummary, RiskThresholds, TradeLog } from '../../types/trading.ts';
import type { StrategyCycle } from '../../types/strategy.ts';
import { matchesRisk, tradeRecords, triggerRecords } from './positionData.ts';

// Category rules shared by the list pages AND the sidebar counts, so a count always equals the page's default data
// (before its temporary search, side filter or pagination).

export type PositionView = 'all' | 'external' | 'latest' | 'aged' | 'loss' | 'profit' | 'margin' | 'mart';
export const AGED_DEFAULT_HOURS = 24; // default of the Aged Positions page
export const CLOSED_DEFAULT_DAYS = 7; // default period of the Closed Positions page
export const closedUrl = (days: number) => '/api/closed-positions?days=' + days;
export const TRADES_URL = '/api/trades';
export const ALERTS_URL = '/api/alerts';
export const isMartAlert = (a: AlertItem) => /\bmart\b|martingale/i.test(a.title + ' ' + a.message);

/** Dashboard-saved display thresholds from the live snapshot (undefined on an older server: nothing is guessed). */
export function savedThresholds(state: BotStateSummary | null): Partial<RiskThresholds> | undefined {
  return (state?.settings as any)?.riskThresholds;
}

/** Threshold used by a position view: the Dashboard value, or NaN (matches nothing) when it is not available. */
export function viewThreshold(view: PositionView, t: Partial<RiskThresholds> | undefined): number {
  const v = view === 'loss' ? t?.deepLossPct : view === 'profit' ? t?.deepProfitPct : view === 'margin' ? t?.highMarginUsdt : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : NaN;
}

/** Does a synced position belong to a position page's category? */
export function inPositionView(p: BotPosition, view: PositionView, ctx: { cycles: Record<string, StrategyCycle>; thresholds: Partial<RiskThresholds> | undefined; now: number; minHours?: number; maxHours?: number | null; aged?: { minHours: number; maxHours: number | null } }): boolean {
  if (view === 'external') return p.owner === 'external';
  if (view === 'mart') return p.owner === 'bot' && Boolean(p.martTriggered || (ctx.cycles[p.symbol]?.cycleId === p.cycleId && ctx.cycles[p.symbol]?.sides?.[p.side]?.martUsed));
  if (view === 'loss' || view === 'profit' || view === 'margin') return matchesRisk(p, view, viewThreshold(view, ctx.thresholds));
  if (view === 'aged') {
    // page value, else the Dashboard-saved default (Aged Positions Settings), else 24 h; optional maximum age
    const h = ctx.minHours ?? ctx.aged?.minHours ?? AGED_DEFAULT_HOURS;
    const max = ctx.maxHours !== undefined ? ctx.maxHours : ctx.aged?.maxHours ?? null;
    const ageMs = ctx.now - p.cycleStartTime;
    return Number.isFinite(p.cycleStartTime) && p.cycleStartTime > 0 && ageMs >= h * 3600000 && (max === null || ageMs <= max * 3600000);
  }
  return true; // all, latest
}

/** Trade History default scope: real (LIVE) executions only; Simulation and unverified legacy records excluded. */
export function liveTradeRecords(state: BotStateSummary | null, trades: TradeLog[]) {
  return tradeRecords(state ? { ...state, trades } : null).filter((t) => t.mode === 'LIVE');
}

/** Trigger Orders default scope: real (LIVE) cycles / re-entry orders. */
export function liveTriggerRecords(state: BotStateSummary | null) {
  return triggerRecords(state).filter((t) => t.mode === 'LIVE');
}
