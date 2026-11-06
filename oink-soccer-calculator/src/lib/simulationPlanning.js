export function indexOwnResults(results) {
  const indexed = {};
  for (const [job, rows] of Object.entries(results)) {
    if (!job.startsWith('own:')) continue;
    const id = job.slice(4, job.lastIndexOf(':'));
    indexed[id] ||= {};
    for (const row of rows) indexed[id][row.key] = row;
  }
  return indexed;
}

export function fixtureProjection(results, ownIndex, fixtureId, own, boostKey = '', effectiveness = 100) {
  const exact = Math.max(0, Math.min(100, Number(effectiveness) || 0));
  const key = boostKey ? `${boostKey}:${exact}` : 'baseline';
  const fallback = boostKey ? `${boostKey}:${Math.floor(exact / 25) * 25}` : 'baseline';
  const row = own ? (ownIndex[fixtureId]?.[key] || ownIndex[fixtureId]?.[fallback]) : results[fixtureId]?.[0];
  if (!row || ![row.trials, row.wins, row.draws, row.losses, row.goalsFor, row.goalsAgainst].every(Number.isFinite) || row.trials <= 0 || row.wins + row.draws + row.losses !== row.trials) return null;
  return { win: 100 * row.wins / row.trials, draw: 100 * row.draws / row.trials, loss: 100 * row.losses / row.trials, myxG: row.goalsFor / row.trials, oppxG: row.goalsAgainst / row.trials };
}

export function blendProjections(baseline, boosted, coverage) {
  const fraction = Math.max(0, Math.min(1, coverage));
  return Object.fromEntries(Object.keys(baseline).map((key) => [key, baseline[key] + fraction * (boosted[key] - baseline[key])]));
}

export function playedPoints(homeGoals, awayGoals) {
  return homeGoals > awayGoals ? { my: 3, opponent: 0 } : awayGoals > homeGoals ? { my: 0, opponent: 3 } : { my: 1, opponent: 1 };
}
