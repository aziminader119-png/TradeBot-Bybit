// Pure strategy math (no I/O) so every rule can be unit-tested offline.
import type { BasketStrategy, Side, SideStrategy, SizingQuote, StrategyConfig, StrategyCycle } from '../../types/strategy.ts';

export interface InstrumentRules {
  qtyStep: number;
  minQty: number;
  minNotional: number;
  maxLeverage: number;
  missing?: string[]; // rule fields Bybit did not return (not verified)
}

const decimals = (step: number): number => {
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  return (s.split('.')[1] || '').length;
};

/** Round DOWN to the instrument step, never up. */
export function floorToStep(value: number, step: number): number {
  const d = decimals(step);
  const units = Math.floor(Math.round((value / step) * 1e9) / 1e9);
  return Number((units * step).toFixed(d));
}

function ceilToStep(value: number, step: number): number {
  const d = decimals(step);
  const units = Math.ceil(Math.round((value / step) * 1e9) / 1e9);
  return Number((units * step).toFixed(d));
}

/**
 * Size one side from MARGIN. 10 USDT margin at 5x = 50 USDT target notional.
 * Quantity is rounded down to the step. If the result is below Bybit's minimum quantity or minimum
 * order value the quote is rejected with the smallest valid margin — the amount is never raised.
 */
/**
 * Phase 6: size one side from its NOTIONAL value (position value in USDT), never from margin.
 * qty = floor(notional / price, step). The amount is never split between sides and never raised:
 * below Bybit's minimum quantity / order value the quote is refused with the smallest valid value.
 */
export function quoteNotional(
  symbol: string,
  side: Side,
  notionalUsdt: number,
  leverage: number,
  price: number,
  rules: InstrumentRules,
  takerFeePct: number | null
): SizingQuote {
  const base = {
    symbol, side, marginUsdt: 0, leverage, price, notionalUsdt,
    targetNotional: notionalUsdt, qty: 0, actualNotional: 0, estMargin: 0, estOpenFee: null as number | null,
    minQty: rules.minQty, minNotional: rules.minNotional, minMarginUsdt: 0, minNotionalUsdt: 0,
  };
  const fail = (error: string, extra: Partial<SizingQuote> = {}): SizingQuote => ({ ok: false, ...base, ...extra, error });
  if (!(notionalUsdt > 0) || !Number.isFinite(notionalUsdt)) return fail('Position value must be a positive number of USDT');
  if (!(leverage >= 1) || !Number.isFinite(leverage)) return fail('Leverage must be at least 1');
  if (leverage > rules.maxLeverage) return fail(`Leverage ${leverage}x exceeds the ${symbol} maximum ${rules.maxLeverage}x`);
  if (!(price > 0)) return fail('No live price for this symbol');
  const qty = floorToStep(notionalUsdt / price, rules.qtyStep);
  const actualNotional = qty * price;
  const minValidQty = Math.max(rules.minQty, ceilToStep(rules.minNotional / price, rules.qtyStep));
  const minNotionalUsdt = Math.ceil(minValidQty * price * 10000) / 10000;
  const q = {
    qty, actualNotional, estMargin: actualNotional / leverage,
    estOpenFee: takerFeePct != null ? (actualNotional * takerFeePct) / 100 : null,
    minNotionalUsdt, minMarginUsdt: Math.ceil((minNotionalUsdt / leverage) * 10000) / 10000,
  };
  if (qty < rules.minQty) return fail(`${side} value ${notionalUsdt} USDT is too small for ${symbol}: ${qty} is below the minimum quantity ${rules.minQty}. Smallest valid value: ${minNotionalUsdt} USDT`, q);
  if (actualNotional < rules.minNotional) return fail(`${side} value ${actualNotional.toFixed(4)} USDT is below the ${symbol} minimum order value ${rules.minNotional} USDT. Smallest valid value: ${minNotionalUsdt} USDT`, q);
  return { ok: true, ...base, ...q };
}

/** Hedge "Minimum size": buffer added to Bybit's minimum order value, so a small price move before the fill does
 *  not push the order below Bybit's minimum. */
export const MIN_SIZE_BUFFER_USDT = 1;

/**
 * Hedge "Minimum size" for one side at this price:
 *   target value = Bybit minNotionalValue + MIN_SIZE_BUFFER_USDT (e.g. 5 + 1 = 6 USDT)
 *   qty          = max(minOrderQty, target / price) rounded UP to qtyStep
 * (when the minimum quantity alone is worth more than the target — e.g. BTC — the minimum quantity is used).
 * Refused (no value substituted) if any rule was not returned by Bybit, or price/leverage are not valid.
 */
export function quoteMinimum(
  symbol: string,
  side: Side,
  leverage: number,
  price: number,
  rules: InstrumentRules,
  takerFeePct: number | null
): SizingQuote {
  const base = {
    symbol, side, marginUsdt: 0, leverage, price, notionalUsdt: 0,
    targetNotional: 0, qty: 0, actualNotional: 0, estMargin: 0, estOpenFee: null as number | null,
    minQty: rules.minQty, minNotional: rules.minNotional, minMarginUsdt: 0, minNotionalUsdt: 0,
  };
  const fail = (error: string): SizingQuote => ({ ok: false, ...base, error });
  if (rules.missing && rules.missing.length) return fail(`Bybit did not return ${rules.missing.join(', ')} for ${symbol}: minimum size cannot be verified, nothing is sent`);
  if (!(rules.qtyStep > 0) || !(rules.minQty > 0) || !(rules.minNotional > 0)) return fail(`Bybit order rules for ${symbol} are not valid: minimum size cannot be verified`);
  if (!(leverage >= 1) || !Number.isFinite(leverage)) return fail('Leverage must be at least 1');
  if (leverage > rules.maxLeverage) return fail(`Leverage ${leverage}x exceeds the ${symbol} maximum ${rules.maxLeverage}x`);
  if (!(price > 0) || !Number.isFinite(price)) return fail('No live price for this symbol');
  const target = rules.minNotional + MIN_SIZE_BUFFER_USDT;
  // count whole quantity-step units once (rounding twice in floating point can add a step on large quantities)
  const units = (x: number) => { const n = x / rules.qtyStep; const r = Math.round(n); return Math.abs(n - r) <= Math.max(1e-7, 1e-13 * Math.abs(n)) ? r : Math.ceil(n); };
  const onStep = (u: number) => Number((u * rules.qtyStep).toFixed(decimals(rules.qtyStep)));
  const qty = onStep(Math.max(units(rules.minQty), units(target / price)));
  const actualNotional = qty * price;
  // Bybit's own smallest valid order value at this price (shown for reference)
  const bybitMinQty = onStep(Math.max(units(rules.minQty), units(rules.minNotional / price)));
  const minNotionalUsdt = Math.ceil(bybitMinQty * price * 10000) / 10000;
  return {
    ok: true, ...base, notionalUsdt: actualNotional, targetNotional: target, qty, actualNotional,
    estMargin: actualNotional / leverage, estOpenFee: takerFeePct != null ? (actualNotional * takerFeePct) / 100 : null,
    minNotionalUsdt, minMarginUsdt: Math.ceil((minNotionalUsdt / leverage) * 10000) / 10000,
  };
}

export function quoteSide(
  symbol: string,
  side: Side,
  marginUsdt: number,
  leverage: number,
  price: number,
  rules: InstrumentRules,
  takerFeePct: number | null
): SizingQuote {
  const base = {
    symbol, side, marginUsdt, leverage, price,
    targetNotional: 0, qty: 0, actualNotional: 0, estMargin: 0, estOpenFee: null as number | null,
    minQty: rules.minQty, minNotional: rules.minNotional, minMarginUsdt: 0,
  };
  const fail = (error: string, extra: Partial<SizingQuote> = {}): SizingQuote => ({ ok: false, ...base, ...extra, error });
  if (!(marginUsdt > 0) || !Number.isFinite(marginUsdt)) return fail('Margin must be a positive number');
  if (!(leverage >= 1) || !Number.isFinite(leverage)) return fail('Leverage must be at least 1');
  if (leverage > rules.maxLeverage) return fail(`Leverage ${leverage}x exceeds the symbol maximum ${rules.maxLeverage}x`);
  if (!(price > 0)) return fail('No live price for this symbol');

  const targetNotional = marginUsdt * leverage;
  const qty = floorToStep(targetNotional / price, rules.qtyStep);
  const actualNotional = qty * price;
  const minQtyForValue = ceilToStep(rules.minNotional / price, rules.qtyStep);
  const minValidQty = Math.max(rules.minQty, minQtyForValue);
  const minMarginUsdt = Math.ceil(((minValidQty * price) / leverage) * 100) / 100;
  const q = {
    targetNotional, qty, actualNotional,
    estMargin: actualNotional / leverage,
    estOpenFee: takerFeePct != null ? (actualNotional * takerFeePct) / 100 : null,
    minMarginUsdt,
  };
  if (qty < rules.minQty) return fail(`Quantity ${qty} is below the minimum ${rules.minQty}. Smallest valid margin at ${leverage}x: ${minMarginUsdt} USDT`, q);
  if (actualNotional < rules.minNotional) return fail(`Order value ${actualNotional.toFixed(4)} USDT is below the minimum ${rules.minNotional} USDT. Smallest valid margin at ${leverage}x: ${minMarginUsdt} USDT`, q);
  return { ok: true, ...base, ...q };
}

// Prices are floats: a move of exactly the configured % must count as reached.
const EPS = 1e-9;
/** True when a favourable/adverse move `movePct` has reached `thresholdPct`. */
export function reached(movePct: number, thresholdPct: number): boolean {
  return movePct >= thresholdPct - EPS;
}

/** Signed underlying move from `entry` to `price` in %, positive = favourable for the side. */
export function favourableMovePct(side: Side, entry: number, price: number): number {
  const raw = ((price - entry) / entry) * 100;
  return side === 'Buy' ? raw : -raw;
}

export function tpPrice(side: Side, entry: number, tpPct: number): number {
  return side === 'Buy' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
}

export function adversePrice(side: Side, entry: number, pct: number): number {
  return side === 'Buy' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
}

export function triggerPrice(side: Side, direction: 'PULLBACK' | 'CONTINUATION', reference: number, distancePct: number): number {
  const down = reference * (1 - distancePct / 100);
  const up = reference * (1 + distancePct / 100);
  if (direction === 'PULLBACK') return side === 'Buy' ? down : up;
  return side === 'Buy' ? up : down;
}

export function triggerHit(side: Side, direction: 'PULLBACK' | 'CONTINUATION', trig: number, price: number): boolean {
  const wantsLower = (direction === 'PULLBACK') === (side === 'Buy');
  const tol = Math.abs(trig) * EPS;
  return wantsLower ? price <= trig + tol : price >= trig - tol;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateSide(name: string, s: SideStrategy | undefined, notional = false, maxLeverage = Infinity): string[] {
  const e: string[] = [];
  if (!s) return [`${name}: missing settings`];
  if (notional) {
    if (!isNum(s.notionalUsdt) || s.notionalUsdt <= 0) e.push(`${name}: position value (USDT) must be > 0`);
    if (!isNum(s.leverage) || s.leverage < 1) e.push(`${name}: leverage must be at least 1`);
    else if (s.leverage > maxLeverage) e.push(`${name}: leverage ${s.leverage}x exceeds the symbol maximum ${maxLeverage}x`);
  } else if (!isNum(s.marginUsdt) || s.marginUsdt <= 0) e.push(`${name}: margin (USDT) must be > 0`);
  if (!isNum(s.tpPct) || s.tpPct <= 0) e.push(`${name}: TP % must be > 0`);
  const t = s.trigger || ({} as SideStrategy['trigger']);
  if (!t.direction) e.push(`${name}: choose what happens after TP (IMMEDIATE reopen, PULLBACK, CONTINUATION or DISABLED)`);
  else if (t.direction !== 'DISABLED' && t.direction !== 'IMMEDIATE') {
    if (!t.reference) e.push(`${name}: choose the trigger reference price (TP_FILL_PRICE or TP_TARGET_PRICE)`);
    if (!isNum(t.distancePct) || t.distancePct <= 0) e.push(`${name}: trigger distance % must be > 0`);
  }
  if (s.mart?.enabled) {
    if (!isNum(s.mart.triggerPct) || s.mart.triggerPct <= 0) e.push(`${name}: MART trigger % must be > 0`);
    if (!isNum(s.mart.marginUsdt) || s.mart.marginUsdt <= 0) e.push(`${name}: MART margin (USDT) must be > 0`);
    if (isNum(s.freezePct) && isNum(s.mart.triggerPct) && s.freezePct <= s.mart.triggerPct) e.push(`${name}: freeze % must be larger than MART trigger % or MART can never fire`);
  }
  if (s.freezePct != null && (!isNum(s.freezePct) || s.freezePct <= 0)) e.push(`${name}: freeze % must be > 0 or empty (no freeze)`);
  return e;
}

function validateBasket(b: BasketStrategy | undefined, needed: boolean): string[] {
  if (!needed) return [];
  const e: string[] = [];
  if (!b) return ['Basket: missing settings'];
  if (!isNum(b.targetUsdt)) e.push('Basket: set the recovery target (USDT net P&L, may be 0)');
  // Phase 4.2: only the whole-cycle basket is enabled. OPEN_LEGS_ONLY stays disabled until funding can be
  // attributed to individual legs (Bybit reports funding per symbol, not per leg).
  if (b.pnlScope !== 'CYCLE_TOTAL') e.push(`Basket: accounting mode ${b.pnlScope || '(none)'} is disabled; only CYCLE_TOTAL (whole cycle) is allowed`);
  if (!b.frozenLegs) e.push('Basket: choose whether frozen legs are part of the basket (INCLUDE or EXCLUDE)');
  if (!isNum(b.takerFeePct) || b.takerFeePct < 0) e.push('Basket: set your taker fee % (used to estimate closing fees)');
  if (!isNum(b.slippagePct) || b.slippagePct < 0) e.push('Basket: set the closing slippage estimate %');
  if (!b.afterClose) e.push('Basket: choose what happens after the basket closes (STOP or START_NEW_CYCLE)');
  return e;
}

/** Returns a list of problems; an empty list means the strategy can start. */
export function validateStrategy(cfg: StrategyConfig | undefined | null, maxLeverage: number): string[] {
  if (!cfg) return ['No strategy settings saved for this symbol'];
  const e: string[] = [];
  const notional = cfg.sizing === 'NOTIONAL';
  if (!notional) {
    if (!isNum(cfg.leverage) || cfg.leverage < 1) e.push('Leverage must be at least 1');
    else if (cfg.leverage > maxLeverage) e.push(`Leverage ${cfg.leverage}x exceeds the symbol maximum ${maxLeverage}x`);
  }
  e.push(...validateSide('Buy', cfg.buy, notional, maxLeverage), ...validateSide('Sell', cfg.sell, notional, maxLeverage));
  const martOn = Boolean(cfg.buy?.mart?.enabled || cfg.sell?.mart?.enabled);
  e.push(...validateBasket(cfg.basket, martOn));
  return e;
}

export interface BasketBreakdown {
  unrealized: number;
  realized: number;
  feesPaid: number;
  estCloseFees: number;
  estSlippage: number;
  /** Funding included in `net`; null when it is not known (then `net` is null too). */
  funding: number | null;
  fundingStatus: FundingStatus;
  fundingMessage?: string;
  /** Basket net excluding funding (always computable; for display only, never for decisions). */
  netExFunding: number;
  /** Decision value. null = unknown because LIVE funding is not available: never close or reopen on it. */
  net: number | null;
  legs: Side[];
}

export type FundingStatus = 'OK' | 'PENDING' | 'ERROR' | 'STALE' | 'NOT_APPLICABLE';
/** A funding value older than this is not used for a basket decision (a settlement may have happened since). */
export const FUNDING_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * LIVE funding for the cycle, never assumed. PAPER (and records without a mode) simulate no funding,
 * so funding does not apply there. Sign is Bybit's: negative = paid, positive = received.
 */
export function fundingState(cycle: Pick<StrategyCycle, 'mode' | 'funding' | 'fundingError' | 'fundingAt'>, now = Date.now()): { status: FundingStatus; value: number | null; message?: string } {
  if (cycle.mode !== 'LIVE') return { status: 'NOT_APPLICABLE', value: 0, message: 'PAPER: funding is not simulated' };
  if (cycle.fundingError) return { status: 'ERROR', value: null, message: `Funding data unavailable: ${cycle.fundingError}` };
  if (typeof cycle.funding !== 'number' || !Number.isFinite(cycle.funding) || !cycle.fundingAt) {
    return { status: 'PENDING', value: null, message: 'Funding not retrieved from Bybit yet' };
  }
  if (now - cycle.fundingAt > FUNDING_MAX_AGE_MS) {
    return { status: 'STALE', value: null, message: `Funding last retrieved ${Math.round((now - cycle.fundingAt) / 1000)} s ago (older than ${FUNDING_MAX_AGE_MS / 60000} min)` };
  }
  return { status: 'OK', value: cycle.funding };
}

/** Basket net P&L = unrealised (+ realised, by scope) − fees paid − estimated closing fees − slippage. */
export function basketNet(cycle: StrategyCycle, basket: BasketStrategy, price: number, now = Date.now()): BasketBreakdown {
  let unrealized = 0, openNotional = 0, openLegFees = 0;
  const legs: Side[] = [];
  for (const side of ['Buy', 'Sell'] as Side[]) {
    const s = cycle.sides[side];
    const counts = s.phase === 'OPEN' || (s.phase === 'FROZEN' && basket.frozenLegs === 'INCLUDE');
    if (!counts || !s.size || !s.avgEntryPrice) continue;
    legs.push(side);
    openLegFees += s.legFees || 0;
    unrealized += (side === 'Buy' ? price - s.avgEntryPrice : s.avgEntryPrice - price) * s.size;
    openNotional += s.size * price;
  }
  // Whole cycle (the only enabled mode): realised P&L of every leg closed in this cycle (both sides, from the
  // bot's own fill prices — contains no funding), unrealised P&L of open legs, actual fees of every fill,
  // estimated closing fees and slippage for the open legs, plus funding for the whole cycle (added once below).
  const realized = cycle.realizedPnl;
  const feesPaid = cycle.feesPaid;
  void openLegFees;
  const estCloseFees = (openNotional * (basket.takerFeePct || 0)) / 100;
  const estSlippage = (openNotional * (basket.slippagePct || 0)) / 100;
  const netExFunding = unrealized + realized - feesPaid - estCloseFees - estSlippage;
  // Funding is counted exactly once: realised P&L comes from the bot's own fill prices (no funding inside),
  // and funding is the cycle's Bybit settlement total since start. Unknown funding is never treated as 0.
  const f = fundingState(cycle, now);
  if (basket.pnlScope !== 'CYCLE_TOTAL') {
    // Disabled mode (e.g. a cycle started with OPEN_LEGS_ONLY before it was disabled): never decide on it.
    return {
      unrealized, realized, feesPaid, estCloseFees, estSlippage,
      funding: f.value, fundingStatus: f.status,
      fundingMessage: `Basket accounting mode ${basket.pnlScope || '(none)'} is disabled; set the basket to whole cycle (CYCLE_TOTAL)`,
      netExFunding: unrealized + realized - feesPaid - estCloseFees - estSlippage, net: null, legs,
    };
  }
  return {
    unrealized, realized, feesPaid, estCloseFees, estSlippage,
    funding: f.value, fundingStatus: f.status, fundingMessage: f.message,
    netExFunding, net: f.value === null ? null : netExFunding + f.value, legs,
  };
}
