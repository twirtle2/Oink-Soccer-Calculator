import assert from 'node:assert/strict';
import test from 'node:test';

import { CHANCE_TYPES, CHANCE_TYPE_WEIGHTS, TACTICS } from './gameRules.js';

test('chance-type weights account for the engine no-repeat rule', () => {
  const types = Object.keys(CHANCE_TYPES);
  const total = types.reduce((sum, type) => sum + CHANCE_TYPE_WEIGHTS[type], 0);

  assert.equal(types.length, Object.keys(CHANCE_TYPE_WEIGHTS).length);
  assert.ok(Math.abs(total - 1) < 0.000001);
  assert.ok(CHANCE_TYPE_WEIGHTS.OpenPlay < CHANCE_TYPES.OpenPlay.baseWeight / 26);
});

test('high-press fatigue uses the official minute-weighted expectation', () => {
  assert.ok(Math.abs(TACTICS.press.high.fatigueFactor - 0.769033033) < 0.000000001);
});
