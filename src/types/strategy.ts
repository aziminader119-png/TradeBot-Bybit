// Phase 3 strategy model. Amounts are MARGIN in USDT per side; notional = margin × leverage.
// Every option whose meaning was not specified by the owner is an explicit choice with NO default:
// a cycle cannot start until it is set (see validateStrategy in strategyMath.ts).

export type Side = 'Buy' | 'Sell';

// How the same-side re-entry ("trigger") after a TP is measured. Needs an explicit choice.
//  - reference: which price the distance is measured from
//      TP_FILL_PRICE   = the average fill price of the TP close order
//      TP_TARGET_PRICE = the TP target price that fired the close
//  - direction:
//      PULLBACK     = Buy re-enters when price falls `distancePct` below the reference;
//                     Sell re-enters when price rises `distancePct` above it
//      CONTINUATION = Buy re-enters when price rises `distancePct` above the reference;
//                     Sell re-enters when price falls `distancePct` below it
//      DISABLED     = after TP the side stays closed for the rest of the cycle
//      IMMEDIATE    = Phase 5 default: after TP the same side is reopened right away with its own margin
export type TriggerReference = 'TP_FILL_PRICE' | 'TP_TARGET_PRICE';
export type TriggerDirection = 'PULLBACK' | 'CONTINUATION' | 'DISABLED' | 'IMMEDIATE';

export interface SideStrategy {
  marginUsdt: number; // initial margin for this side (sizing MARGIN; Phase 6 hedge cycles use notionalUsdt instead)
  notionalUsdt?: number | null; // Phase 6: position VALUE in USDT for this side (sizing NOTIONAL)
  leverage?: number | null; // Phase 6: leverage for this side (sizing NOTIONAL)
  tpPct: number; // favourable underlying price move from the side's average entry, in %
  trigger: {
    direction: TriggerDirection | null;
    reference: TriggerReference | null; // required unless direction = DISABLED
    distancePct: number | null; // required unless direction = DISABLED
  };
  mart: {
    enabled: boolean;
    triggerPct: number | null; // adverse move from the side's INITIAL entry of the current leg, in %
    marginUsdt: number | null; // margin of the single MART add
  };
  freezePct: number | null; // adverse move from the side's average entry, in %; null = no freeze
}

export interface BasketStrategy {
  targetUsdt: number | null; // close the basket when net P&L >= this
  pnlScope: 'OPEN_LEGS_ONLY' | 'CYCLE_TOTAL' | null; // Phase 4.2: only CYCLE_TOTAL is enabled; OPEN_LEGS_ONLY kept in the type for old records (refused/held)
  frozenLegs: 'INCLUDE' | 'EXCLUDE' | null; // whether frozen legs are part of the basket
  takerFeePct: number | null; // your account's taker fee, used to estimate closing fees
  slippagePct: number | null; // estimated closing slippage on open notional
  afterClose: 'STOP' | 'START_NEW_CYCLE' | null;
}

export interface StrategyConfig {
  version: 2;
  symbol: string;
  leverage: number;
  sizing?: 'MARGIN' | 'NOTIONAL'; // Phase 6: NOTIONAL = per-side position value + per-side leverage
  minSize?: boolean; // hedge "Minimum size": every open (start + TP reopen) uses the smallest valid Bybit order at that moment
  buy: SideStrategy;
  sell: SideStrategy;
  basket: BasketStrategy;
  updatedAt: number;
}

export type SidePhase =
  | 'OPENING' // open order in flight
  | 'OPEN' // position open and managed
  | 'CLOSING' // close order in flight
  | 'WAIT_TRIGGER' // closed by TP, waiting for the same-side trigger
  | 'FROZEN' // freeze threshold hit; no automated action, manual management only
  | 'CLOSED' // closed for the rest of the cycle (trigger disabled, manual close, released)
  | 'FAILED'; // an order for this side failed or partially filled; see cycle status

export interface SideState {
  phase: SidePhase;
  legNo: number; // 1 = first leg, +1 per trigger re-entry
  legEntryPrice: number | null; // first fill price of the current leg (MART is measured from this)
  avgEntryPrice: number | null; // average entry incl. MART add
  size: number; // contracts held by the bot for this side
  legFees: number; // fees paid opening the current leg (incl. MART add)
  martUsed: boolean; // the single MART of this side in this cycle has been used
  tpEnabled: boolean; // false after MART until the basket closes
  trigger: null | { referencePrice: number; triggerPrice: number; armedAt: number };
  frozenAt: number | null;
  lastTpPrice: number | null;
  note?: string;
}

export type CycleStatus =
  | 'OPENING'
  | 'ACTIVE'
  | 'BASKET' // at least one MART used: basket recovery is armed
  | 'CLOSING'
  | 'INCOMPLETE' // a side failed / partially filled: automation stopped until the owner resolves it
  | 'NEEDS_REVIEW' // unknown order outcome or exchange state mismatch: automation stopped
  | 'CLOSED';

export interface StrategyCycle {
  cycleId: string;
  symbol: string;
  mode: 'LIVE' | 'PAPER';
  status: CycleStatus;
  startedAt: number;
  endedAt?: number;
  leverage: number;
  leverageBuy?: number; // Phase 6: per-side leverage (falls back to `leverage`)
  leverageSell?: number;
  sides: Record<Side, SideState>;
  realizedPnl: number; // gross realised P&L of legs closed in this cycle
  feesPaid: number; // actual fees of every fill in this cycle (estimated in PAPER mode)
  basketNet?: number; // last computed basket net P&L
  funding?: number | null; // LIVE: funding since start (Bybit sign: negative = paid); null/undefined = unknown
  fundingError?: string; // last retrieval error; while set, funding is unknown
  fundingAt?: number; // time of the last SUCCESSFUL retrieval (covers settlements up to this moment)
  fundingCheckedAt?: number; // time of the last retrieval attempt
  fundingFinal?: boolean; // history only: funding re-read for the exact cycle window after it closed
  basketHold?: string; // why a reached basket target was not acted on (e.g. funding unknown)
  statusReason?: string;
  closeReason?: 'BASKET_TARGET' | 'ALL_SIDES_CLOSED' | 'MANUAL' | 'START_FAILED';
}

export type IntentAction = 'OPEN' | 'MART_ADD' | 'TP_CLOSE' | 'BASKET_CLOSE' | 'MANUAL_CLOSE' | 'TRIGGER_OPEN';
export type IntentStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'UNKNOWN';

// Every order is recorded BEFORE it is sent. orderLinkId makes it traceable on Bybit and lets a
// lost response be looked up instead of re-sent.
export interface OrderIntent {
  manualRequestId?: string; // idempotency of the optional manual notional interface only
  manualNotionalUsdt?: number;
  id: string;
  orderLinkId: string;
  cycleId: string | null;
  symbol: string;
  side: Side; // position side (hedge slot) the order acts on
  orderSide: Side; // Buy/Sell of the order itself
  action: IntentAction;
  reduceOnly: boolean;
  qty: number;
  mode: 'LIVE' | 'PAPER';
  status: IntentStatus;
  createdAt: number;
  updatedAt: number;
  orderId?: string;
  filledQty?: number;
  avgPrice?: number;
  fee?: number;
  error?: string;
}

export interface SizingQuote {
  ok: boolean;
  symbol: string;
  side: Side;
  marginUsdt: number;
  leverage: number;
  price: number;
  targetNotional: number;
  qty: number;
  actualNotional: number;
  estMargin: number;
  estOpenFee: number | null;
  minQty: number;
  minNotional: number;
  minMarginUsdt: number;
  notionalUsdt?: number; // Phase 6: requested position value (NOTIONAL sizing)
  minNotionalUsdt?: number; // Phase 6: smallest valid position value at this price
  error?: string;
}

