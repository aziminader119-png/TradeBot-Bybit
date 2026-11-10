import type { OrderIntent, StrategyConfig, StrategyCycle } from './strategy.ts';

export type PositionSide = 'Buy' | 'Sell';
export type PositionOwner = 'bot' | 'external';
export type CycleStatus = 'ACTIVE' | 'MART_TRIGGERED' | 'FROZEN' | 'CLOSED';

export interface BotPosition {
  id: string; // e.g. BTCUSDT-Buy
  symbol: string;
  side: PositionSide;
  positionIdx: 1 | 2; // 1 = Buy (Long), 2 = Sell (Short)
  owner: PositionOwner;
  size: number; // coin amount
  entryPrice: number;
  markPrice: number;
  notional: number; // USDT value = size * markPrice
  margin: number; // notional / leverage
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number; // ROE
  priceChangePct: number; // Pure underlying price change % from entry
  tpPrice: number;
  tpPct: number;
  martPrice: number;
  martPct: number;
  martTriggered: boolean;
  freezePrice: number;
  freezePct: number;
  isFrozen: boolean;
  freezeReason?: string;
  liqPrice?: number;
  distanceToTpPct?: number;
  distanceToMartPct?: number;
  distanceToFreezePct?: number;
  cycleId: string;
  cycleStartTime: number;
  updatedAt: number;
  // Set when Bybit no longer reports this position. The record is kept for review and never reopened.
  missingOnExchangeSince?: number;
  // Phase 3: PAPER positions exist only locally and are never reconciled against Bybit.
  paper?: boolean;
  // Bybit-reported position initial margin (positionIM) at the last successful sync; null when Bybit gives no
  // comparable value (e.g. portfolio margin). Display only — see src/shared/positionMargin.ts.
  exchangeMargin?: number | null;
  exchangeMarginAt?: number;
  tradeMode?: 'cross' | 'isolated' | null;
}

export interface CycleState {
  cycleId: string;
  symbol: string;
  startTime: number;
  status: CycleStatus;
  buyActive: boolean;
  sellActive: boolean;
  buyMartTriggered: boolean;
  sellMartTriggered: boolean;
  buyFrozen: boolean;
  sellFrozen: boolean;
  buyRounds: number; // how many TPs occurred on Buy
  sellRounds: number; // how many TPs occurred on Sell
  realizedProfit: number; // sum of TP profits realized in this cycle
  feesPaid: number;
  estimatedSlippage: number;
  netPnL: number; // realizedProfit - feesPaid - slippage + current unrealized
}

export interface SymbolTradingConfig {
  symbol: string;
  enabled: boolean;
  leverage: number;
  // Buy settings
  buyNotional: number; // in USDT
  buyTpPct: number; // % price move up e.g. 0.5%
  buyMartPct: number; // % price move down e.g. 1.5%
  buyMartMultiplier: number; // default 1.0 or 1.5
  buyFreezePct: number; // % price move down e.g. 5.0%
  // Sell settings
  sellNotional: number; // in USDT
  sellTpPct: number; // % price move down e.g. 0.7%
  sellMartPct: number; // % price move up e.g. 2.0%
  sellMartMultiplier: number; // default 1.0 or 1.5
  sellFreezePct: number; // % price move up e.g. 5.0%
  // Post-Mart break-even target
  breakEvenTargetUSDT: number; // e.g. 0.5 USDT net profit or 0.0 for pure break-even
  autoReopenOnTp: boolean;
  notes?: string;
}

export interface GlobalSettings {
  liveTrading: boolean; // false = paper/simulation with real live prices, true = real Bybit order execution
  environment: 'mainnet' | 'testnet';
  apiHost?: string; // Phase 4.1: official Bybit REST host of the account's entity (default api.bybit.com)
  apiKey: string;
  apiSecret: string;
  isApiKeyConfigured: boolean;
  securityPin: string; // for high-risk actions (Kill Switch, Live Armed)
  maxTotalRiskUSDT: number;
  maxDrawdownPct: number;
  maxConcurrentSymbols: number;
  emergencyStop: boolean;
  soundAlerts: boolean;
  autoReconcileIntervalSec: number;
  // Default parameters for Dashboard Quick Grid
  defaultPositionSizeLong?: number;
  defaultPositionSizeShort?: number;
  defaultTpPctLong?: number;
  defaultTpPctShort?: number;
  defaultMartSizeLong?: number;
  defaultMartSizeShort?: number;
  defaultMartPctLong?: number;
  defaultMartPctShort?: number;
  defaultFreezePctLong?: number;
  defaultFreezePctShort?: number;
  // Owner's intended management state, persisted so a restart can restore it (never written by boot code).
  // Missing = legacy record: nothing is resumed automatically until the owner resumes once.
  managementIntent?: ManagementIntent;
  // Dashboard "Risk Thresholds" + "High Margin Positions": display filters of the Deep Loss / Deep Profit pages
  // (underlying price move %, no leverage) and of the High Margin page (estimated margin, USDT). Missing values =
  // defaults (70 / 5 / 50). Never used by the trading engine.
  riskThresholds?: Partial<RiskThresholds>;
  // Aged Positions page defaults (display filter only): minimum age, optional maximum age, in hours
  agedPositions?: AgedSettings;
}

export interface RiskThresholds { deepLossPct: number; deepProfitPct: number; highMarginUsdt: number }
export interface AgedSettings { minHours: number; maxHours: number | null }
export const DEFAULT_AGED: AgedSettings = { minHours: 24, maxHours: null };
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { deepLossPct: 70, deepProfitPct: 5, highMarginUsdt: 50 };

export interface ManagementIntent {
  state: 'RUNNING' | 'PAUSED'; // RUNNING = the whole bot was managing (START / Simulation)
  mode: 'OFF' | 'SIMULATION' | 'REAL'; // real orders are restored only when this was REAL
  cycles: Record<string, 'MANAGED' | 'PAUSED'>; // per cycleId: was the bot acting on this cycle
  updatedAt: number;
  reason?: string;
}

export interface ClosedCycle {
  cycleId: string;
  symbol: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  buyRounds: number;
  sellRounds: number;
  martTriggered: boolean;
  grossProfit: number;
  fees: number;
  slippage: number;
  netProfit: number;
  exitReason: 'BREAK_EVEN' | 'TARGET_PROFIT' | 'MANUAL_CLOSE' | 'EMERGENCY_STOP';
}

export interface TradeLog {
  id: string;
  cycleId: string;
  symbol: string;
  side: PositionSide;
  action: 'OPEN_INITIAL' | 'MANUAL_OPEN' | 'TP_CLOSE' | 'TP_REOPEN' | 'MART_ADD' | 'CYCLE_CLOSE' | 'MANUAL_CLOSE' | 'TRANSFER';
  price: number;
  qty: number;
  notional: number;
  fee: number;
  pnl: number;
  timestamp: number;
  orderId: string;
  notes?: string;
}

export interface AuditLog {
  id: string;
  timestamp: number;
  symbol?: string;
  category: 'ORDER' | 'CYCLE' | 'TP' | 'MART' | 'FREEZE' | 'RECONCILE' | 'CONFIG' | 'SECURITY' | 'ERROR';
  reason: string;
  result: string;
}

export interface AlertItem {
  id: string;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  symbol?: string;
  read: boolean;
}

export interface SymbolMarketInfo {
  symbol: string;
  lastPrice: number;
  price24hPcnt: number;
  price1hPcnt?: number;
  highPrice24h: number;
  lowPrice24h: number;
  volume24h: number;
  turnover24h?: number;
  fundingRate?: number;
  tickSize: number;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  maxLeverage: number;
  fromExchange?: boolean; // Phase 3: true only for rules loaded from Bybit's instrument list
  missingRules?: string[]; // fields Bybit did not return (a default was filled in by the client); [] = all verified
}

export interface WalletInfo {
  // USDT coin balance from the same authenticated, server-cached wallet snapshot.
  // Null when Bybit has not supplied the coin; never infer it from total equity.
  usdtWalletBalance?: number | null;
  totalEquity: number;
  availableBalance: number;
  usedMargin: number;
  unrealizedPnl: number;
  totalRealizedPnl: number;
  marginRatio: number;
  mode: 'Hedge' | 'One-Way';
  status: 'CONNECTED' | 'DISCONNECTED' | 'SIMULATION';
  latencyMs: number;
  isRealBybit?: boolean;
  accountType?: string;
  errorMessage?: string;
  lastUpdated?: number;
  valuesAvailable?: boolean; // Phase 4: false = no real wallet data (show —, not 0)
  stale?: boolean; // Phase 4: last real values, connection currently failing
}

// Settings as sent to the browser / WebSocket. Never contains the API key, API secret or PIN.
export type PublicSettings = Omit<GlobalSettings, 'apiKey' | 'apiSecret' | 'securityPin' | 'riskThresholds'> & {
  riskThresholds: RiskThresholds; // always present (saved values or the defaults)
  apiKeyMasked: string; // e.g. "••••AB12", empty when no key is stored
  hasSecurityPin: boolean;
};

export interface BotStateSummary {
  wallet: WalletInfo;
  settings: PublicSettings;
  symbolsConfig: Record<string, SymbolTradingConfig>;
  positions: BotPosition[];
  activeCycles: Record<string, CycleState>;
  recentTrades: TradeLog[];
  trades: TradeLog[];
  closedCycles: ClosedCycle[];
  recentLogs: AuditLog[];
  recentAlerts: AlertItem[];
  tickers: Record<string, SymbolMarketInfo>;
  strategies?: Record<string, StrategyConfig>;
  strategyCycles?: Record<string, StrategyCycle>;
  cycleHistory?: StrategyCycle[];
  orderIntents?: OrderIntent[];
  // latest indicator / Smart MART alert events (notification only)
  indicatorAlerts?: { unseen: number; rules: number; smartRules: number; events: number; latest: import('../shared/alertRules.ts').AlertEvent[] };
  connection?: any; // Phase 4 Bybit connection status
  systemMetrics: {
    activeBotSymbolsCount: number;
    activeBotPositionsCount: number;
    frozenPositionsCount: number;
    martPositionsCount: number;
    externalPositionsCount: number;
    todayRealizedPnl: number;
    totalRealizedPnl: number;
    winRatePct: number;
    uptimeSeconds: number;
    isEngineRunning: boolean;
    tradingState: 'PAUSED' | 'RUNNING';
    tradingMode?: 'OFF' | 'SIMULATION' | 'REAL';
    managedCycleIds?: string[]; // Phase 6.2: cycles the bot is acting on right now
    lastTickTime: number;
    heapUsedMb?: number;
    ticksPerMinute?: number;
  };
}
