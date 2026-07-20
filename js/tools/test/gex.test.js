import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOccSymbol } from '../cboe.js';
import {
  thirdFriday, isThirdFriday, enumerateExpiries, autoSelectExpiries, expiriesForPreset,
  selectContracts, contractGex, computeGex, floorFor,
} from '../gex.js';

test('parseOccSymbol parses root/expiry/type/strike', () => {
  assert.deepEqual(parseOccSymbol('SPX260717C05900000'), { root: 'SPX', expiry: '2026-07-17', type: 'C', strike: 5900 });
  assert.deepEqual(parseOccSymbol('SPY260717P00360000'), { root: 'SPY', expiry: '2026-07-17', type: 'P', strike: 360 });
  assert.equal(parseOccSymbol('garbage'), null);
});

test('thirdFriday + isThirdFriday', () => {
  // July 2026: 1st is Wed, first Friday = 3rd, third Friday = 17th.
  assert.equal(thirdFriday(2026, 7), 17);
  assert.ok(isThirdFriday('2026-07-17'));
  assert.ok(!isThirdFriday('2026-07-24'));
  // Aug 2026 third Friday = 21st.
  assert.equal(thirdFriday(2026, 8), 21);
  assert.ok(isThirdFriday('2026-08-21'));
});

test('enumerateExpiries computes dte + opex, sorted, drops past dates', () => {
  const contracts = [
    { expiry: '2026-07-17', type: 'C', strike: 100, oi: 1, gamma: 0 },
    { expiry: '2026-08-21', type: 'C', strike: 100, oi: 1, gamma: 0 },
    { expiry: '2026-07-01', type: 'C', strike: 100, oi: 1, gamma: 0 }, // past
  ];
  const exps = enumerateExpiries(contracts, '2026-07-17');
  assert.deepEqual(exps.map((e) => e.date), ['2026-07-17', '2026-08-21']);
  assert.equal(exps[0].dte, 0);
  assert.ok(exps[0].opex);       // today is monthly OPEX
  assert.equal(exps[1].dte, 35);
  assert.ok(exps[1].opex);
});

test('autoSelectExpiries: 0DTE + all <=30d + next monthly OPEX beyond 30d', () => {
  const infos = [
    { date: '2026-07-17', dte: 0, opex: true },
    { date: '2026-07-24', dte: 7, opex: false },
    { date: '2026-08-14', dte: 28, opex: false },
    { date: '2026-08-21', dte: 35, opex: true },   // next monthly, beyond 30d
    { date: '2026-09-18', dte: 63, opex: true },   // later monthly, excluded
  ];
  const set = autoSelectExpiries(infos, {});
  assert.ok(set.has('2026-07-17'));
  assert.ok(set.has('2026-07-24'));
  assert.ok(set.has('2026-08-14'));
  assert.ok(set.has('2026-08-21'));   // pulled in as next monthly OPEX
  assert.ok(!set.has('2026-09-18'));  // not the *next* monthly
});

test('expiriesForPreset resolves dropdown presets', () => {
  const infos = [
    { date: '2026-07-17', dte: 0, opex: true },
    { date: '2026-07-24', dte: 7, opex: false },
    { date: '2026-08-14', dte: 28, opex: false },
    { date: '2026-08-21', dte: 35, opex: true },
    { date: '2027-01-15', dte: 182, opex: true }, // LEAPS-ish, far out
  ];
  assert.deepEqual([...expiriesForPreset(infos, 'all')].sort(), infos.map((e) => e.date).sort());
  assert.deepEqual([...expiriesForPreset(infos, '7d')].sort(), ['2026-07-17', '2026-07-24']);
  assert.deepEqual(
    [...expiriesForPreset(infos, '30d')].sort(),
    ['2026-07-17', '2026-07-24', '2026-08-14']
  );
  // 'auto' delegates to autoSelectExpiries (0DTE + <=30d + next monthly OPEX).
  assert.deepEqual([...expiriesForPreset(infos, 'auto')].sort(), [...autoSelectExpiries(infos, {})].sort());
  // An exact date selects only itself.
  assert.deepEqual([...expiriesForPreset(infos, '2027-01-15')], ['2027-01-15']);
  // An unknown/missing date falls back to auto rather than an empty set.
  assert.deepEqual([...expiriesForPreset(infos, '2099-01-01')].sort(), [...autoSelectExpiries(infos, {})].sort());
});

test('selectContracts filters by expiry, strike window, OI floor', () => {
  const contracts = [
    { expiry: '2026-07-17', type: 'C', strike: 100, oi: 500, gamma: 0.05 }, // keep
    { expiry: '2026-07-17', type: 'P', strike: 60, oi: 500, gamma: 0.05 },  // out of ±12% window
    { expiry: '2026-07-17', type: 'C', strike: 100, oi: 10, gamma: 0.05 },  // below floor
    { expiry: '2026-08-21', type: 'C', strike: 100, oi: 500, gamma: 0.05 }, // expiry not selected
  ];
  const { selected, summary } = selectContracts(contracts, {
    expirySet: new Set(['2026-07-17']), spot: 100, strikePct: 0.12, minOI: 100,
  });
  assert.equal(selected.length, 1);
  assert.equal(summary.nSelected, 1);
  assert.equal(summary.minOI, 100);
});

test('selectContracts: minVolume defaults to 0 (off) but filters when set', () => {
  const contracts = [
    { expiry: '2026-07-17', type: 'C', strike: 100, oi: 500, volume: 0, gamma: 0.05 },
    { expiry: '2026-07-17', type: 'C', strike: 101, oi: 500, volume: 5, gamma: 0.05 },
    { expiry: '2026-07-17', type: 'C', strike: 102, oi: 500, gamma: 0.05 }, // no volume field at all
  ];
  const opts = { expirySet: new Set(['2026-07-17']), spot: 100, strikePct: 0.12, minOI: 100 };
  // Default (no minVolume passed): nothing filtered by volume.
  assert.equal(selectContracts(contracts, opts).selected.length, 3);
  // minVolume: 1 drops zero-volume and missing-volume strikes.
  const { selected, summary } = selectContracts(contracts, { ...opts, minVolume: 1 });
  assert.deepEqual(selected.map((c) => c.strike), [101]);
  assert.equal(summary.minVolume, 1);
});

test('contractGex sign convention: calls +, puts −', () => {
  const call = { type: 'C', strike: 100, oi: 1000, gamma: 0.01 };
  const put = { type: 'P', strike: 100, oi: 1000, gamma: 0.01 };
  const spot = 100;
  // 0.01 * 1000 * 100 * 100^2 * 0.01 = 100000
  assert.equal(contractGex(call, spot), 100000);
  assert.equal(contractGex(put, spot), -100000);
});

test('contractGex weightBy volume uses volume instead of OI', () => {
  const call = { type: 'C', strike: 100, oi: 1000, volume: 50, gamma: 0.01 };
  // OI-weighted (default): 0.01 * 1000 * 100 * 100^2 * 0.01 = 100000
  assert.equal(contractGex(call, 100), 100000);
  // Volume-weighted: 0.01 * 50 * 100 * 100^2 * 0.01 = 5000
  assert.equal(contractGex(call, 100, 'volume'), 5000);
  // Missing volume treated as 0.
  assert.equal(contractGex({ type: 'C', strike: 100, oi: 1000, gamma: 0.01 }, 100, 'volume'), 0);
});

test('computeGex aggregates, finds walls + zero-gamma flip', () => {
  const spot = 100;
  const selected = [
    { type: 'P', strike: 95, oi: 2000, gamma: 0.01 }, // big negative -> put wall
    { type: 'C', strike: 105, oi: 3000, gamma: 0.01 }, // big positive -> call wall
    { type: 'C', strike: 100, oi: 1000, gamma: 0.01 },
  ];
  const r = computeGex(selected, spot);
  assert.equal(r.putWall, 95);
  assert.equal(r.callWall, 105);
  // cumulative goes negative at 95 then positive by 105 -> a flip exists between
  assert.ok(r.flip > 95 && r.flip < 105);
  assert.equal(r.byStrike.length, 3);
});

test('floorFor uses per-symbol floors then default', () => {
  assert.equal(floorFor('SPX'), 100);
  assert.equal(floorFor('_SPX'), 100);
  assert.equal(floorFor('SPY'), 500);
  assert.equal(floorFor('ZZZZ'), 200);
});
