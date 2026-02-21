import { BOOSTS, DR_DECAY, DR_MIN } from './gameRules.js';

const TEAM_BOOST = 'Team Boost';
const POSITION_BOOST = 'Position Boost';

const POSITION_TO_STAT = {
  Goalkeeper: 'GKP',
  Defense: 'DEF',
  Midfield: 'CTL',
  Attack: 'ATT',
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createBoostEntry = ({
  boostType,
  boostPosition = '',
  minBoost,
  maxBoost,
  applications = 0,
  note = '',
}) => ({
  boost: {
    boost_type: boostType,
    boost_position: boostPosition,
    min_boost: minBoost,
    max_boost: maxBoost,
    note,
    applications,
  },
});

export const createEmptyTeamBoostState = (fetchError = null) => ({
  source: 'manual-fallback',
  daysBoosted: null,
  effectivenessPct: null,
  boosts: [],
  fetchError: fetchError || null,
});

export const createManualFallbackBoostState = (boostKey, boostApps = 1, fetchError = null) => {
  const boost = BOOSTS[boostKey];
  if (!boost || boostKey === 'None') {
    return createEmptyTeamBoostState(fetchError);
  }

  const normalizedApps = Math.max(0, Math.floor(toFiniteNumber(boostApps, 1)) - 1);
  const boostType = boost.type === 'CTL' ? POSITION_BOOST : TEAM_BOOST;
  const boostPosition = boost.type === 'CTL' ? 'Midfield' : '';

  return {
    source: 'manual-fallback',
    daysBoosted: null,
    effectivenessPct: null,
    boosts: [
      createBoostEntry({
        boostType,
        boostPosition,
        minBoost: boost.min,
        maxBoost: boost.max,
        applications: normalizedApps,
      }),
    ],
    fetchError: fetchError || null,
  };
};

const getEntryBoost = (entry) => entry?.boost || entry;

export const getBoostMultipliersFromState = (teamBoostState) => {
  const multipliers = { CTL: 1, ATT: 1, DEF: 1, SPD: 1, GKP: 1 };
  const boosts = Array.isArray(teamBoostState?.boosts) ? teamBoostState.boosts : [];

  const effectPctRaw = teamBoostState?.source === 'live'
    ? toFiniteNumber(teamBoostState?.effectivenessPct, 100)
    : 100;
  const effectRatio = clamp(effectPctRaw, 0, 100) / 100;

  for (const entry of boosts) {
    const boost = getEntryBoost(entry);
    if (!boost) continue;

    const minBoost = toFiniteNumber(boost.min_boost, 1);
    const maxBoost = toFiniteNumber(boost.max_boost, minBoost);
    const baseBoost = (minBoost + maxBoost) / 2;
    const applications = Math.max(0, Math.floor(toFiniteNumber(boost.applications, 0)));
    const applicationMultiplier = Math.max(DR_MIN, Math.pow(DR_DECAY, applications));
    const effectiveMultiplier = 1 + ((baseBoost - 1) * effectRatio * applicationMultiplier);

    if (!Number.isFinite(effectiveMultiplier) || effectiveMultiplier <= 0) {
      continue;
    }

    const boostType = String(boost.boost_type || '');
    if (boostType === TEAM_BOOST) {
      multipliers.CTL *= effectiveMultiplier;
      multipliers.ATT *= effectiveMultiplier;
      multipliers.DEF *= effectiveMultiplier;
      multipliers.SPD *= effectiveMultiplier;
      multipliers.GKP *= effectiveMultiplier;
      continue;
    }

    if (boostType === POSITION_BOOST) {
      const targetStat = POSITION_TO_STAT[String(boost.boost_position || '')];
      if (targetStat) {
        multipliers[targetStat] *= effectiveMultiplier;
      }
    }
  }

  return multipliers;
};

export const formatBoostEffectRange = (entry) => {
  const boost = getEntryBoost(entry);
  if (!boost) return 'N/A';
  const minPct = Math.floor((toFiniteNumber(boost.min_boost, 1) - 1) * 100);
  const maxPct = Math.floor((toFiniteNumber(boost.max_boost, 1) - 1) * 100);
  return minPct === maxPct ? `${maxPct}%` : `${minPct}% - ${maxPct}%`;
};
