export function shouldRunSetupAnalysis({ activeTab, squadCount, opponentCount, fixture, importing, ownedTeamIds, importedOpponentId, boostOpponentId }) {
  if (activeTab !== 'matchup' || squadCount < 5 || opponentCount < 5 || !fixture || fixture.game_result || importing) return false;
  const mine = new Set((ownedTeamIds || []).map(String));
  const expected = mine.has(String(fixture.home_team_id)) ? fixture.away_team_id : mine.has(String(fixture.away_team_id)) ? fixture.home_team_id : fixture.away_team_id;
  if (!expected || !importedOpponentId || !boostOpponentId) return false;
  return String(expected) === String(importedOpponentId) && String(expected) === String(boostOpponentId);
}
