import assert from 'node:assert/strict';
import test from 'node:test';
import {partialCloseQuantity} from '../src/server/api/futuresManual.ts';

test('partial-close quantity rounds DOWN to Bybit lot step',()=>{
 assert.equal(partialCloseQuantity(23.7,25,0.1,0.1),5.9);
 assert.equal(partialCloseQuantity(23.7,50,0.1,0.1),11.8);
 assert.equal(partialCloseQuantity(23.7,75,0.1,0.1),17.7);
});

test('cannot leave exchange dust or close less than minimum',()=>{
 assert.throws(()=>partialCloseQuantity(0.3,25,0.1,0.2),/minimum/);
 assert.throws(()=>partialCloseQuantity(0.3,75,0.1,0.2),/minimum/);
});

test('reject out of range, invalid steps and amount',()=>{
 for(const pct of [0,100,101,-25,NaN,Infinity]){
   assert.throws(()=>partialCloseQuantity(10,pct,0.1,0.1),/Invalid/);
 }
 assert.throws(()=>partialCloseQuantity(10,25,0,0.1),/Invalid/);
 assert.throws(()=>partialCloseQuantity(0,25,0.1,0.1),/Invalid/);
});
