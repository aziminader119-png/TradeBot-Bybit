import type { BotPosition, BotStateSummary } from '../../types/trading.ts';
import { isHighMargin } from '../../shared/positionMargin.ts';

export type RiskView = 'loss' | 'profit' | 'margin';
export function movePct(p: BotPosition): number | null {
  if (!Number.isFinite(p.entryPrice) || !Number.isFinite(p.markPrice) || p.entryPrice <= 0 || p.markPrice <= 0) return null;
  return (p.markPrice - p.entryPrice) / p.entryPrice * 100 * (p.side === 'Buy' ? 1 : -1);
}
export function matchesRisk(p: BotPosition, view: string, threshold: number): boolean {
  // Bybit positionIM when reported, otherwise the labelled estimate; strictly above the threshold; every owner
  if (view === 'margin') return isHighMargin(p, threshold);
  if (view !== 'loss' && view !== 'profit') return true;
  const move = movePct(p);
  if (move === null || !Number.isFinite(threshold) || threshold <= 0) return false;
  // a price exactly at the threshold counts (tolerance only absorbs floating-point noise, e.g. 6.999999999999992)
  return view === 'loss' ? move <= -threshold + 1e-9 : move >= threshold - 1e-9;
}
export function tradeRecords(state: BotStateSummary | null) {
  const intents = new Map((state?.orderIntents || []).map(i => [i.orderId, i]));
  const links = new Map((state?.orderIntents || []).map(i => [i.orderLinkId, i]));
  return (state?.trades || []).map((t, index) => {
    const link = t.notes?.match(/orderLinkId\s+(\S+)/)?.[1];
    const intent = (t.orderId ? intents.get(t.orderId) : undefined) || (link ? links.get(link) : undefined);
    const mode = intent?.mode || (/^LIVE\b/.test(t.notes || '') ? 'LIVE' : /^PAPER\b/.test(t.notes || '') ? 'PAPER' : 'LEGACY');
    return { ...t, rowKey: t.id + ':' + index, mode, orderSide: intent?.orderSide || null, intent };
  });
}
export type TriggerRow = {
  id: string; symbol: string; side: 'Buy' | 'Sell'; entry: number | null; tp: number | null;
  trigger: number | null; margin: number | null; leverage: number | null; status: string;
  direction: string; createdAt: number; orderId: string | null; parent: string | null; mode: string; note: string;
};
export function triggerRecords(state: BotStateSummary | null): TriggerRow[] {
  const rows: TriggerRow[] = [];
  const intents = state?.orderIntents || [];
  const managed = new Set(state?.systemMetrics?.managedCycleIds || []);
  const running = state?.systemMetrics?.tradingState === 'RUNNING';
  const parent = (cycleId: string, side: string, at: number) => intents.filter(i => i.cycleId === cycleId && i.side === side && i.action === 'TP_CLOSE' && i.status === 'FILLED' && i.updatedAt <= at).sort((a,b) => b.updatedAt-a.updatedAt)[0]?.orderId || null;
  for (const c of Object.values(state?.strategyCycles || {})) {
    if (c.status === 'CLOSED') continue;
    const cfg = state?.strategies?.[c.symbol];
    for (const side of ['Buy','Sell'] as const) {
      const s = c.sides[side], sc = side === 'Buy' ? cfg?.buy : cfg?.sell;
      if (!sc || sc.trigger.direction === 'DISABLED' || !['OPEN','WAIT_TRIGGER'].includes(s.phase)) continue;
      if (s.phase === 'OPEN' && !s.tpEnabled) continue;
      const isManaged = (running || managed.has(c.cycleId)) && ['ACTIVE','BASKET'].includes(c.status);
      const entry = s.avgEntryPrice && s.avgEntryPrice > 0 ? s.avgEntryPrice : null;
      const tp = s.tpEnabled && entry && sc.tpPct > 0 ? entry * (1 + (side === 'Buy' ? 1 : -1) * sc.tpPct/100) : null;
      rows.push({ id: c.cycleId + ':' + side, symbol: c.symbol, side, entry, tp,
        trigger: s.trigger?.triggerPrice || null, margin: null,
        leverage: (side === 'Buy' ? c.leverageBuy : c.leverageSell) || c.leverage || null,
        status: !['ACTIVE','BASKET'].includes(c.status) ? 'Needs review' : !isManaged ? 'Paused' : s.phase === 'WAIT_TRIGGER' ? 'Waiting reopen' : 'Pending TP',
        direction: sc.trigger.direction || '—', createdAt: s.trigger?.armedAt || c.startedAt,
        orderId: null, parent: s.phase === 'WAIT_TRIGGER' ? parent(c.cycleId,side,Date.now()) : null, mode: c.mode,
        note: c.statusReason || (s.phase === 'OPEN' ? 'Re-entry becomes eligible only after a confirmed TP close.' : s.note || '') });
    }
  }
  for (const i of intents.filter(i => i.action === 'TRIGGER_OPEN')) {
    rows.push({ id: i.orderLinkId, symbol: i.symbol, side: i.side, entry: i.avgPrice || null,
      tp: null, trigger: null, margin: null, leverage: null, status: i.status === 'FILLED' ? 'Executed' : i.status === 'REJECTED' ? 'Failed' : i.status === 'PARTIAL' || i.status === 'UNKNOWN' ? 'Needs review' : 'Pending order',
      direction: 'Re-entry order', createdAt: i.createdAt, orderId: i.orderId || null,
      parent: i.cycleId ? parent(i.cycleId,i.side,i.createdAt) : null, mode: i.mode, note: i.error || '' });
  }
  return rows.sort((a,b) => b.createdAt-a.createdAt || a.id.localeCompare(b.id));
}
