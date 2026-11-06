import test from 'node:test';
import assert from 'node:assert/strict';
import { getFixtureBoostState } from './fixtureBoosts.js';

const empty = { boosts: [] };
const at = Date.parse('2026-07-02T12:00:00Z');
test('includes only live boosts whose known windows cover the fixture', () => {
  const covered = { boost: { boost_type: 'Team Boost' }, expires: '2026-07-03T00:00:00Z' };
  const state = { source: 'live', effectivenessPct: 60, boosts: [covered, { expires: '2026-07-01T00:00:00Z' }, {}, { starts: '2026-07-03T00:00:00Z', expires: '2026-07-04T00:00:00Z' }] };
  const result = getFixtureBoostState(state, at, empty);
  assert.deepEqual(result.boosts, [covered]);
  assert.equal(result.effectivenessPct, 60);
});
test('does not assume coverage when state or fixture time is unavailable', () => {
  assert.equal(getFixtureBoostState(null, at, empty), empty);
  assert.equal(getFixtureBoostState({ source: 'live', boosts: [] }, Number.MAX_SAFE_INTEGER, empty), empty);
});
