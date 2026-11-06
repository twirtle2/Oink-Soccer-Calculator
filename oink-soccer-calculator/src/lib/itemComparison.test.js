import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOutcomes } from './itemComparison.js';

test('compares win, draw, and chance of at least one point in percentage points', () => {
  const result = compareOutcomes({ win: 12, draw: 17 }, { win: 19, draw: 22 });
  assert.deepEqual(result, { winDelta: 7, drawDelta: 5, pointBefore: 29, pointAfter: 41, pointDelta: 12 });
});
