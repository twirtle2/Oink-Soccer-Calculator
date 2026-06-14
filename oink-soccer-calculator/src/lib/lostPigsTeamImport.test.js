import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCurrentSeason,
  fetchGameCounter,
  fetchLeagueRoundFixtures,
  fetchLeagueSeasonFixtures,
  fetchSeasonTournamentFixtures,
  fetchTeamLineup,
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

test('fetchGameCounter normalizes season and current round', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/soccer\/game-counter$/);
    return okResponse({
      season: '16',
      game_round: '2',
      games_per_season: '44',
      is_active: true,
    });
  }, async () => {
    const counter = await fetchGameCounter();
    assert.deepEqual(counter, {
      season: 16,
      game_round: 2,
      games_per_season: 44,
      is_active: true,
    });
  });
});

test('fetchLeagueRoundFixtures uses the game fixture endpoint', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/soccer\/league\/2\/season\/16\/round\/3\/fixtures$/);
    return okResponse({
      fixtures: [
        {
          game_key: 'fixture-1',
          home_team_id: 'AlgorandAsset:1',
          away_team_id: 'AlgorandAsset:2',
        },
      ],
    });
  }, async () => {
    const result = await fetchLeagueRoundFixtures({ leagueId: '2', season: 16, round: 3 });
    assert.equal(result.season, 16);
    assert.equal(result.round, 3);
    assert.equal(result.fixtures.length, 1);
    assert.equal(result.fixtures[0].away_team_id, 'AlgorandAsset:2');
  });
});

test('fetchLeagueSeasonFixtures loads all requested rounds', async () => {
  const calls = [];
  await withMockedFetch(async (url) => {
    const text = String(url);
    calls.push(text);
    const round = text.match(/\/round\/(\d+)\/fixtures$/)?.[1];
    return okResponse({
      fixtures: [
        {
          game_key: `fixture-${round}`,
          home_team_id: `AlgorandAsset:${round}1`,
          away_team_id: `AlgorandAsset:${round}2`,
        },
      ],
    });
  }, async () => {
    const fixtures = await fetchLeagueSeasonFixtures({ leagueId: '2', season: 16, rounds: 3 });
    assert.equal(calls.length, 3);
    assert.deepEqual(fixtures.map((fixture) => fixture.game_round), [1, 2, 3]);
    assert.deepEqual(fixtures.map((fixture) => fixture.game_key), ['fixture-1', 'fixture-2', 'fixture-3']);
  });
});

test('fetchLeagueSeasonFixtures skips failed rounds', async () => {
  await withMockedFetch(async (url) => {
    const text = String(url);
    const round = text.match(/\/round\/(\d+)\/fixtures$/)?.[1];
    if (round === '2') {
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: 'round failed' }),
      };
    }
    return okResponse({
      fixtures: [
        {
          game_key: `fixture-${round}`,
          home_team_id: `AlgorandAsset:${round}1`,
          away_team_id: `AlgorandAsset:${round}2`,
        },
      ],
    });
  }, async () => {
    const fixtures = await fetchLeagueSeasonFixtures({ leagueId: '2', season: 16, rounds: 3 });
    assert.deepEqual(fixtures.map((fixture) => fixture.game_round), [1, 3]);
  });
});

test('fetchSeasonTournamentFixtures normalizes active cup matches', async () => {
  const calls = [];
  await withMockedFetch(async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.endsWith('/soccer/tournaments')) {
      return okResponse([
        {
          id: 'old-cup',
          name: 'The Boar Cup',
          season: 6,
          is_active: false,
          total_rounds: 8,
        },
        {
          id: 'lost-cup',
          name: 'The Lost Cup',
          season: 16,
          is_active: true,
          total_rounds: 6,
        },
      ]);
    }
    assert.match(text, /\/soccer\/tournaments\/lost-cup\/matches$/);
    return okResponse([
      {
        game_id: '5',
        tournament_id: 'lost-cup',
        round_number: 1,
        home_team_id: 'AlgorandAsset:1207576079',
        away_team_id: 'AlgorandAsset:1239258220',
        home_team_name: 'Wrexham FC',
        away_team_name: 'Albino Kickers',
        home_team_score: null,
        away_team_score: null,
        game_key: '',
      },
      {
        game_id: '1',
        tournament_id: 'lost-cup',
        round_number: 2,
        home_team_id: '',
        away_team_id: '',
        home_team_name: '',
        away_team_name: '',
        home_team_score: null,
        away_team_score: null,
        game_key: '',
      },
    ]);
  }, async () => {
    const fixtures = await fetchSeasonTournamentFixtures({ season: 16, leagueRounds: 44 });
    assert.equal(calls.length, 2);
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].competition, 'cup');
    assert.equal(fixtures[0].game_key, 'cup:lost-cup:1:5');
    assert.equal(fixtures[0].game_round, 'C1');
    assert.equal(fixtures[0].cup_round_label, 'Round of 64');
    assert.equal(fixtures[0].home_team_name, 'Wrexham FC');
    assert.equal(fixtures[0].away_team_id, 'AlgorandAsset:1239258220');
    assert.equal(fixtures[0].game_result, null);
  });
});

test('fetchTeamLineup returns mapped team players', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A123$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:123',
        custom_name: 'Fixture FC',
        formation: 'The Diamond (1-2-1)',
      },
      team_selection: {
        slots: {
          0: {
            role: 'captain',
            asset: { name: 'Keeper', image_url: 'https://example.com/keeper.png' },
            player_attributes: {
              based_on_player: 'Keeper',
              position: 'Goalkeeper',
              overall_rating: 81,
              speed_rating: 55,
              attack_rating: 10,
              control_rating: 70,
              defense_rating: 80,
              goalkeeper_rating: 82,
            },
          },
        },
      },
    });
  }, async () => {
    const lineup = await fetchTeamLineup('AlgorandAsset:123');
    assert.equal(lineup.teamLabel, 'Fixture FC');
    assert.equal(lineup.formationKey, 'Diamond');
    assert.equal(lineup.players.length, 1);
    assert.equal(lineup.players[0].pos, 'GK');
    assert.equal(lineup.players[0].ovr, 81);
  });
});

test('fetchTeamLineup maps active API injuries onto imported players', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A321$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:321',
        custom_name: 'Injury FC',
        formation: 'The Diamond (1-2-1)',
      },
      team_selection: {
        slots: {
          0: {
            asset: {
              name: 'The Lost Bots #0416',
              image_url: 'https://example.com/bot.png',
              injury: {
                expires: '2026-06-14T23:59:59Z',
                injury: {
                  severity: 'Low Severity',
                  name: 'Squirrel Scare',
                  stats_reduction: 0.95,
                  description: 'Spooked by a squirrel.',
                },
              },
            },
            player_attributes: {
              based_on_player: 'Y. Sommer',
              position: 'Goalkeeper',
              overall_rating: 85,
              speed_rating: 62,
              attack_rating: 20,
              control_rating: 75,
              defense_rating: 84,
              goalkeeper_rating: 88,
            },
          },
        },
      },
    });
  }, async () => {
    const lineup = await fetchTeamLineup('AlgorandAsset:321');
    assert.equal(lineup.players[0].injury, 'Low');
    assert.equal(lineup.players[0].injuryDetails.name, 'Squirrel Scare');
    assert.equal(lineup.players[0].injuryDetails.statsReduction, 0.95);
    assert.equal(lineup.players[0].injuryDetails.expires, '2026-06-14T23:59:59Z');
  });
});

test('fetchTeamLineup returns placeholder lineups as default projections', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A456$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:456',
        custom_name: 'Unset FC',
        formation: 'The Diamond (1-2-1)',
      },
      team_selection: {
        slots: Object.fromEntries(
          [0, 1, 2, 3, 4].map((slot) => [slot, {
            asset: { name: `PLAYER ${slot + 1}` },
            player_attributes: {
              based_on_player: `PLAYER ${slot + 1}`,
              position: slot === 0 ? 'Goalkeeper' : slot === 1 ? 'Defense' : slot === 4 ? 'Attack' : 'Midfield',
              overall_rating: 55,
              speed_rating: 55,
              attack_rating: 55,
              control_rating: 55,
              defense_rating: 55,
              goalkeeper_rating: slot === 0 ? 55 : 0,
            },
          }]),
        ),
      },
    });
  }, async () => {
    const lineup = await fetchTeamLineup('AlgorandAsset:456');
    assert.equal(lineup.teamLabel, 'Unset FC');
    assert.equal(lineup.formationKey, 'Diamond');
    assert.equal(lineup.isDefaultLineup, true);
    assert.equal(lineup.players.length, 5);
    assert.equal(lineup.players[0].name, 'PLAYER 1');
    assert.equal(lineup.players[0].ovr, 55);
  });
});

test('fetchTeamLineup synthesizes default players when slots are empty but formation is set', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A654$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:654',
        custom_name: 'Default FC',
        formation: 'The Y',
      },
      team_selection: {
        slots: {},
      },
    });
  }, async () => {
    const lineup = await fetchTeamLineup('AlgorandAsset:654');
    assert.equal(lineup.teamLabel, 'Default FC');
    assert.equal(lineup.formationKey, 'Y');
    assert.equal(lineup.isDefaultLineup, true);
    assert.deepEqual(lineup.players.map((player) => player.pos), ['GK', 'DF', 'MF', 'FW', 'FW']);
    assert.deepEqual(lineup.players.map((player) => player.ovr), [55, 55, 55, 55, 55]);
  });
});


test('fetchTeamLineup keeps a real player named Player when stats are not placeholder defaults', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A789$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:789',
        custom_name: 'Real FC',
        formation: 'The Diamond (1-2-1)',
      },
      team_selection: {
        slots: {
          0: {
            asset: { name: 'PLAYER 1' },
            player_attributes: {
              based_on_player: 'PLAYER 1',
              position: 'Goalkeeper',
              overall_rating: 72,
              speed_rating: 55,
              attack_rating: 10,
              control_rating: 70,
              defense_rating: 80,
              goalkeeper_rating: 72,
            },
          },
        },
      },
    });
  }, async () => {
    const lineup = await fetchTeamLineup('AlgorandAsset:789');
    assert.equal(lineup.isDefaultLineup, false);
    assert.equal(lineup.players.length, 1);
    assert.equal(lineup.players[0].name, 'PLAYER 1');
    assert.equal(lineup.players[0].ovr, 72);
  });
});

test('fetchTeamLineup rejects teams with no lineup slots', async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /\/v2\/soccer\/team\/AlgorandAsset%3A999$/);
    return okResponse({
      team: {
        id: 'AlgorandAsset:999',
        custom_name: 'Empty FC',
        formation: '',
      },
      team_selection: {
        slots: {},
      },
    });
  }, async () => {
    await assert.rejects(
      () => fetchTeamLineup('AlgorandAsset:999'),
      /No active lineup found/,
    );
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
