// Bounded to keep a long browser session from accumulating every fixture.
export function createSimulationCache(limit = 16, { storage = null, storageKey = '', shouldPersist = () => true, serialize = (value) => value } = {}) {
  const entries = new Map();
  try {
    const saved = storage && storageKey ? JSON.parse(storage.getItem(storageKey) || '[]') : [];
    if (Array.isArray(saved)) saved.slice(-limit).forEach(([key, value]) => entries.set(key, value));
  } catch { /* Storage is optional; an in-memory cache still works. */ }
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value, { persist = false } = {}) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      if (persist && storage && storageKey) {
        try {
          const saved = Array.from(entries).filter(([, item]) => shouldPersist(item)).map(([entryKey, item]) => [entryKey, serialize(item)]);
          storage.setItem(storageKey, JSON.stringify(saved));
        } catch { /* Quota and privacy settings must not prevent simulations. */ }
      }
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

// Fixture time is represented by the boosts that actually cover that fixture.
export const setupSimulationKey = ({ squad, opponent, myHome, boosts }) => JSON.stringify({ version: 2, squad, opponent, myHome, boosts });
