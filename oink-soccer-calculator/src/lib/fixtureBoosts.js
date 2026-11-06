const readTime = (entry, names) => {
  for (const source of [entry, entry?.boost]) {
    for (const name of names) {
      if (!source?.[name]) continue;
      const value = new Date(source[name]).getTime();
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
};

export const getFixtureBoostState = (state, fixtureTime, emptyState) => {
  if (state?.source !== 'live' || !Number.isFinite(fixtureTime) || fixtureTime === Number.MAX_SAFE_INTEGER) return emptyState;
  const boosts = (state.boosts || []).filter((entry) => {
    const end = readTime(entry, ['expires', 'expires_at', 'expiresAt', 'ends_at', 'endsAt', 'end_time', 'endTime', 'active_until', 'activeUntil']);
    const start = readTime(entry, ['starts', 'starts_at', 'started_at', 'start_time', 'startedAt', 'startTime', 'activated_at', 'activatedAt', 'used_at', 'usedAt', 'created_at', 'createdAt']);
    return end !== null && fixtureTime <= end && (start === null || fixtureTime >= start);
  });
  return { ...state, boosts };
};
