// Wiring of the one alert service: data sources (shared candle cache, synced positions, existing notification list)
// and the /api/indicator-alerts routes. All routes sit behind the AuthGate (session + CSRF for changes).
import path from 'node:path';
import { Router } from 'express';
import { AlertService } from './alertService.ts';
import { BotDatabase } from '../db/database.ts';
import { TradingEngine } from '../engine/tradingEngine.ts';
import { candleCache } from '../api/futuresMarket.ts';
import { INDICATORS } from '../../shared/indicators.ts';
import { ALERT_TIMEFRAMES, CONDITIONS } from '../../shared/alertRules.ts';

let service: AlertService | null = null;
export function alertService(): AlertService {
  if (service) return service;
  const db = BotDatabase.getInstance(), engine = TradingEngine.getInstance();
  service = new AlertService({
    file: path.resolve(process.cwd(), 'data', 'indicator_alerts.json'),
    // the same bounded closed-candle cache the chart uses (one tail read per closed candle, no extra sockets)
    history: (symbol, interval, limit) => candleCache.history(engine.getClient().getHost(), symbol, interval, limit),
    positions: () => {
      const c = engine.getConnection();
      return { list: c.state === 'CONNECTED' ? db.getPositions() as any : [], syncedAt: c.state === 'CONNECTED' ? c.positionsSyncedAt : null };
    },
    notify: (title, message, symbol) => db.addAlert('warning', title, message, symbol),
    log: (m) => console.warn(m),
  });
  return service;
}

export const alertsRouter = Router();
const fail = (res: any, e: any, status = 400) => res.status(status).json({ success: false, error: e?.message || String(e) });
alertsRouter.get('/catalog', (_req, res) => {
  res.json({ indicators: Object.values(INDICATORS), timeframes: ALERT_TIMEFRAMES, conditions: Object.fromEntries(Object.entries(CONDITIONS).map(([k, list]) => [k, list.map(([s]) => s)])) });
});
alertsRouter.get('/', (_req, res) => { const s = alertService(); res.json({ rules: s.rules(), unseen: s.unseen() }); });
alertsRouter.get('/history', (req, res) => {
  const q: any = req.query || {};
  res.json({ events: alertService().history({ symbol: q.symbol ? String(q.symbol).toUpperCase() : undefined, ruleId: q.ruleId ? String(q.ruleId) : undefined, limit: Number(q.limit) || 500 }) });
});
alertsRouter.post('/', (req, res) => { try { res.json({ success: true, rule: alertService().create(req.body) }); } catch (e) { fail(res, e); } });
alertsRouter.post('/history/seen', (req, res) => { const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : 'all'; res.json({ success: true, count: alertService().markSeen(ids) }); });
alertsRouter.post('/:id', (req, res) => { try { res.json({ success: true, rule: alertService().update(String(req.params.id), req.body) }); } catch (e: any) { fail(res, e, /not found/i.test(e.message) ? 404 : 400); } });
alertsRouter.post('/:id/enabled', (req, res) => { try { res.json({ success: true, rule: alertService().setEnabled(String(req.params.id), Boolean(req.body?.enabled)) }); } catch (e: any) { fail(res, e, 404); } });
alertsRouter.delete('/:id', (req, res) => { const ok = alertService().remove(String(req.params.id)); res.status(ok ? 200 : 404).json({ success: ok }); });
