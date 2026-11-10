import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PUMP_SHORT, findPumpWave, isPumpShortEntryEligible, pumpShortTargetHit, pumpShortEntryTarget } from '../src/server/engine/pumpShort.ts';

const day = 86_400_000;
const now = 20 * day;
const c = (d: number, l: number, h: number) => ({ t: d * day, l, h });

test('20% threshold and 50% retracement use the preceding low', () => {
  const wave = findPumpWave([c(11, 100, 105), c(12, 112, 140), c(13, 120, 135)], now, DEFAULT_PUMP_SHORT);
  assert.ok(wave);
  assert.equal(wave.low, 100);
  assert.equal(wave.high, 140);
  assert.equal(wave.growthPct, 40);
  assert.equal(wave.exitPrice, 120);
  assert.equal(isPumpShortEntryEligible(wave, 130), true);
  assert.equal(isPumpShortEntryEligible(wave, 115), true);
  assert.equal(pumpShortTargetHit(wave, 120), true);
});

test('exit target is halfway from actual SELL entry to wave low, or further with configurable percentage', () => {
  assert.equal(pumpShortEntryTarget(53.44, 38.83, 50).toFixed(3), '46.135');
  assert.equal(pumpShortEntryTarget(53.44, 38.83, 55).toFixed(4), '45.4045');
  assert.throws(() => pumpShortEntryTarget(35, 38.83, 50));
});

test('a high before the low is not counted as a pump', () => {
  assert.equal(findPumpWave([c(11, 130, 150), c(12, 100, 105)], now, DEFAULT_PUMP_SHORT), null);
});

test('candles outside the lookback window are excluded', () => {
  assert.equal(findPumpWave([c(5, 50, 60), c(12, 100, 105), c(13, 103, 110)], now, DEFAULT_PUMP_SHORT), null);
});

test('price touching exactly +20% qualifies', () => {
  const wave = findPumpWave([c(11, 100, 100), c(12, 120, 120)], now, DEFAULT_PUMP_SHORT);
  assert.ok(wave);
  assert.equal(wave.exitPrice, 110);
});
