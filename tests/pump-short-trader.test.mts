import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PumpShortTrader } from '../src/server/engine/pumpShortTrader.ts';

test('Pump Short never sends orders unless explicitly armed in REAL mode', async () => {
  const prior = process.cwd();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-test-'));
  process.chdir(scratch);
  try {
    let mode = 'SIMULATION';
    const orders: any[] = [];
    const selectedLeverages: number[] = [];
    const instrument = { symbol: 'TESTUSDT', missingRules: [], maxLeverage: 25, qtyStep: 0.1,
      minQty: 0.1, maxQty: 10000, minNotional: 5 };
    const client = {
      getPositions: async () => [],
      getInstrumentsInfo: async () => ({ TESTUSDT: instrument }),
      getTickers: async () => ({ TESTUSDT: { lastPrice: 120 } }),
      getRiskTierMaxLeverage: async () => 10,
      setLeverage: async (_symbol: string, buy: number, sell: number = buy) => { assert.equal(buy, sell); selectedLeverages.push(buy); return { ok: true }; },
      createOrder: async (o: any) => { orders.push(o); return { orderId: 'test', orderLinkId: o.orderLinkId }; },
    };
    const engine = { getTradingMode: () => mode, getClient: () => client,
      assertOrderAllowed: () => { if (mode !== 'REAL') throw Error('blocked'); } };
    const db = { getSettings: () => ({ pumpShort: { positionNotionalUsdt: 30, retracementPct: 50 }, emergencyStop: false }), addLog: () => {} };
    const scanner = { snapshot: () => ({ running: false, lastCompletedAt: Date.now(),
      candidates: [{ symbol: 'TESTUSDT', low: 100, high: 130, growthPct: 30,
        retracementTarget: 115, lastPrice: 120, excludedShort: false }] }) };
    const trader = new PumpShortTrader(engine as any, db as any, scanner as any);
    await (trader as any).tick();
    assert.equal(orders.length, 0);
    assert.throws(() => trader.arm(true), /REAL/);
    mode = 'REAL';
    assert.throws(() => trader.arm(false), /confirmation/);
    await (trader as any).tick();
    assert.equal(orders.length, 0);
    trader.arm(true);
    await (trader as any).tick();
    assert.equal(orders.length, 1, JSON.stringify(trader.snapshot()));
    assert.deepEqual(selectedLeverages, [10], 'leverage must respect verified Bybit risk tier');
    assert.equal(orders[0].side, 'Sell');
    assert.equal(orders[0].positionIdx, 2);
    assert.equal(orders[0].reduceOnly, false);
    await (trader as any).tick();
    assert.equal(orders.length, 1, 'pending entry must not be sent twice');
    assert.equal(trader.snapshot().trades[0].target, 110);
    assert.ok(fs.existsSync(path.join(scratch, 'data', 'pump_short_trades.json')));
  } finally {
    process.chdir(prior);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
