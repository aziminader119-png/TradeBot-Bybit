import fs from 'fs';
import path from 'path';
import type {
  GlobalSettings,
  PublicSettings,
  SymbolTradingConfig,
  BotPosition,
  CycleState,
  ClosedCycle,
  TradeLog,
  AuditLog,
  AlertItem,
  RiskThresholds,
  AgedSettings } from '../../types/trading.ts';
import { DEFAULT_RISK_THRESHOLDS, DEFAULT_AGED } from '../../types/trading.ts';
import type { OrderIntent, StrategyConfig, StrategyCycle } from '../../types/strategy.ts';

interface DatabaseSchema {
  settings: GlobalSettings;
  symbolsConfig: Record<string, SymbolTradingConfig>;
  positions: BotPosition[];
  cycles: Record<string, CycleState>;
  closedCycles: ClosedCycle[];
  trades: TradeLog[];
  logs: AuditLog[];
  alerts: AlertItem[];
  walletSimulation: {
    totalEquity: number;
    availableBalance: number;
    usedMargin: number;
  };
  // Phase 3 strategy state (the older `cycles` / `symbolsConfig` records are kept untouched as legacy)
  strategies: Record<string, StrategyConfig>;
  strategyCycles: Record<string, StrategyCycle>;
  cycleHistory: StrategyCycle[];
  orderIntents: OrderIntent[];
}

const DEFAULT_SETTINGS: GlobalSettings = {
  liveTrading: false, // Default to safe simulation; user arms live trading with explicit confirmation + PIN
  environment: 'mainnet',
  apiKey: '',
  apiSecret: '',
  isApiKeyConfigured: false,
  securityPin: '', // Phase 1: no default PIN. Protected actions are refused until the user sets one.
  maxTotalRiskUSDT: 5000,
  maxDrawdownPct: 15.0,
  maxConcurrentSymbols: 10,
  emergencyStop: false,
  soundAlerts: true,
  autoReconcileIntervalSec: 10,
  pumpShort: { lookbackDays: 10, minGrowthPct: 20, retracementPct: 50, positionNotionalUsdt: 30 },
  defaultPositionSizeLong: 10,
  defaultPositionSizeShort: 10,
  defaultTpPctLong: 5.0,
  defaultTpPctShort: 5.0,
  defaultMartSizeLong: 20,
  defaultMartSizeShort: 20,
  defaultMartPctLong: 80.0,
  defaultMartPctShort: 100.0,
  defaultFreezePctLong: 1000,
  defaultFreezePctShort: 1000,
};

const DEFAULT_SYMBOLS: Record<string, SymbolTradingConfig> = {
  BTCUSDT: {
    symbol: 'BTCUSDT',
    enabled: false,
    leverage: 10,
    buyNotional: 100,
    sellNotional: 100,
    buyTpPct: 0.5,
    sellTpPct: 0.7,
    buyMartPct: 1.5,
    sellMartPct: 2.0,
    buyMartMultiplier: 1.5,
    sellMartMultiplier: 1.5,
    buyFreezePct: 5.0,
    sellFreezePct: 5.0,
    breakEvenTargetUSDT: 0.5,
    autoReopenOnTp: true,
    notes: 'Major liquid pair, tight TP with safety MART',
  },
  ETHUSDT: {
    symbol: 'ETHUSDT',
    enabled: false,
    leverage: 10,
    buyNotional: 80,
    sellNotional: 80,
    buyTpPct: 0.6,
    sellTpPct: 0.8,
    buyMartPct: 1.8,
    sellMartPct: 2.2,
    buyMartMultiplier: 1.5,
    sellMartMultiplier: 1.5,
    buyFreezePct: 5.5,
    sellFreezePct: 5.5,
    breakEvenTargetUSDT: 0.5,
    autoReopenOnTp: true,
    notes: 'High volatility alt-leader',
  },
  SOLUSDT: {
    symbol: 'SOLUSDT',
    enabled: false,
    leverage: 8,
    buyNotional: 60,
    sellNotional: 60,
    buyTpPct: 0.8,
    sellTpPct: 1.0,
    buyMartPct: 2.5,
    sellMartPct: 2.8,
    buyMartMultiplier: 1.5,
    sellMartMultiplier: 1.5,
    buyFreezePct: 6.5,
    sellFreezePct: 6.5,
    breakEvenTargetUSDT: 0.8,
    autoReopenOnTp: true,
    notes: 'High beta momentum pair',
  },
  XRPUSDT: {
    symbol: 'XRPUSDT',
    enabled: false,
    leverage: 10,
    buyNotional: 50,
    sellNotional: 50,
    buyTpPct: 0.7,
    sellTpPct: 0.9,
    buyMartPct: 2.0,
    sellMartPct: 2.4,
    buyMartMultiplier: 1.5,
    sellMartMultiplier: 1.5,
    buyFreezePct: 6.0,
    sellFreezePct: 6.0,
    breakEvenTargetUSDT: 0.5,
    autoReopenOnTp: true,
    notes: 'Standard alt hedge',
  },
};

const TRADE_RETENTION = 5000; // trade records kept (newest first); nothing else is pruned

export class BotDatabase {
  private static instance: BotDatabase;
  private filePath: string;
  private data: DatabaseSchema;
  private saveTimeout: NodeJS.Timeout | null = null;
  private saveVersion = 0;
  private persistedJson: string | null = null;
  private writingAsync = false;
  private asyncDirty = false;

  private constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = path.join(dataDir, 'bot_database.json');
    this.data = this.load();
  }

  public static getInstance(): BotDatabase {
    if (!BotDatabase.instance) {
      BotDatabase.instance = new BotDatabase();
    }
    return BotDatabase.instance;
  }

  private load(): DatabaseSchema {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
          // Phase 1: never inject sample symbol configs into an existing database.
          symbolsConfig: parsed.symbolsConfig || {},
          positions: parsed.positions || [],
          cycles: parsed.cycles || {},
          closedCycles: parsed.closedCycles || [],
          trades: parsed.trades || [],
          logs: parsed.logs || [],
          alerts: parsed.alerts || [],
          walletSimulation: parsed.walletSimulation || {
            totalEquity: 10000,
            availableBalance: 10000,
            usedMargin: 0,
          },
          strategies: parsed.strategies || {},
          strategyCycles: parsed.strategyCycles || {},
          cycleHistory: parsed.cycleHistory || [],
          orderIntents: parsed.orderIntents || [],
        };
      }
    } catch (err) {
      console.error('[DB] Error loading database file, restoring defaults:', err);
    }

    return {
      settings: DEFAULT_SETTINGS,
      symbolsConfig: {}, // Phase 1: fresh installs start with no sample symbols
      positions: [],
      cycles: {},
      closedCycles: [],
      trades: [],
      logs: [
        {
          id: 'init-1',
          timestamp: Date.now(),
          category: 'CYCLE',
          reason: 'System Initialized',
          result: 'Trading bot persistent database initialized',
        },
      ],
      alerts: [
        {
          id: 'alert-init',
          timestamp: Date.now(),
          level: 'info',
          title: 'Bot Engine Ready',
          message: 'Bybit USDT Perpetual Trading Engine online. Default safe simulation mode active.',
          read: false,
        },
      ],
      walletSimulation: {
        totalEquity: 10000,
        availableBalance: 10000,
        usedMargin: 0,
      },
      strategies: {},
      strategyCycles: {},
      cycleHistory: [],
      orderIntents: [],
    };
  }

  public saveSync(): void {
    try {
      // Invalidate an in-flight background snapshot before writing critical state.
      this.saveVersion++;
      const serialized = JSON.stringify(this.data);
      if (serialized === this.persistedJson) return;
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      fs.renameSync(tempPath, this.filePath);
      this.persistedJson = serialized;
    } catch (err) {
      console.error('[DB] Failed to save database file:', err);
    }
  }

  public pruneStaleData(): void {
    const activeSymbols = new Set(this.data.positions.map((p) => p.symbol));
    // Remove cycles that have no active positions
    for (const sym of Object.keys(this.data.cycles)) {
      if (!activeSymbols.has(sym)) {
        delete this.data.cycles[sym];
      }
    }
    // Remove symbolsConfig that are not active and not in basic top list
    const allowed = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', '0GUSDT']);
    for (const sym of Object.keys(this.data.symbolsConfig)) {
      if (!activeSymbols.has(sym) && !allowed.has(sym)) {
        delete this.data.symbolsConfig[sym];
      }
    }
    this.saveSync();
  }

  public scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveInBackground();
    }, 250);
  }

  /** Coalesce routine snapshots; only the latest completed snapshot may be published. */
  private saveInBackground(): void {
    if (this.writingAsync) {
      this.asyncDirty = true;
      return;
    }
    const version = ++this.saveVersion;
    let serialized: string;
    try {
      serialized = JSON.stringify(this.data);
    } catch (err) {
      console.error('[DB] Failed to serialize background snapshot:', err);
      return;
    }
    if (serialized === this.persistedJson) return;
    this.writingAsync = true;
    const tempPath = `${this.filePath}.async-${process.pid}-${version}.tmp`;
    fs.promises.writeFile(tempPath, serialized, 'utf-8')
      .then(() => {
        // A synchronous critical save always wins over stale background writes.
        // No await separates this check from the rename.
        if (version === this.saveVersion) {
          fs.renameSync(tempPath, this.filePath);
          this.persistedJson = serialized;
        } else {
          fs.unlinkSync(tempPath);
        }
      })
      .catch((err) => {
        console.error('[DB] Background save failed:', err);
        fs.promises.unlink(tempPath).catch(() => {});
        this.asyncDirty = true;
      })
      .finally(() => {
        this.writingAsync = false;
        if (this.asyncDirty) {
          this.asyncDirty = false;
          this.scheduleSave();
        }
      });
  }

  // Settings
  public getSettings(): GlobalSettings {
    return { ...this.data.settings };
  }

  // Settings safe to send to any client: credentials and PIN are never included.
  public getPublicSettings(): PublicSettings {
    const { apiKey, apiSecret, securityPin, ...rest } = this.data.settings;
    return {
      ...rest,
      apiKeyMasked: apiKey ? `••••${apiKey.slice(-4)}` : '',
      hasSecurityPin: Boolean(securityPin && securityPin.length >= 4),
      riskThresholds: this.getRiskThresholds(),
      agedPositions: this.getAgedSettings(),
    };
  }

  /** Dashboard Deep Loss / Deep Profit / High Margin thresholds; records without them get the defaults (70 / 5 / 50). */
  public getRiskThresholds(): RiskThresholds {
    const r = this.data.settings.riskThresholds;
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    return {
      deepLossPct: ok(r?.deepLossPct) ? r!.deepLossPct! : DEFAULT_RISK_THRESHOLDS.deepLossPct,
      deepProfitPct: ok(r?.deepProfitPct) ? r!.deepProfitPct! : DEFAULT_RISK_THRESHOLDS.deepProfitPct,
      highMarginUsdt: ok(r?.highMarginUsdt) ? r!.highMarginUsdt! : DEFAULT_RISK_THRESHOLDS.highMarginUsdt,
    };
  }

  public updateSettings(partial: Partial<GlobalSettings>): GlobalSettings {
    this.data.settings = { ...this.data.settings, ...partial };
    this.data.settings.isApiKeyConfigured = Boolean(
      this.data.settings.apiKey && this.data.settings.apiSecret
    );
    this.addLog('CONFIG', 'Settings updated', `Updated keys: ${Object.keys(partial).join(', ')}`);
    this.saveImmediate();
    return this.getSettings();
  }

  /** Restart recovery: the owner's intended management state (written only by explicit pause / resume / start). */
  public setManagementIntent(intent: GlobalSettings['managementIntent']): void {
    this.data.settings = { ...this.data.settings, managementIntent: intent };
    this.saveImmediate();
  }

  /** Aged Positions page defaults (display only). */
  public getAgedSettings(): AgedSettings {
    const a = this.data.settings.agedPositions;
    const min = typeof a?.minHours === 'number' && Number.isFinite(a.minHours) && a.minHours >= 0 ? a.minHours : DEFAULT_AGED.minHours;
    const max = typeof a?.maxHours === 'number' && Number.isFinite(a.maxHours) && a.maxHours > min ? a.maxHours : null;
    return { minHours: min, maxHours: max };
  }
  public setAgedSettings(a: AgedSettings): AgedSettings {
    this.data.settings = { ...this.data.settings, agedPositions: { minHours: a.minHours, maxHours: a.maxHours } };
    this.addLog('CONFIG', 'Aged Positions settings saved', `Min age ${a.minHours} h · Max age ${a.maxHours ?? 'none'} (display filter only)`);
    this.saveImmediate();
    return this.getAgedSettings();
  }

  /** Saves all display thresholds at once (caller validates). Settings only: nothing else changes. */
  public setRiskThresholds(t: RiskThresholds): RiskThresholds {
    this.data.settings = { ...this.data.settings, riskThresholds: { deepLossPct: t.deepLossPct, deepProfitPct: t.deepProfitPct, highMarginUsdt: t.highMarginUsdt } };
    this.addLog('CONFIG', 'Risk thresholds saved', `Deep Loss ${t.deepLossPct}% · Deep Profit ${t.deepProfitPct}% · High Margin ${t.highMarginUsdt} USDT (display filters only)`);
    this.saveImmediate();
    return this.getRiskThresholds();
  }

  // Symbols Config
  public getSymbolsConfig(): Record<string, SymbolTradingConfig> {
    return { ...this.data.symbolsConfig };
  }

  public getSymbolConfig(symbol: string): SymbolTradingConfig | undefined {
    return this.data.symbolsConfig[symbol];
  }

  public setSymbolConfig(symbol: string, config: Partial<SymbolTradingConfig>): SymbolTradingConfig {
    const existing = this.data.symbolsConfig[symbol] || {
      symbol,
      enabled: true,
      leverage: 10,
      buyNotional: 100,
      sellNotional: 100,
      buyTpPct: 0.5,
      sellTpPct: 0.7,
      buyMartPct: 1.5,
      sellMartPct: 2.0,
      buyMartMultiplier: 1.5,
      sellMartMultiplier: 1.5,
      buyFreezePct: 5.0,
      sellFreezePct: 5.0,
      breakEvenTargetUSDT: 0.5,
      autoReopenOnTp: true,
    };

    this.data.symbolsConfig[symbol] = {
      ...existing,
      ...config,
      symbol,
    };

    this.addLog('CONFIG', `Symbol config updated: ${symbol}`, JSON.stringify(config));
    this.scheduleSave();
    return this.data.symbolsConfig[symbol];
  }

  public removeSymbolConfig(symbol: string): boolean {
    if (this.data.symbolsConfig[symbol]) {
      delete this.data.symbolsConfig[symbol];
      this.addLog('CONFIG', `Symbol removed: ${symbol}`, 'Config deleted');
      this.scheduleSave();
      return true;
    }
    return false;
  }

  // Positions
  public getPositions(): BotPosition[] {
    return [...this.data.positions];
  }

  public getPosition(id: string): BotPosition | undefined {
    return this.data.positions.find((p) => p.id === id);
  }

  public getPositionsBySymbol(symbol: string): BotPosition[] {
    return this.data.positions.filter((p) => p.symbol === symbol);
  }

  public savePosition(position: BotPosition): void {
    const idx = this.data.positions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.data.positions[idx] = position;
    } else {
      this.data.positions.push(position);
    }
    this.scheduleSave();
  }

  public removePosition(id: string): void {
    const before = this.data.positions.length;
    this.data.positions = this.data.positions.filter((p) => p.id !== id);
    if (this.data.positions.length !== before) {
      this.scheduleSave();
    }
  }

  public updatePositions(positions: BotPosition[]): void {
    this.data.positions = positions;
    this.scheduleSave();
  }

  // Cycles
  public getCycles(): Record<string, CycleState> {
    return { ...this.data.cycles };
  }

  public getCycle(symbol: string): CycleState | undefined {
    return this.data.cycles[symbol];
  }

  public saveCycle(cycle: CycleState): void {
    this.data.cycles[cycle.symbol] = cycle;
    this.scheduleSave();
  }

  public removeCycle(symbol: string): void {
    delete this.data.cycles[symbol];
    this.scheduleSave();
  }

  // Closed Cycles
  public getClosedCycles(): ClosedCycle[] {
    return [...this.data.closedCycles];
  }

  public addClosedCycle(cycle: ClosedCycle): void {
    this.data.closedCycles.unshift(cycle);
    if (this.data.closedCycles.length > 500) {
      this.data.closedCycles = this.data.closedCycles.slice(0, 500);
    }
    this.scheduleSave();
  }

  // Trades
  public getTrades(): TradeLog[] {
    return [...this.data.trades];
  }

  public addTrade(trade: TradeLog): void {
    this.data.trades.unshift(trade);
    // Retention: the bot's own records were cut at 1,000 together with synced Bybit closed-P&L rows, which removed the
    // opening fills of older closes (their fees could no longer be matched). Same limit as the Bybit sync now.
    if (this.data.trades.length > TRADE_RETENTION) {
      this.data.trades = this.data.trades.slice(0, TRADE_RETENTION);
    }
    this.scheduleSave();
  }

  public syncBybitTrades(trades: TradeLog[]): void {
    const existingIds = new Set(this.data.trades.map((t) => t.id));
    let hasNew = false;
    for (const t of trades) {
      if (!existingIds.has(t.id)) {
        this.data.trades.unshift(t);
        existingIds.add(t.id);
        hasNew = true;
      }
    }
    if (hasNew) {
      this.data.trades.sort((a, b) => b.timestamp - a.timestamp);
      if (this.data.trades.length > TRADE_RETENTION) {
        this.data.trades = this.data.trades.slice(0, TRADE_RETENTION);
      }
      this.scheduleSave();
    }
  }

  // Logs
  public getLogs(): AuditLog[] {
    return [...this.data.logs];
  }

  public addLog(
    category: AuditLog['category'],
    reason: string,
    result: string,
    symbol?: string
  ): void {
    const entry: AuditLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      category,
      reason,
      result,
      symbol,
    };
    this.data.logs.unshift(entry);
    if (this.data.logs.length > 2000) {
      this.data.logs = this.data.logs.slice(0, 2000);
    }
    this.scheduleSave();
  }

  // Alerts
  public getAlerts(): AlertItem[] {
    return [...this.data.alerts];
  }

  public addAlert(
    level: AlertItem['level'],
    title: string,
    message: string,
    symbol?: string
  ): void {
    const item: AlertItem = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      level,
      title,
      message,
      symbol,
      read: false,
    };
    this.data.alerts.unshift(item);
    if (this.data.alerts.length > 200) {
      this.data.alerts = this.data.alerts.slice(0, 200);
    }
    this.scheduleSave();
  }

  public markAlertsRead(): void {
    for (const a of this.data.alerts) {
      a.read = true;
    }
    this.scheduleSave();
  }

  public clearAlerts(): void {
    this.data.alerts = [];
    this.scheduleSave();
  }

  // Simulation Wallet
  public getWalletSimulation() {
    return { ...this.data.walletSimulation };
  }

  public updateWalletSimulation(partial: Partial<DatabaseSchema['walletSimulation']>) {
    this.data.walletSimulation = { ...this.data.walletSimulation, ...partial };
    this.scheduleSave();
    return this.getWalletSimulation();
  }

  // Save immediately to disk (synchronous write)
  public saveImmediate(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveSync(); // atomic: temp file + rename
  }

  // ---------- Phase 3: strategy settings, cycles and order intents ----------
  public getStrategies(): Record<string, StrategyConfig> {
    return { ...this.data.strategies };
  }

  public getStrategy(symbol: string): StrategyConfig | undefined {
    return this.data.strategies[symbol];
  }

  public setStrategy(cfg: StrategyConfig): void {
    this.data.strategies[cfg.symbol] = cfg;
    this.addLog('CONFIG', `Strategy saved: ${cfg.symbol}`, JSON.stringify(cfg), cfg.symbol);
    this.saveImmediate();
  }

  public getStrategyCycles(): Record<string, StrategyCycle> {
    return { ...this.data.strategyCycles };
  }

  public getStrategyCycle(symbol: string): StrategyCycle | undefined {
    return this.data.strategyCycles[symbol];
  }

  // Cycle state is written to disk immediately on every change (crash-safe).
  public saveStrategyCycle(c: StrategyCycle): void {
    this.data.strategyCycles[c.symbol] = c;
    this.saveImmediate();
  }

  public archiveStrategyCycle(symbol: string): void {
    const c = this.data.strategyCycles[symbol];
    if (!c) return;
    this.data.cycleHistory.unshift(c);
    delete this.data.strategyCycles[symbol];
    this.saveImmediate();
  }

  /** Only funding bookkeeping fields of a closed cycle may be updated; trades and P&L stay as recorded. */
  public updateCycleHistory(cycleId: string, patch: Pick<Partial<StrategyCycle>, 'funding' | 'fundingError' | 'fundingAt' | 'fundingCheckedAt' | 'fundingFinal'>): void {
    const h = this.data.cycleHistory.find((x) => x.cycleId === cycleId);
    if (!h) return;
    for (const k of ['funding', 'fundingError', 'fundingAt', 'fundingCheckedAt', 'fundingFinal'] as const) {
      if (k in patch) (h as any)[k] = (patch as any)[k];
    }
    this.saveImmediate();
  }

  public getCycleHistory(): StrategyCycle[] {
    return [...this.data.cycleHistory];
  }

  public getIntents(): OrderIntent[] {
    return [...this.data.orderIntents];
  }

  public saveIntent(i: OrderIntent): void {
    const idx = this.data.orderIntents.findIndex((x) => x.id === i.id);
    if (idx >= 0) this.data.orderIntents[idx] = i;
    else this.data.orderIntents.unshift(i);
    // keep unresolved intents forever; trim only resolved ones beyond 5000
    if (this.data.orderIntents.length > 5000) {
      const unresolved = this.data.orderIntents.filter((x) => x.status === 'PENDING' || x.status === 'UNKNOWN');
      const resolved = this.data.orderIntents.filter((x) => !(x.status === 'PENDING' || x.status === 'UNKNOWN')).slice(0, 5000 - unresolved.length);
      this.data.orderIntents = [...unresolved, ...resolved].sort((a, b) => b.createdAt - a.createdAt);
    }
    this.saveImmediate();
  }

  // Phase 2: resetAllData() was removed. Nothing in the app can wipe positions, cycles, trades,
  // logs or alerts.

  // Raw Export
  public exportData(): DatabaseSchema {
    return JSON.parse(JSON.stringify(this.data));
  }
}
