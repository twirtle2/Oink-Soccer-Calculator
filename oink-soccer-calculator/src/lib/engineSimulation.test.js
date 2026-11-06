import test from 'node:test';
import assert from 'node:assert/strict';
import { engineBoosts, engineLineup } from './engineSimulation.js';

test('maps positions, roles, tactics, injuries and effectiveness to engine input', () => {
  const boosts = engineBoosts({ source: 'live', effectivenessPct: 50, boosts: [{ boost: { boost_type: 'Team Boost', min_boost: 1.04, max_boost: 1.08 } }] }, 0.97, 0.2);
  assert.ok(Math.abs(boosts[0].min_boost - 1.02) < 1e-10);
  const lineup = engineLineup([{ id: 'p', pos: 'MF', positions: ['MF', 'FW'], selectedPosition: 'FW', stats: { ATT: 83 }, role: 'target_man', injury: 'Low' }], 'Pyramid', { press: 'medium', tempo: 'slow', lineHeight: 'deep', setPieceTaker: 'p' }, boosts);
  assert.equal(lineup.players[0].position, 'Attack');
  assert.deepEqual(lineup.players[0].attributes.positions, ['Midfield', 'Attack']);
  assert.equal(lineup.players[0].injury.injury.stats_reduction, 0.95);
  assert.equal(lineup.team.tactics.SetPieceTaker, 'p');
});
