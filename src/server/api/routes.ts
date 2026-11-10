import path from 'node:path';
import {ClosedHistoryCache, closedAccountScope} from './closedHistoryCache.ts';
import {futuresRouter} from './futuresMarket.ts';
import {alertsRouter} from '../alerts/alertsApi.ts';
import { Router, Request, Response } from 'express';
import { BotDatabase } from '../db/database.ts';
import { TradingEngine } from '../engine/tradingEngine.ts';
import { AppWebSocketServer } from './wsServer.ts';
import { BybitClient, BYBIT_REST_HOSTS, cleanCredential } from '../bybit/bybitClient.ts';
import { DEFAULT_PUMP_SHORT, validatePumpShortSettings } from '../engine/pumpShort.ts';
import { PumpShortScanner } from '../engine/pumpShortScanner.ts';
import { PumpShortTrader } from '../engine/pumpShortTrader.ts';

export const apiRouter = Router();
apiRouter.use('/futures',futuresRouter);
apiRouter.use('/indicator-alerts',alertsRouter);

const db = BotDatabase.getInstance();
const engine = TradingEngine.getInstance();
const pumpScanner = new PumpShortScanner(engine.getClient(), db);
pumpScanner.start();
const pumpTrader = new PumpShortTrader(engine, db, pumpScanner);
pumpTrader.start();
const wsServer = AppWebSocketServer.getInstance();

// Phase 1 helpers -----------------------------------------------------------
// A PIN must be set (>= 4 chars) and match. Without a PIN, protected actions are refused.
// Phase 5: the PIN is optional. If one is set it is required for risky actions; without a PIN the
// admin login plus the explicit confirmation in the request protect them.
function checkPin(pin: unknown): { ok: true } | { ok: false; status: number; error: string } {
  const current = db.getSettings().securityPin;
  if (!current || current.length < 4) return { ok: true };
  if (typeof pin !== 'string' || pin !== current) {
    return { ok: false, status: 403, error: 'Invalid Security PIN' };
  }
  return { ok: true };
}

// Opening orders are refused while automated trading is PAUSED (the state at every boot).
function refuseIfPaused(res: Response): boolean {
  if (engine.getTradingState() !== 'RUNNING') {
    res.status(409).json({ success: false, error: 'Engine is PAUSED. No new orders are sent until you resume trading with your PIN.' });
    return true;
  }
  return false;
}

// 1. Get full state snapshot
apiRouter.get('/state', (_req: Request, res: Response) => {
  res.json(wsServer.generateSummary());
});

// 1b. Get global settings
apiRouter.get('/settings', (_req: Request, res: Response) => {
  res.json(db.getPublicSettings());
});

// Independent Pump Short configuration: save-only, never places an order.
apiRouter.get('/pump-short/settings', (_req: Request, res: Response) => {
  res.json({ settings: db.getSettings().pumpShort || { ...DEFAULT_PUMP_SHORT, positionNotionalUsdt: 30 } });
});
apiRouter.post('/pump-short/settings', (req: Request, res: Response) => {
  try {
    const settings = {
      lookbackDays: Number(req.body?.lookbackDays),
      minGrowthPct: Number(req.body?.minGrowthPct),
      retracementPct: Number(req.body?.retracementPct),
      positionNotionalUsdt: Number(req.body?.positionNotionalUsdt),
    };
    validatePumpShortSettings(settings);
    if (!Number.isFinite(settings.positionNotionalUsdt) || settings.positionNotionalUsdt <= 0)
      throw new Error('Position size must be greater than zero USDT');
    db.updateSettings({ pumpShort: settings });
    wsServer.broadcastSnapshot();
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message || 'Invalid Pump Short settings' });
  }
});
apiRouter.get('/pump-short/scan', (_req: Request, res: Response) => res.json(pumpScanner.snapshot()));
apiRouter.post('/pump-short/scan', (_req: Request, res: Response) => {
  if (!pumpScanner.snapshot().running) void pumpScanner.scan();
  res.json({ success: true, ...pumpScanner.snapshot() });
});
apiRouter.get('/pump-short/positions', (_req: Request, res: Response) => res.json(pumpTrader.snapshot()));
apiRouter.post('/pump-short/arm', (req: Request, res: Response) => {
  const pin = checkPin(req.body?.pin);
  if (!pin.ok) return res.status(pin.status).json({ success: false, error: pin.error });
  try {
    if (req.body?.enabled === false) pumpTrader.disarm();
    else pumpTrader.arm(req.body?.confirm === true);
    return res.json({ success: true, ...pumpTrader.snapshot() });
  } catch (e: any) { return res.status(409).json({ success: false, error: e.message }); }
});

// 1c. Pause / resume automated trading (always PAUSED after a restart)
apiRouter.post('/engine/pause', (_req: Request, res: Response) => {
  engine.pause('User pause from dashboard');
  wsServer.broadcastSnapshot();
  res.json({ success: true, tradingState: engine.getTradingState() });
});

apiRouter.post('/engine/resume', (req: Request, res: Response) => {
  // Kept for compatibility: resuming while real trading is armed is the same as choosing REAL mode.
  const r = setTradingMode(db.getSettings().liveTrading ? 'REAL' : 'SIMULATION', req.body || {});
  res.status(r.status).json(r.body);
});

// Phase 5: one control for the whole bot.
//   OFF        -> paused, real orders locked (always allowed, no confirmation)
//   SIMULATION -> running, real orders locked: cycles are PAPER, nothing is sent to Bybit
//   REAL       -> running with real Bybit orders: needs { confirm: true }, a working connection,
//                 a key that is not read-only, no emergency stop, and the PIN if one is set
function setTradingMode(mode: string, body: any): { status: number; body: any } {
  const ok = () => ({ status: 200, body: { success: true, mode: engine.getTradingMode(), tradingState: engine.getTradingState() } });
  if (mode === 'OFF') {
    engine.pause('Bot stopped from dashboard');
    engine.setLiveArmed(false);
    wsServer.broadcastSnapshot();
    return ok();
  }
  if (mode !== 'SIMULATION' && mode !== 'REAL') return { status: 400, body: { success: false, error: 'mode must be OFF, SIMULATION or REAL' } };
  if (db.getSettings().emergencyStop) return { status: 409, body: { success: false, error: 'Emergency stop is active. Clear it first.' } };
  if (mode === 'SIMULATION') {
    engine.setLiveArmed(false);
    engine.resume('Simulation started from dashboard (no real orders)');
    wsServer.broadcastSnapshot();
    return ok();
  }
  if (body.confirm !== true) return { status: 400, body: { success: false, error: 'Real trading needs an explicit confirmation (confirm: true).' } };
  const conn = engine.getConnection();
  if (conn.state !== 'CONNECTED') return { status: 409, body: { success: false, error: 'Connect the Bybit API first (connection is not CONNECTED).' } };
  if (conn.keyInfo?.readOnly) return { status: 409, body: { success: false, error: 'This API key is read-only on Bybit. Real trading needs a key with Contract trading (Orders/Positions) permission.' } };
  const pin = checkPin(body.pin);
  if (!pin.ok) return { status: pin.status, body: { success: false, error: pin.error } };
  engine.setLiveArmed(true);
  engine.resume('REAL trading started from dashboard (confirmed)');
  wsServer.broadcastSnapshot();
  return ok();
}

apiRouter.get('/trading/mode', (_req: Request, res: Response) => {
  res.json({ mode: engine.getTradingMode(), tradingState: engine.getTradingState(), pinRequired: Boolean(db.getSettings().securityPin && db.getSettings().securityPin.length >= 4) });
});

apiRouter.post('/trading/mode', (req: Request, res: Response) => {
  const r = setTradingMode(String(req.body?.mode || ''), req.body || {});
  res.status(r.status).json(r.body);
});

// 2. Update global settings
apiRouter.post('/settings', async (req: Request, res: Response) => {
  try {
    const {
      liveTrading,
      environment,
      apiKey,
      apiSecret,
      securityPin,
      maxTotalRiskUSDT,
      maxDrawdownPct,
      maxConcurrentSymbols,
      emergencyStop,
      soundAlerts,
    } = req.body;

    const currentSettings = db.getSettings();

    const updates: any = {};
    // Phase 2: arming live execution requires the PIN; disarming never does.
    if (liveTrading === true && !currentSettings.liveTrading) {
      const check = checkPin(req.body.pin);
      if (!check.ok) return res.status(check.status).json({ error: `Arming live trading: ${check.error}` });
      // Phase 5: explicit confirmation (no typed phrase), and only with a working connection.
      if (req.body.confirm !== true) return res.status(400).json({ error: 'Arming real trading needs an explicit confirmation (confirm: true)' });
      if (engine.getConnection().state !== 'CONNECTED') return res.status(409).json({ error: 'Arming live trading requires a working Bybit connection (check the connection status first)' });
      updates.liveTrading = true;
    } else if (liveTrading === false) {
      updates.liveTrading = false;
    }
    if (environment === 'mainnet' || environment === 'testnet') updates.environment = environment;
    if (typeof req.body.apiHost === 'string') {
      if (!BYBIT_REST_HOSTS[req.body.apiHost]) return res.status(400).json({ error: `apiHost must be one of: ${Object.keys(BYBIT_REST_HOSTS).join(', ')}` });
      updates.apiHost = req.body.apiHost;
    }
    if (apiKey === '__CLEAR__') {
      updates.apiKey = '';
      updates.apiSecret = '';
      updates.isApiKeyConfigured = false;
    } else {
      // Phase 4.1: strip spaces and invisible/bidi marks that copy-paste can add (never logged or returned)
      if (typeof apiKey === 'string' && cleanCredential(apiKey).value.length > 0) {
        updates.apiKey = cleanCredential(apiKey).value;
      }
      if (typeof apiSecret === 'string' && cleanCredential(apiSecret).value.length > 0) {
        updates.apiSecret = cleanCredential(apiSecret).value;
      }
    }
    if (typeof securityPin === 'string' && securityPin.trim().length >= 4 && securityPin.trim() !== currentSettings.securityPin) {
      if (currentSettings.securityPin && currentSettings.securityPin.length >= 4 && req.body.currentPin !== currentSettings.securityPin) {
        return res.status(403).json({ error: 'Changing the PIN requires the current PIN (currentPin).' });
      }
      updates.securityPin = securityPin.trim();
    }
    if (typeof maxTotalRiskUSDT === 'number') updates.maxTotalRiskUSDT = maxTotalRiskUSDT;
    if (typeof maxDrawdownPct === 'number') updates.maxDrawdownPct = maxDrawdownPct;
    if (typeof maxConcurrentSymbols === 'number') updates.maxConcurrentSymbols = maxConcurrentSymbols;
    // Phase 1: settings saves may engage the emergency stop but never clear it (use /emergency-resume with PIN).
    if (emergencyStop === true) updates.emergencyStop = true;
    if (typeof soundAlerts === 'boolean') updates.soundAlerts = soundAlerts;
    if (typeof req.body.defaultPositionSizeLong === 'number') updates.defaultPositionSizeLong = req.body.defaultPositionSizeLong;
    if (typeof req.body.defaultPositionSizeShort === 'number') updates.defaultPositionSizeShort = req.body.defaultPositionSizeShort;
    if (typeof req.body.defaultTpPctLong === 'number') updates.defaultTpPctLong = req.body.defaultTpPctLong;
    if (typeof req.body.defaultTpPctShort === 'number') updates.defaultTpPctShort = req.body.defaultTpPctShort;
    if (typeof req.body.defaultMartSizeLong === 'number') updates.defaultMartSizeLong = req.body.defaultMartSizeLong;
    if (typeof req.body.defaultMartSizeShort === 'number') updates.defaultMartSizeShort = req.body.defaultMartSizeShort;
    if (typeof req.body.defaultMartPctLong === 'number') updates.defaultMartPctLong = req.body.defaultMartPctLong;
    if (typeof req.body.defaultMartPctShort === 'number') updates.defaultMartPctShort = req.body.defaultMartPctShort;
    if (typeof req.body.defaultFreezePctLong === 'number') updates.defaultFreezePctLong = req.body.defaultFreezePctLong;
    if (typeof req.body.defaultFreezePctShort === 'number') updates.defaultFreezePctShort = req.body.defaultFreezePctShort;

    const newSettings = db.updateSettings(updates);
    await engine.updateApiCredentials();
    wsServer.broadcastSnapshot();

    void newSettings;
    res.json({
      success: true,
      settings: db.getPublicSettings(),
      wallet: engine.getLiveWallet(),
      connection: engine.getConnection(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update or Add Symbol Config
apiRouter.post('/symbols/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const config = req.body;
    const updated = db.setSymbolConfig(symbol, config);

    // Subscribe in WebSocket client
    engine.getWsClient().subscribe(symbol);

    // Phase 3: legacy symbol settings no longer drive the engine (see /api/strategy/:symbol).
    wsServer.broadcastSnapshot();
    res.json({ success: true, config: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete Symbol Config
apiRouter.delete('/symbols/:symbol', (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const removed = db.removeSymbolConfig(symbol);
    engine.getWsClient().unsubscribe(symbol);
    wsServer.broadcastSnapshot();
    res.json({ success: removed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Toggle Symbol Active / Pause
apiRouter.post('/symbols/:symbol/toggle', (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const current = db.getSymbolConfig(symbol);
    if (!current) {
      return res.status(404).json({ error: 'Symbol config not found' });
    }
    const updated = db.setSymbolConfig(symbol, { enabled: !current.enabled });
    wsServer.broadcastSnapshot();
    res.json({ success: true, enabled: updated.enabled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Phase 4: Bybit connection status (read-only) -----------------------------------
apiRouter.get('/bybit/status', (_req: Request, res: Response) => {
  res.json({ connection: engine.getConnection(), wallet: engine.getLiveWallet(), hosts: BYBIT_REST_HOSTS });
});

apiRouter.post('/bybit/refresh', async (_req: Request, res: Response) => {
  try {
    const connection = await engine.refreshConnection();
    let positions: any = null;
    if (connection.state === 'CONNECTED') positions = await engine.syncBybitPositions();
    wsServer.broadcastSnapshot();
    res.json({ success: connection.state === 'CONNECTED', connection: engine.getConnection(), wallet: engine.getLiveWallet(), positionsSynced: positions?.success ?? false, error: connection.error?.message });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 3 strategy routes. Amounts are MARGIN per side in USDT.
// ---------------------------------------------------------------------------
const sideOf = (v: unknown): 'Buy' | 'Sell' | null => (v === 'Buy' || v === 'Sell' ? v : null);
const fail = (res: Response, err: any, status = 400) => res.status(status).json({ success: false, error: err?.message || String(err) });

// Strategy settings (saved even when incomplete; `problems` lists what blocks a start)
apiRouter.get('/strategy/:symbol', (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const config = db.getStrategy(symbol) || null;
  res.json({ config, problems: engine.strategy.problems(config || undefined), cycle: db.getStrategyCycle(symbol) || null });
});

apiRouter.post('/strategy/:symbol', (req: Request, res: Response) => {
  try {
    const out = engine.strategy.saveStrategy({ ...req.body, symbol: req.params.symbol });
    engine.getWsClient().subscribe(out.config.symbol);
    wsServer.broadcastSnapshot();
    res.json({ success: true, ...out });
  } catch (err) { fail(res, err); }
});

// Sizing preview: no order is sent
apiRouter.get('/strategy/:symbol/quote', (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  const q = req.query as Record<string, string>;
  const cfg = db.getStrategy(symbol);
  const lev = Number(q.leverage ?? cfg?.leverage);
  const bm = Number(q.buyMargin ?? cfg?.buy.marginUsdt);
  const sm = Number(q.sellMargin ?? cfg?.sell.marginUsdt);
  const fee = q.takerFeePct !== undefined ? Number(q.takerFeePct) : cfg?.basket.takerFeePct ?? null;
  res.json(engine.strategy.quote(symbol, lev, bm, sm, fee));
});

// Start a cycle from the saved strategy (explicit user action; refused while PAUSED)
apiRouter.post('/cycle/start', async (req: Request, res: Response) => {
  if (refuseIfPaused(res)) return;
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    const adopt = { Buy: req.body?.adopt?.Buy === true, Sell: req.body?.adopt?.Sell === true };
    const cycle = await engine.strategy.startCycle(symbol, 'user', adopt);
    wsServer.broadcastSnapshot();
    res.status(cycle.status === 'ACTIVE' ? 200 : 207).json({ success: cycle.status === 'ACTIVE', cycle, error: cycle.status === 'ACTIVE' ? undefined : cycle.statusReason });
  } catch (err) { fail(res, err); }
});

// Owner decision for an INCOMPLETE / NEEDS_REVIEW cycle
apiRouter.post('/cycle/:symbol/resolve', async (req: Request, res: Response) => {
  try {
    const action = req.body?.action;
    if (action !== 'MANAGE_AS_IS' && action !== 'RELEASE_TO_EXTERNAL') return fail(res, new Error('action must be MANAGE_AS_IS or RELEASE_TO_EXTERNAL'));
    const cycle = await engine.strategy.resolve(req.params.symbol.toUpperCase(), action);
    wsServer.broadcastSnapshot();
    res.json({ success: true, cycle });
  } catch (err) { fail(res, err); }
});

// Manual management of one bot side (works while PAUSED: closes are reduce-only)
apiRouter.post('/cycle/:symbol/side/:side/close', async (req: Request, res: Response) => {
  const side = sideOf(req.params.side);
  if (!side) return fail(res, new Error('side must be Buy or Sell'));
  try {
    const r = await engine.strategy.manualCloseSide(req.params.symbol.toUpperCase(), side);
    wsServer.broadcastSnapshot();
    res.status(r.ok ? 200 : 409).json({ success: r.ok, message: r.message, error: r.ok ? undefined : r.message });
  } catch (err) { fail(res, err); }
});

apiRouter.post('/cycle/:symbol/side/:side/unfreeze', async (req: Request, res: Response) => {
  const side = sideOf(req.params.side);
  if (!side) return fail(res, new Error('side must be Buy or Sell'));
  try {
    const r = await engine.strategy.unfreeze(req.params.symbol.toUpperCase(), side);
    wsServer.broadcastSnapshot();
    res.json({ success: r.ok, message: r.message });
  } catch (err) { fail(res, err); }
});

// Position-level actions used by the position tables
apiRouter.post('/positions/:id/unfreeze', async (req: Request, res: Response) => {
  const p = db.getPosition(req.params.id);
  if (!p) return fail(res, new Error('Position not found'), 404);
  try {
    const r = await engine.strategy.unfreeze(p.symbol, p.side as 'Buy' | 'Sell');
    wsServer.broadcastSnapshot();
    res.json({ success: r.ok, message: r.message });
  } catch (err) { fail(res, err); }
});

apiRouter.post('/positions/:id/close', async (req: Request, res: Response) => {
  const p = db.getPosition(req.params.id);
  if (!p) return fail(res, new Error('Position not found'), 404);
  try {
    const c = db.getStrategyCycle(p.symbol);
    if (p.owner === 'bot' && c && c.cycleId === p.cycleId) {
      const r = await engine.strategy.manualCloseSide(p.symbol, p.side as 'Buy' | 'Sell');
      wsServer.broadcastSnapshot();
      return res.status(r.ok ? 200 : 409).json({ success: r.ok, message: r.message, error: r.ok ? undefined : r.message });
    }
    if (p.missingOnExchangeSince && !p.paper) return fail(res, new Error('Position is not on the exchange; nothing to close'), 409);
    const i = await engine.strategy.manualCloseExternal(p.id);
    wsServer.broadcastSnapshot();
    res.status(i.status === 'FILLED' ? 200 : 409).json({ success: i.status === 'FILLED', intent: i, error: i.status === 'FILLED' ? undefined : `${i.status}: ${i.error || ''}` });
  } catch (err) { fail(res, err); }
});

// Transfers never contact Bybit (existing Bybit TP orders are unchanged)
function refuseRealTransferWhenReadOnly(res: Response, ids: string[]): boolean {
  const real = ids.map((id) => db.getPosition(id)).filter((p) => p && !p.paper);
  if (real.length && !engine.getClient().isTradingEnabled()) {
    res.status(409).json({ success: false, error: 'Read-only mode: ownership of real Bybit positions cannot be changed until live trading is armed.' });
    return true;
  }
  return false;
}

apiRouter.post('/positions/:id/transfer', async (req: Request, res: Response) => {
  if (refuseRealTransferWhenReadOnly(res, [req.params.id])) return;
  const { targetOwner } = req.body || {};
  if (targetOwner !== 'bot' && targetOwner !== 'external') return fail(res, new Error('targetOwner must be bot or external'));
  try {
    const r = await engine.strategy.transfer(req.params.id, targetOwner);
    wsServer.broadcastSnapshot();
    res.status(r.ok ? 200 : 409).json({ success: r.ok, message: r.message, error: r.ok ? undefined : r.message });
  } catch (err) { fail(res, err); }
});

apiRouter.post('/positions/transfer-bulk', async (req: Request, res: Response) => {
  const { positionIds, targetOwner } = req.body || {};
  if (!Array.isArray(positionIds) || (targetOwner !== 'bot' && targetOwner !== 'external')) return fail(res, new Error('Invalid arguments'));
  if (refuseRealTransferWhenReadOnly(res, positionIds.map(String))) return;
  const results: { id: string; ok: boolean; message: string }[] = [];
  for (const id of positionIds) {
    try { results.push({ id, ...(await engine.strategy.transfer(String(id), targetOwner)) }); }
    catch (err: any) { results.push({ id, ok: false, message: err.message }); }
  }
  wsServer.broadcastSnapshot();
  res.json({ success: results.every((r) => r.ok), count: results.filter((r) => r.ok).length, results });
});

// Manual terminal order: always an EXTERNAL (not bot-managed) position; size is MARGIN
apiRouter.post('/order/create', async (req: Request, res: Response) => {
  if (refuseIfPaused(res)) return;
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    const side = sideOf(req.body?.side);
    const marginUsdt = Number(req.body?.marginUsdt);
    const leverage = Number(req.body?.leverage);
    if (!side) return fail(res, new Error('side must be Buy or Sell'));
    const i = await engine.strategy.manualExternalOpen(symbol, side, marginUsdt, leverage);
    wsServer.broadcastSnapshot();
    res.status(i.status === 'FILLED' ? 200 : 409).json({ success: i.status === 'FILLED', intent: i, error: i.status === 'FILLED' ? undefined : `${i.status}: ${i.error || ''}` });
  } catch (err) { fail(res, err); }
});

// Removed: manual "TP trigger" (closed and reopened at once) and "force restart" (opened a second pair)
apiRouter.all(['/positions/:id/tp-trigger', '/cycle/:symbol/restart'], (_req: Request, res: Response) => {
  res.status(410).json({ success: false, error: 'Removed in Phase 3. Use /api/cycle/start with saved strategy settings, or close a side.' });
});

// 11. Emergency Stop (Kill Switch)
apiRouter.post('/emergency-stop', async (req: Request, res: Response) => {
  try {
    const check = checkPin(req.body?.pin);
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    engine.pause('Emergency stop');
    db.updateSettings({ emergencyStop: true });
    db.addLog('SECURITY', 'EMERGENCY STOP', 'Closing all bot-managed positions (reduce-only)');
    const results = await engine.strategy.emergencyCloseAll();
    engine.setLiveArmed(false); // Phase 5: after the emergency closes, real orders are locked again
    wsServer.broadcastSnapshot();
    res.json({ success: true, results, message: 'Emergency stop: bot positions closed where confirmed; see results. External positions were not touched.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Reset Emergency Stop
apiRouter.post('/emergency-resume', (req: Request, res: Response) => {
  try {
    const check = checkPin(req.body?.pin);
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    // Clearing the emergency stop leaves trading PAUSED; resuming is a separate explicit step.
    db.updateSettings({ emergencyStop: false });
    db.addLog('SECURITY', 'Emergency Stop Cleared', 'Trading engine resumed by user');
    wsServer.broadcastSnapshot();
    res.json({ success: true, message: 'Emergency stop cleared' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Test Bybit Connection & Fetch Real Wallet Balance
apiRouter.post(['/bybit/test-connection', '/bybit/verify'], async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret, environment } = req.body || {};
    const settings = db.getSettings();

    let clientToTest: BybitClient;
    const isCustomKeys = Boolean(apiKey && apiSecret && apiKey !== '••••••••••••••••' && !apiKey.includes('...'));

    if (isCustomKeys) {
      clientToTest = new BybitClient(apiKey, apiSecret, environment === 'testnet', BYBIT_REST_HOSTS[req.body.apiHost] ? req.body.apiHost : settings.apiHost);
    } else {
      clientToTest = engine.getBybitClient();
    }

    const result: any = await clientToTest.testConnection();
    // Phase 4.1: exact failing request for the UI — host, path, HTTP status, retCode, retMsg (no key/secret)
    result.host = clientToTest.getHost();
    result.signMethod = clientToTest.getSignMethod();
    result.credentialNotes = clientToTest.credentialNotes;
    result.trace = clientToTest.getTrace().slice(0, 8);

    // If connection succeeded with valid keys, update live wallet and broadcast
    if (result.success && result.wallet) {
      if (!isCustomKeys) {
        await engine.syncBybitWallet();
      }
      wsServer.broadcastSnapshot();
    }

    res.json(result);
  } catch (err: any) {
    res.json({ success: false, latencyMs: 0, message: err.message || 'Connection test failed', error: err.bybit });
  }
});

// 13b. Sync Real Bybit Positions
apiRouter.post('/bybit/sync-positions', async (_req: Request, res: Response) => {
  try {
    const result = await engine.syncBybitPositions();
    wsServer.broadcastSnapshot();
    if (result.success) {
      res.json({
        success: true,
        count: result.count,
        positions: result.positions,
        message: `همگام‌سازی با بای‌بیت با موفقیت انجام شد (${result.count} پوزیشن فعال دریافت شد)`,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'خطا در همگام‌سازی پوزیشن‌ها با بای‌بیت',
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. List Available Bybit Instruments
apiRouter.get('/instruments', async (_req: Request, res: Response) => {
  try {
    const instruments = engine.getAllMarketInfo();
    res.json(instruments);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 15. Clear Alerts / Mark Read
apiRouter.post('/alerts/clear', (_req: Request, res: Response) => {
  db.clearAlerts();
  wsServer.broadcastSnapshot();
  res.json({ success: true });
});

apiRouter.post('/alerts/mark-read', (_req: Request, res: Response) => {
  db.markAlertsRead();
  wsServer.broadcastSnapshot();
  res.json({ success: true });
});

// Phase 4: full recorded trade list (bot fills + Bybit closed P&L) for the analytics pages
// Phase 4: public candles for the symbol page (read-only market data; nothing invented on failure)
const KLINE_INTERVALS = new Set(['1', '5', '15', '60', '240', 'D']);
apiRouter.get('/market/kline/:symbol', async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const interval = String((req.query as any)?.interval || '60');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol) || !KLINE_INTERVALS.has(interval)) return res.status(400).json({ error: 'invalid symbol or interval' });
  try {
    res.json({ symbol, interval, candles: await engine.getClient().getKlines(symbol, interval, 120) });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Bybit market data unavailable' });
  }
});

apiRouter.get('/trades', (req: Request, res: Response) => {
  // ?withIntents=1 (P&L Analytics only): real filled order intents, so opening fees can be matched for closes whose
  // opening trade record is older than the retained trade list. Read only.
  const fillIntents = (req.query as any)?.withIntents === '1' ? db.getIntents().filter((i) => i.mode === 'LIVE' && (i.status === 'FILLED' || i.status === 'PARTIAL') && (i.filledQty || 0) > 0)
    .map((i) => ({ orderLinkId: i.orderLinkId, orderId: i.orderId, cycleId: i.cycleId, symbol: i.symbol, side: i.side, action: i.action, filledQty: i.filledQty, avgPrice: i.avgPrice, fee: i.fee, mode: i.mode, status: i.status, updatedAt: i.updatedAt })) : undefined;
  res.json({ trades: db.getTrades(), cycleHistory: db.getCycleHistory(), legacyClosedCycles: db.getClosedCycles(), fillIntents });
});

apiRouter.get('/alerts', (_req: Request, res: Response) => {
  res.json({ alerts: db.getAlerts() });
});

// Dashboard "Risk Thresholds" (Deep Loss / Deep Profit %) and "High Margin Positions" (USDT) page filters. Settings only:
// no order, TP, cycle, leverage, arming, ownership or management change. Each value sent must be a finite number > 0
// (no 100% cap: a Short can move more than 100% against its entry); any invalid value rejects the whole save and keeps
// every saved value.
// Aged Positions page defaults (display filter only; no trading effect): minimum age and optional maximum age, hours.
apiRouter.get('/aged-settings', (_req: Request, res: Response) => { res.json({ aged: db.getAgedSettings() }); });
apiRouter.post('/aged-settings', (req: Request, res: Response) => {
  const b = req.body || {}, min = b.minHours, max = b.maxHours === '' || b.maxHours === undefined ? null : b.maxHours;
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 87600) return res.status(400).json({ success: false, error: 'Min age must be 0–87600 hours.', aged: db.getAgedSettings() });
  if (max !== null && (typeof max !== 'number' || !Number.isFinite(max) || max <= min || max > 87600)) return res.status(400).json({ success: false, error: 'Max age must be empty or greater than the min age.', aged: db.getAgedSettings() });
  const aged = db.setAgedSettings({ minHours: min, maxHours: max });
  wsServer.broadcastSnapshot();
  res.json({ success: true, aged });
});
apiRouter.get('/risk-thresholds', (_req: Request, res: Response) => {
  res.json({ thresholds: db.getRiskThresholds() });
});
apiRouter.post('/risk-thresholds', (req: Request, res: Response) => {
  const body = req.body || {};
  const cur = db.getRiskThresholds();
  const keys = ['deepLossPct', 'deepProfitPct', 'highMarginUsdt'] as const;
  const label = { deepLossPct: 'Deep Loss must be a positive percentage.', deepProfitPct: 'Deep Profit must be a positive percentage.', highMarginUsdt: 'High Margin threshold must be a positive USDT amount.' };
  if (!keys.some((k) => k in body)) return res.status(400).json({ success: false, error: 'Send deepLossPct, deepProfitPct and/or highMarginUsdt.' });
  for (const k of keys) {
    if (!(k in body)) continue;
    const v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return res.status(400).json({ success: false, error: label[k], thresholds: cur });
  }
  const pick = (k: (typeof keys)[number]) => (k in body ? body[k] : cur[k]);
  const saved = db.setRiskThresholds({ deepLossPct: pick('deepLossPct'), deepProfitPct: pick('deepProfitPct'), highMarginUsdt: pick('highMarginUsdt') });
  wsServer.broadcastSnapshot();
  res.json({ success: true, thresholds: saved });
});

// ---------------- Phase 6: hedge workflow ----------------
apiRouter.get('/hedge/settings', (_req: Request, res: Response) => {
  res.json({ settings: engine.getHedgeSettings() });
});

// Saves the dashboard settings (only the fields sent). A Buy/Sell TP % is also applied to every existing bot cycle
// (paused ones too); if a running side already meets the new TP, 409 + the affected sides, nothing saved, until
// { confirmTp: true }. Never closes/opens, resumes or arms anything by itself.
apiRouter.post('/hedge/settings', (req: Request, res: Response) => {
  try {
    const { confirmTp, ...input } = req.body || {};
    const r = engine.saveHedgeSettingsAndApplyTp(input, confirmTp === true);
    if (r.needsConfirmation) return res.status(409).json({ success: false, needsConfirmation: true, affected: r.affected, cycles: r.cycles, error: `${r.affected.length} running side(s) already meet the new TP; confirm to apply.` });
    wsServer.broadcastSnapshot();
    res.json({ success: true, settings: r.settings, tpApplied: r.tpApplied });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Read-only: sizing at the current price + a fresh position check on Bybit. Nothing is sent or saved.
apiRouter.get('/hedge/preview/:symbol', async (req: Request, res: Response) => {
  const sizing = String((req.query as any)?.sizing || 'CUSTOM').toUpperCase();
  if (sizing !== 'CUSTOM' && sizing !== 'MINIMUM') return res.status(400).json({ ok: false, blockers: ['sizing must be CUSTOM or MINIMUM'] });
  try { res.json(await engine.previewHedge(String(req.params.symbol), sizing as 'CUSTOM' | 'MINIMUM')); }
  catch (err: any) { res.status(500).json({ ok: false, blockers: [err.message] }); }
});

// Opens REAL Buy + Sell orders: only with { confirm: true } (and the PIN if one is set).
apiRouter.post('/hedge/start', async (req: Request, res: Response) => {
  const pin = checkPin(req.body?.pin);
  if (!pin.ok) return res.status(pin.status).json({ success: false, error: pin.error });
  try {
    // sizing: CUSTOM (default; the dashboard Buy/Sell values) or MINIMUM (smallest valid Bybit order per side)
    const sizing = req.body?.sizing === undefined ? 'CUSTOM' : String(req.body.sizing).toUpperCase();
    if (sizing !== 'CUSTOM' && sizing !== 'MINIMUM') return res.status(400).json({ success: false, error: 'sizing must be CUSTOM or MINIMUM' });
    const r = await engine.startHedge(String(req.body?.symbol || ''), req.body?.confirm === true, sizing);
    wsServer.broadcastSnapshot();
    res.status(r.ok ? 200 : 409).json({ success: r.ok, message: r.message, error: r.ok ? undefined : r.message, preview: r.preview, cycle: r.cycle });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full list of Bybit USDT perpetuals with live prices (no fallback symbols or prices).
apiRouter.get('/symbols', (_req: Request, res: Response) => {
  const cycles = db.getStrategyCycles();
  const pos = db.getPositions().filter((p) => !p.missingOnExchangeSince && !p.paper && p.size > 0);
  const list = Object.values(engine.getAllMarketInfo()).filter((m) => m.fromExchange).map((m) => ({
    symbol: m.symbol, lastPrice: m.lastPrice || null, change24hPct: m.lastPrice ? m.price24hPcnt : null,
    turnover24h: m.turnover24h || null, maxLeverage: m.maxLeverage, minQty: m.minQty, qtyStep: m.qtyStep, minNotional: m.minNotional,
    cycle: cycles[m.symbol] ? cycles[m.symbol].status : null,
    positions: pos.filter((p) => p.symbol === m.symbol).map((p) => ({ side: p.side, owner: p.owner, size: p.size })),
  }));
  res.json({ symbols: list, error: engine.instrumentsError, loadedAt: engine.instrumentsAt });
});

// Real closed-position history from Bybit (read-only), last `days` (max 30) in 7-day windows.
const closedHistory = new ClosedHistoryCache({
  filePath: path.resolve(process.env.TRADEBOT_DATA_DIR || 'data', 'closed-history-cache.json'),
  minRefreshMs: 60000,
  context: () => ({
    scope: closedAccountScope(db.getSettings()),
    botOrders: new Set(db.getIntents().map(i => i.orderId).filter(Boolean) as string[]),
    readPage: opts => engine.getClient().getClosedPnlPage(opts),
  }),
  onPersistenceError: () => console.warn('[History] Could not persist the read-only history cache; in-memory data is retained.'),
});
apiRouter.get('/closed-positions', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!engine.getClient().isConfigured()) return res.status(409).json({ error: 'Connect the Bybit API to load the closed-position history.' });
  const days = Math.floor(Math.min(30, Math.max(1, Number((req.query as any)?.days) || 7)));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  try { res.json(await closedHistory.read(days, cursor)); }
  catch (err: any) { res.status(502).json({ error: err.message || String(err) }); }
});

// 16. CSV Export: Logs
apiRouter.get('/export/logs-csv', (_req: Request, res: Response) => {
  const logs = db.getLogs();
  let csv = 'Timestamp,Date,Category,Symbol,Reason,Result\n';
  for (const l of logs) {
    const dateStr = new Date(l.timestamp).toISOString();
    csv += `"${l.timestamp}","${dateStr}","${l.category}","${l.symbol || ''}","${(l.reason || '').replace(/"/g, '""')}","${(l.result || '').replace(/"/g, '""')}"\n`;
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bybit_bot_audit_logs.csv"');
  res.send(csv);
});

// 17. CSV Export: Trades
apiRouter.get('/export/trades-csv', (_req: Request, res: Response) => {
  const trades = db.getTrades();
  let csv = 'TradeId,CycleId,Timestamp,Date,Symbol,Side,Action,Price,Qty,NotionalUSDT,FeeUSDT,PnLUSDT,OrderId\n';
  for (const t of trades) {
    const dateStr = new Date(t.timestamp).toISOString();
    csv += `"${t.id}","${t.cycleId}","${t.timestamp}","${dateStr}","${t.symbol}","${t.side}","${t.action}","${t.price}","${t.qty}","${t.notional}","${t.fee}","${t.pnl}","${t.orderId}"\n`;
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bybit_bot_trades.csv"');
  res.send(csv);
});

// 18. Full system reset — REMOVED in Phase 2.
// The old route market-closed every Bybit position (bot and external) and erased all history.
// It is kept only as an explicit refusal so nothing can fall through to another handler.
apiRouter.all('/system/reset-all', (_req: Request, res: Response) => {
  res.status(410).json({ success: false, error: 'Removed: full reset no longer exists. It never closes positions or erases records.' });
});


