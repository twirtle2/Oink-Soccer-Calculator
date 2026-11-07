import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunSetupAnalysis } from './simulationReadiness.js';

test('switching fixtures waits for the new opponent lineup and boost check before screening', () => {
  const base = { activeTab: 'matchup', squadCount: 8, opponentCount: 5, fixture: { home_team_id: 'mine', away_team_id: 'new' }, ownedTeamIds: ['mine'], importing: false };
  assert.equal(shouldRunSetupAnalysis({ ...base, importedOpponentId: 'old', boostOpponentId: 'old' }), false);
  assert.equal(shouldRunSetupAnalysis({ ...base, importedOpponentId: 'new', boostOpponentId: 'old' }), false);
  assert.equal(shouldRunSetupAnalysis({ ...base, importedOpponentId: 'new', boostOpponentId: 'new' }), true);
});
