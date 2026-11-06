import test from 'node:test';
import assert from 'node:assert/strict';
import { indexOwnResults, fixtureProjection, blendProjections, playedPoints } from './simulationPlanning.js';

const base = { key: 'baseline', trials: 1000, wins: 150, draws: 200, losses: 650, goalsFor: 1000, goalsAgainst: 2000 };
const item = { ...base, key: 'gold:75', wins: 180, draws: 220, losses: 600, goalsFor: 1100 };
const results = { 'game:1': [base], 'own:game:1:0': [base], 'own:game:1:10': [item] };
const index = indexOwnResults(results);
test('fixture simulations use exact fixture and scenario and fall back to a lower effectiveness', () => {
  assert.equal(fixtureProjection(results, index, 'game:1', true).win, 15);
  assert.equal(fixtureProjection(results, index, 'game:1', true, 'gold', 97).win, 18);
  assert.equal(fixtureProjection(results, index, 'game:1', true, 'gold', 40), null);
  assert.equal(fixtureProjection(results, index, 'game:2', true), null);
  assert.equal(fixtureProjection(results, index, 'game:1', false).oppxG, 2);
});
test('partial item coverage blends simulated outcomes and preserves probabilities', () => {
  const before = fixtureProjection(results, index, 'game:1', true);
  const after = fixtureProjection(results, index, 'game:1', true, 'gold', 75);
  const blended = blendProjections(before, after, 0.5);
  assert.equal(blended.win, 16.5);
  assert.equal(blended.draw, 21);
  assert.equal(blended.win + blended.draw + blended.loss, 100);
});
test('incomplete simulation results are not used as forecasts', () => {
  assert.equal(fixtureProjection({ x: [{...base, losses: 1}] }, {}, 'x', false), null);
});

test('completed fixtures contribute actual league points to season plans', () => {
  assert.deepEqual(playedPoints(3, 1), { my: 3, opponent: 0 });
  assert.deepEqual(playedPoints(1, 3), { my: 0, opponent: 3 });
  assert.deepEqual(playedPoints(1, 1), { my: 1, opponent: 1 });
});
