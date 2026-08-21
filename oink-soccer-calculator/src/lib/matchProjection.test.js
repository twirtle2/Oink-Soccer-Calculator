import assert from 'node:assert/strict';
import test from 'node:test';

import { getPoissonOutcomePercentages } from './matchProjection.js';

test('identical expected-goal rates produce symmetric win and loss probabilities', () => {
  const outcome = getPoissonOutcomePercentages(2, 2);

  assert.ok(Math.abs(outcome.win - outcome.loss) < 0.000001);
  assert.ok(Math.abs(outcome.win - 39.65) < 0.1);
  assert.ok(Math.abs(outcome.draw - 20.7) < 0.1);
});

test('zero expected goals resolves as a draw', () => {
  assert.deepEqual(getPoissonOutcomePercentages(0, 0), { win: 0, draw: 100, loss: 0 });
});
