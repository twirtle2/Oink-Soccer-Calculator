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

test('the team with higher expected goals has the higher win probability', () => {
  const underdog = getPoissonOutcomePercentages(0.85, 3.73);
  const favourite = getPoissonOutcomePercentages(3.73, 0.85);

  assert.ok(Math.abs(underdog.win - 4.43) < 0.01);
  assert.ok(Math.abs(underdog.draw - 7.97) < 0.01);
  assert.ok(Math.abs(underdog.loss - 87.6) < 0.01);
  assert.ok(Math.abs(favourite.win - 87.6) < 0.01);
  assert.ok(Math.abs(favourite.loss - 4.43) < 0.01);
});
