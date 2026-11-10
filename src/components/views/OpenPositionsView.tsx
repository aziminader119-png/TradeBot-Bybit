import React from 'react';
import { BotStateSummary } from '../../types/trading.ts';
import type { StrategyConfig, StrategyCycle } from '../../types/strategy.ts';
import { C, num, panel, px, signed } from '../dashboard/ApiCard.tsx';

// Phase 6: real Bybit positions only (from the last successful sync), with clear Bot / External ownership.
export const OpenPositionsView: React.FC<{ state: BotStateSummary | null; owner?: 'bot' | 'external' }> = ({ state, owner }) => {
  const conn: any = (state as any)?.connection;
  const synced = conn?.state === 'CONNECTED' && conn?.positionsSyncedAt;
  const cycles: Record<string, StrategyCycle> = (state as any)?.strategyCycles || {};
  const strategies: Record<string, StrategyConfig> = (state as any)?.strategies || {};
  const rows = synced ? (state?.positions || []).filter((p) => !p.paper && !p.missingOnExchangeSince && p.size > 0 && (!owner || (owner === 'bot' ? p.owner === 'bot' : p.owner !== 'bot'))) : [];
  rows.sort((a, b) => (a.owner === b.owner ? a.symbol.localeCompare(b.symbol) : a.owner === 'bot' ? -1 : 1));
  const total = rows.reduce((t, p) => t + (p.unrealizedPnl || 0), 0);
  return (
    <div className="tb-auto" style={{ padding: '20px 20px 60px', maxWidth: 1400, margin: '0 auto', color: C.text }}>
      <div style={{ ...panel, fontSize: 13, color: C.soft }}>
        {!state?.settings?.isApiKeyConfigured ? 'Connect the Bybit API on the Dashboard to see your positions.' : !synced ? `Not synced with Bybit (${conn?.error?.message || conn?.state || 'no connection'}).` : <>Synced with Bybit at {new Date(conn.positionsSyncedAt).toLocaleTimeString()} · {rows.length} open {owner === 'bot' ? 'bot ' : owner === 'external' ? 'external ' : ''}position(s) · unrealised {signed(total, 4)} USDT. <b>Bot</b> = opened and managed by a bot hedge cycle (TP handled inside the bot). <b>External</b> = not opened by the bot; never changed, its Bybit TP is left as is.</>}
      </div>
      <div style={panel}>
        {rows.length === 0 ? <div style={{ fontSize: 13, color: C.dim }}>{synced ? 'No open position on Bybit.' : '—'}</div> : (
          <table style={{ width: '100%', fontSize: 13.5 }}>
            <thead><tr><th>Owner</th><th>Symbol</th><th>Side</th><th>Size</th><th>Value (USDT)</th><th>Entry</th><th>Mark</th><th>Leverage</th><th>Margin</th><th>Unrealised</th><th>TP</th><th>Liq. price</th></tr></thead>
            <tbody>{rows.map((p) => {
              const c = cycles[p.symbol];
              const sc = p.side === 'Buy' ? strategies[p.symbol]?.buy : strategies[p.symbol]?.sell;
              const avg = (c?.sides as any)?.[p.side]?.avgEntryPrice || p.entryPrice; // TP is measured from the bot's own fill price
              const botTp = p.owner === 'bot' && c && sc && avg ? (p.side === 'Buy' ? avg * (1 + sc.tpPct / 100) : avg * (1 - sc.tpPct / 100)) : null;
              return (
                <tr key={p.id}>
                  <td><b style={{ color: p.owner === 'bot' ? C.green : C.soft }}>{p.owner === 'bot' ? 'Bot' : 'External'}</b></td>
                  <td>{p.symbol}</td>
                  <td style={{ color: p.side === 'Buy' ? C.green : C.red }}>{p.side === 'Buy' ? 'Long' : 'Short'}</td>
                  <td>{p.size}</td>
                  <td>{num(p.notional, 2)}</td>
                  <td>{px(p.entryPrice)}</td>
                  <td>{px(p.markPrice)}</td>
                  <td>{p.leverage}x</td>
                  <td>{num(p.margin, 4)}</td>
                  <td style={{ color: p.unrealizedPnl >= 0 ? C.green : C.red }}>{signed(p.unrealizedPnl, 4)}</td>
                  <td>{p.owner === 'bot' ? (botTp ? <>{px(botTp)} <span style={{ fontSize: 11, color: C.dim }}>(bot, {sc!.tpPct}%)</span></> : '—') : p.tpPrice ? <>{px(p.tpPrice)} <span style={{ fontSize: 11, color: C.dim }}>(Bybit)</span></> : '—'}</td>
                  <td>{p.liqPrice ? px(p.liqPrice) : '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
};
