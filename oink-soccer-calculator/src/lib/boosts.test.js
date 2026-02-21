import test from 'node:test';
import assert from 'node:assert/strict';

import { DR_DECAY, DR_MIN } from './gameRules.js';
import {
  createManualFallbackBoostState,
  getBoostMultipliersFromState,
} from './boosts.js';

const teamBoostEntry = (minBoost, maxBoost, applications = 0) => ({
  boost: {
    boost_type: 'Team Boost',
    boost_position: '',
    min_boost: minBoost,
    max_boost: maxBoost,
    applications,
  },
});

const positionBoostEntry = (position, minBoost, maxBoost, applications = 0) => ({
  boost: {
    boost_type: 'Position Boost',
    boost_position: position,
    min_boost: minBoost,
    max_boost: maxBoost,
    applications,
  },
});

test('applies effectiveness scaling to boost multipliers', () => {
  const fullState = {
    source: 'live',
    effectivenessPct: 100,
    boosts: [teamBoostEntry(1.1, 1.1, 0)],
  };
  const halfState = {
    source: 'live',
    effectivenessPct: 50,
    boosts: [teamBoostEntry(1.1, 1.1, 0)],
  };
  const zeroState = {
    source: 'live',
    effectivenessPct: 0,
    boosts: [teamBoostEntry(1.1, 1.1, 0)],
  };

  assert.equal(getBoostMultipliersFromState(fullState).ATT, 1.1);
  assert.equal(getBoostMultipliersFromState(halfState).ATT, 1.05);
  assert.equal(getBoostMultipliersFromState(zeroState).ATT, 1);
});

test('applies application decay and DR_MIN clamp', () => {
  const singleApp = {
    source: 'live',
    effectivenessPct: 100,
    boosts: [teamBoostEntry(1.1, 1.1, 1)],
  };
  const manyApps = {
    source: 'live',
    effectivenessPct: 100,
    boosts: [teamBoostEntry(1.1, 1.1, 1000)],
  };

  assert.ok(Math.abs(getBoostMultipliersFromState(singleApp).ATT - (1 + (0.1 * DR_DECAY))) < 1e-12);
  assert.ok(Math.abs(getBoostMultipliersFromState(manyApps).ATT - (1 + (0.1 * DR_MIN))) < 1e-12);
});

test('maps position boosts to the expected stat and ignores unknown positions', () => {
  const state = {
    source: 'live',
    effectivenessPct: 100,
    boosts: [
      positionBoostEntry('Midfield', 1.07, 1.07, 0),
      positionBoostEntry('Unknown', 1.2, 1.2, 0),
    ],
  };
  const multipliers = getBoostMultipliersFromState(state);

  assert.equal(multipliers.CTL, 1.07);
  assert.equal(multipliers.ATT, 1);
  assert.equal(multipliers.DEF, 1);
  assert.equal(multipliers.SPD, 1);
  assert.equal(multipliers.GKP, 1);
});

test('stacks team and position boosts multiplicatively', () => {
  const state = {
    source: 'live',
    effectivenessPct: 100,
    boosts: [
      teamBoostEntry(1.05, 1.05, 0),
      positionBoostEntry('Midfield', 1.07, 1.07, 0),
    ],
  };
  const multipliers = getBoostMultipliersFromState(state);

  assert.equal(multipliers.ATT, 1.05);
  assert.equal(multipliers.CTL, 1.05 * 1.07);
});

test('manual fallback maps legacy boost keys into normalized boost entries', () => {
  const noBoost = createManualFallbackBoostState('None', 1);
  const orange = createManualFallbackBoostState('HalftimeOrange', 1);
  const truffle = createManualFallbackBoostState('GoldenTruffle', 3);

  assert.equal(noBoost.boosts.length, 0);

  assert.equal(orange.boosts[0].boost.boost_type, 'Position Boost');
  assert.equal(orange.boosts[0].boost.boost_position, 'Midfield');
  assert.equal(orange.boosts[0].boost.applications, 0);

  assert.equal(truffle.boosts[0].boost.boost_type, 'Team Boost');
  assert.equal(truffle.boosts[0].boost.applications, 2);
});
