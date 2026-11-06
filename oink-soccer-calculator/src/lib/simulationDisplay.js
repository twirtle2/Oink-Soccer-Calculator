// A simulation is only authoritative for the exact matchup inputs it used.
export const selectMatchupDisplay = (_estimate, simulation, fingerprint, activeTab) => {
  const baseline = simulation?.status === 'done' && simulation.fingerprint === fingerprint && activeTab === 'matchup'
    ? simulation.results?.find((result) => result.key === 'baseline') : null;
  if (!baseline || ![baseline.trials, baseline.wins, baseline.draws, baseline.losses, baseline.goalsFor, baseline.goalsAgainst].every(Number.isFinite) || baseline.trials <= 0 || baseline.wins + baseline.draws + baseline.losses !== baseline.trials) return { label: 'Game engine · simulated win', source: 'pending', win: '—', draw: '—', loss: '—', myxG: '—', oppxG: '—' };
  return {
    label: 'Game engine · simulated win', source: 'engine', trials: baseline.trials,
    win: (100 * baseline.wins / baseline.trials).toFixed(1), draw: (100 * baseline.draws / baseline.trials).toFixed(1),
    loss: (100 * baseline.losses / baseline.trials).toFixed(1), myxG: (baseline.goalsFor / baseline.trials).toFixed(2),
    oppxG: (baseline.goalsAgainst / baseline.trials).toFixed(2),
  };
};
