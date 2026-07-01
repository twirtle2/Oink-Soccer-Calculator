import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLiveLineupInjuries } from './walletSync.js';

test('applyLiveLineupInjuries overlays live injuries onto matching wallet players', () => {
  const squad = [
    {
      id: 'asset:3124034212',
      assetId: '3124034212',
      name: 'Best Frens #0154',
      injury: null,
      injuryDetails: null,
    },
    {
      id: 'asset:1104083506',
      assetKey: 'Algorand:1104083506',
      name: 'The Lost Bots #3631',
      injury: 'Low',
      injuryDetails: { name: 'Old Injury' },
    },
  ];

  const nextSquad = applyLiveLineupInjuries(squad, [
    {
      id: 'teamurl:AlgorandAsset:1207576079:2',
      assetId: '3124034212',
      injury: 'High',
      injuryDetails: {
        name: 'Post-Match Cramp',
        statsReduction: 0.85,
        expires: '2026-07-02T23:59:59Z',
      },
    },
    {
      id: 'teamurl:AlgorandAsset:1207576079:5',
      assetKey: 'Algorand:1104083506',
      injury: null,
      injuryDetails: null,
    },
  ]);

  assert.notEqual(nextSquad, squad);
  assert.equal(nextSquad[0].injury, 'High');
  assert.equal(nextSquad[0].injuryDetails.name, 'Post-Match Cramp');
  assert.equal(nextSquad[1].injury, null);
  assert.equal(nextSquad[1].injuryDetails, null);
});

test('applyLiveLineupInjuries preserves the original array when nothing changes', () => {
  const squad = [
    {
      id: 'asset:3124034212',
      assetId: '3124034212',
      name: 'Best Frens #0154',
      injury: 'High',
      injuryDetails: { name: 'Post-Match Cramp' },
    },
  ];

  const nextSquad = applyLiveLineupInjuries(squad, [
    {
      assetId: '3124034212',
      injury: 'High',
      injuryDetails: { name: 'Post-Match Cramp' },
    },
  ]);

  assert.equal(nextSquad, squad);
});
