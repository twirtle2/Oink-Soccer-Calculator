import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCurrentSeason,
  fetchTeamActiveBoosts,
  fetchTeamBoostEffectiveness,
  fetchTeamBoostState,
} from './lostPigsTeamImport.js';

const withMockedFetch = async (handler, run) => {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
};

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

test('fetchCurrentSeason reads the season from game-counter', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/soccer\/game-counter$/);
    return okResponse({ season: 14 });
  }, async () => {
    const season = await fetchCurrentSeason();
    assert.equal(season, 14);
  });
});

test('fetchTeamActiveBoosts returns boost rows', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/soccer\/team\/AlgorandAsset%3A123\/boosts$/);
    return okResponse({ boosts: [{ boost: { boost_type: 'Team Boost' } }] });
  }, async () => {
    const boosts = await fetchTeamActiveBoosts('AlgorandAsset:123');
    assert.equal(boosts.length, 1);
    assert.equal(boosts[0].boost.boost_type, 'Team Boost');
  });
});

test('fetchTeamBoostEffectiveness returns normalized fields', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/soccer\/team\/AlgorandAsset%3A123\/league\/2\/season\/14\/days-boosted$/);
    return okResponse({ days_boosted: 18, boost_effectiveness: 58 });
  }, async () => {
    const result = await fetchTeamBoostEffectiveness('AlgorandAsset:123', '2', 14);
    assert.deepEqual(result, { days_boosted: 18, boost_effectiveness: 58 });
  });
});

test('fetchTeamBoostState combines active boosts with effectiveness', async () => {
  const calls = [];
  await withMockedFetch(async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.endsWith('/boosts')) {
      return okResponse({
        boosts: [
          {
            boost: {
              boost_type: 'Position Boost',
              boost_position: 'Midfield',
              min_boost: 1.03,
              max_boost: 1.07,
              applications: 0,
            },
          },
        ],
      });
    }
    if (text.includes('/days-boosted')) {
      return okResponse({ days_boosted: 16, boost_effectiveness: 61 });
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: 'not found' }),
    };
  }, async () => {
    const state = await fetchTeamBoostState({
      teamId: 'AlgorandAsset:123',
      leagueId: '1',
      season: 14,
    });

    assert.equal(state.source, 'live');
    assert.equal(state.daysBoosted, 16);
    assert.equal(state.effectivenessPct, 61);
    assert.equal(state.boosts.length, 1);
    assert.equal(state.fetchError, null);
    assert.equal(calls.length, 2);
  });
});
