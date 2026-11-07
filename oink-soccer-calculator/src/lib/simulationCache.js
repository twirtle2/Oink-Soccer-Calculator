// Bounded to keep a long browser session from accumulating every fixture.
export function createSimulationCache(limit = 16) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
  };
}

export function pendingSimulationJobs(jobs, completed) {
  return jobs.filter((job) => !Object.hasOwn(completed, job.key));
}

export function validSimulationJob(job) {
  const result = job?.results?.[0];
  return !job?.error && result && [result.trials, result.wins, result.draws, result.losses, result.goalsFor, result.goalsAgainst].every(Number.isFinite)
    && result.trials > 0 && result.wins + result.draws + result.losses === result.trials;
}
