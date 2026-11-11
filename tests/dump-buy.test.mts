import assert from 'node:assert/strict';
import test from 'node:test';
import { findDump, dumpBuyEntryTarget } from '../src/server/engine/dumpBuy.ts';

const day=86400000,now=20*day;
const candle=(d:number,l:number,h:number)=>({t:d*day,l,h});

test('50% decline within 20 days qualifies, but a recovered price does not',()=>{
  const candles=[candle(1,90,100),candle(10,42,50),candle(19,38,45)];
  assert.equal(findDump(candles,now,20,50,49)?.dropPct,51);
  assert.equal(findDump(candles,now,20,50,52),null);
});
test('Dump BUY exit is halfway from real BUY entry toward pre-dump peak',()=>{
  assert.equal(dumpBuyEntryTarget(40,100,50),70);
  assert.throws(()=>dumpBuyEntryTarget(100,40));
});

test('60% drop from earlier high to current price is shown',()=>{
  const d=findDump([candle(11,90,100),candle(12,35,50),candle(13,36,45)],now,10,60,39);
  assert.ok(d);assert.equal(d.peak,100);assert.equal(d.trough,35);assert.equal(d.dropPct,61);
});
test('a recovered dump is not eligible',()=>{
  assert.equal(findDump([candle(11,90,100),candle(12,30,40)],now,10,60,65),null);
});
test('high and low on same candle cannot prove chronological dump',()=>{
  assert.equal(findDump([candle(11,30,100),candle(12,30,35)],now,10,60,30)?.peak,100);
  assert.equal(findDump([candle(11,30,100)],now,10,60,30),null);
});
test('drop outside lookback and threshold boundary',()=>{
  assert.equal(findDump([candle(5,80,100),candle(12,30,40)],now,10,60,30),null);
  assert.equal(findDump([candle(11,100,100),candle(12,40,50)],now,10,60,40)?.dropPct,60);
});
