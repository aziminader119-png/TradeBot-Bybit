import {SnapshotDelta} from '../../shared/snapshotDelta.ts';
import {visibleLog} from '../../shared/visibleLog.ts';
import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { BotDatabase } from '../db/database.ts';
import { TradingEngine } from '../engine/tradingEngine.ts';
import { BotStateSummary, WalletInfo } from '../../types/trading.ts';
import type { AuthGate } from '../security/authGate.ts';

export class AppWebSocketServer {
  private static instance: AppWebSocketServer;
  private wss: WebSocketServer | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private db: BotDatabase;
  private engine: TradingEngine;
  private gate: AuthGate | null = null;
  private sessionOf = new WeakMap<WebSocket, string>();

  private delta = new SnapshotDelta();
  // indicator / Smart MART alert summary for the notification bell (set by server.ts; no import cycle)
  private alertSummary: (() => BotStateSummary['indicatorAlerts']) | null = null;
  public setAlertSummary(fn: () => BotStateSummary['indicatorAlerts']): void { this.alertSummary = fn; }
  private compact = new WeakSet<WebSocket>();
  private sentVersion = new WeakMap<WebSocket, number>();

  private constructor() {
    this.db = BotDatabase.getInstance();
    this.engine = TradingEngine.getInstance();
  }

  public static getInstance(): AppWebSocketServer {
    if (!AppWebSocketServer.instance) {
      AppWebSocketServer.instance = new AppWebSocketServer();
    }
    return AppWebSocketServer.instance;
  }

  // Phase 2: the WebSocket only accepts upgrades that the AuthGate authorises (allowed Host, same
  // Origin, valid session cookie). Each socket is bound to its session and closed on logout/expiry.
  public attach(server: HttpServer, gate: AuthGate): void {
    this.gate = gate;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url || '/', 'http://local').pathname;
      if (pathname !== '/ws') return; // other upgrades (e.g. Vite HMR) are not ours
      const auth = gate.authorizeUpgrade(req);
      if (!auth.ok) {
        socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.sessionOf.set(ws, auth.sessionId);
        if (new URL(req.url || '/', 'http://local').searchParams.get('updates') === 'delta') this.compact.add(ws);
        this.wss!.emit('connection', ws, req);
      });
    });

    gate.setLogoutListener((sessionId) => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        if (this.sessionOf.get(client) === sessionId) client.close(4401, 'Logged out');
      }
    });

    this.wss.on('connection', (ws) => {
      if (!this.delta.version) this.delta.next(this.generateSummary() as any);
      ws.send(this.delta.full());
      this.sentVersion.set(ws, this.delta.version);
      ws.on('message', (msg) => {
        try {
          const payload = JSON.parse(msg.toString());
          if (payload.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', time: Date.now() }));
          }
        } catch {
          // ignore
        }
      });
    });

    // Start periodic state broadcast every 800ms for smooth live updates
    this.broadcastInterval = setInterval(() => {
      this.broadcastSnapshot();
    }, 800);
  }

  public broadcastSnapshot(): void {
    if (!this.wss || this.wss.clients.size === 0) return;
    const summary = this.generateSummary();
    const patch = this.delta.next(summary as any);
    const compactMessage = JSON.stringify(patch);

    for (const client of this.wss.clients) {
      const sid = this.sessionOf.get(client);
      if (!sid || !this.gate || !this.gate.isSessionValid(sid)) {
        client.close(4401, 'Session expired');
        continue;
      }
      if (client.readyState === WebSocket.OPEN) {
        // Slow browsers skip intermediate frames and receive a fresh full baseline on recovery.
        if (client.bufferedAmount > 512 * 1024) continue;
        client.send(this.compact.has(client) && this.sentVersion.get(client) === patch.baseVersion ? compactMessage : this.delta.full());
        this.sentVersion.set(client, patch.version);
      }
    }
  }

  public generateSummary(): BotStateSummary {
    const settings = this.db.getSettings();
    const positions = this.db.getPositions();
    const cycles = this.db.getCycles();
    const symbolsConfig = this.db.getSymbolsConfig();
    const closedCycles = this.db.getClosedCycles();
    const recentTrades = this.db.getTrades().slice(0, 100);
    const recentLogs = this.db.getLogs().filter(visibleLog).slice(0, 150);
    const recentAlerts = this.db.getAlerts().slice(0, 50);
    const tickers = this.engine.getAllMarketInfo();

    // Calculate aggregated metrics
    const botPositions = positions.filter((p) => p.owner === 'bot');
    const externalPositions = positions.filter((p) => p.owner === 'external');
    const frozenPositions = positions.filter((p) => p.isFrozen);
    const martPositions = positions.filter((p) => p.martTriggered);

    // Calculate PnL aggregates
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const todayTrades = recentTrades.filter((t) => t.timestamp >= oneDayAgo && t.pnl !== 0);
    const todayRealizedPnl = todayTrades.reduce((acc, t) => acc + t.pnl, 0);

    const totalRealizedPnl = recentTrades.reduce((acc, t) => acc + (t.pnl || 0), 0);
    const winTrades = recentTrades.filter((t) => (t.pnl || 0) > 0).length;
    const totalClosedTrades = recentTrades.filter((t) => t.action === 'TP_CLOSE' || t.pnl !== 0).length;
    const winRatePct = totalClosedTrades > 0 ? (winTrades / totalClosedTrades) * 100 : 100;

    // Wallet: Phase 4 — real Bybit values only. Stale values are kept and marked; with no
    // connection there are no numbers at all (never a simulated or default balance).
    const liveWallet = this.engine.getLiveWallet();
    let wallet: WalletInfo;
    if (settings.isApiKeyConfigured && liveWallet) {
      wallet = {
        usdtWalletBalance: liveWallet.coinList?.find((coin) => coin.coin === 'USDT')?.walletBalance ?? null,
        totalEquity: liveWallet.totalEquity,
        availableBalance: liveWallet.availableBalance,
        usedMargin: liveWallet.usedMargin,
        unrealizedPnl: liveWallet.unrealizedPnl,
        totalRealizedPnl,
        marginRatio: liveWallet.totalEquity > 0 ? (liveWallet.usedMargin / liveWallet.totalEquity) * 100 : 0,
        mode: 'Hedge',
        status: liveWallet.connected ? 'CONNECTED' : 'DISCONNECTED',
        latencyMs: this.engine.getLatency(),
        isRealBybit: true,
        valuesAvailable: true,
        stale: !liveWallet.connected,
        accountType: liveWallet.accountType,
        errorMessage: liveWallet.errorMessage,
        lastUpdated: liveWallet.lastUpdated,
      };
    } else {
      wallet = {
        usdtWalletBalance: null,
        totalEquity: 0, availableBalance: 0, usedMargin: 0, unrealizedPnl: 0, totalRealizedPnl, marginRatio: 0,
        mode: 'Hedge',
        status: settings.isApiKeyConfigured ? 'DISCONNECTED' : 'SIMULATION',
        latencyMs: this.engine.getLatency(),
        isRealBybit: false,
        valuesAvailable: false,
        accountType: settings.isApiKeyConfigured ? 'Not connected' : 'No API key',
        errorMessage: settings.isApiKeyConfigured ? this.engine.getConnection().error?.message : undefined,
        lastUpdated: Date.now(),
      };
    }

    // Phase 1: never send the API key, API secret or PIN to any client.
    const safeSettings = this.db.getPublicSettings();

    return {
      wallet,
      settings: safeSettings,
      symbolsConfig,
      positions,
      activeCycles: cycles,
      recentTrades,
      trades: recentTrades,
      closedCycles,
      recentLogs,
      recentAlerts,
      tickers,
      connection: this.engine.getConnection(),
      // Phase 3 strategy state
      strategies: this.db.getStrategies(),
      strategyCycles: this.db.getStrategyCycles(),
      cycleHistory: this.db.getCycleHistory().slice(0, 50),
      orderIntents: this.db.getIntents().slice(0, 50),
      indicatorAlerts: this.alertSummary ? this.alertSummary() : undefined,
      systemMetrics: {
        activeBotSymbolsCount: Object.values(symbolsConfig).filter((s) => s.enabled).length,
        activeBotPositionsCount: botPositions.length,
        frozenPositionsCount: frozenPositions.length,
        martPositionsCount: martPositions.length,
        externalPositionsCount: externalPositions.length,
        todayRealizedPnl,
        totalRealizedPnl,
        winRatePct,
        uptimeSeconds: this.engine.getUptimeSeconds(),
        isEngineRunning: this.engine.isEngineRunning(),
        tradingState: this.engine.getTradingState(),
        tradingMode: this.engine.getTradingMode(),
        managedCycleIds: this.engine.getManagedCycleIds(),
        lastTickTime: this.engine.getLastTickTime(),
        heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
      },
    };
  }

  public destroy(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

