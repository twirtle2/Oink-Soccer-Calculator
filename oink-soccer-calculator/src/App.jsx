import { indexOwnResults, fixtureProjection, blendProjections, playedPoints } from './lib/simulationPlanning.js';
import { compareSetup } from './lib/setupChanges.js';
import { engineBoosts, engineLineup } from './lib/engineSimulation.js';
import { selectMatchupDisplay } from './lib/simulationDisplay.js';
import { getFixtureBoostState } from './lib/fixtureBoosts.js';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Bandage, X, TrendingUp, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, RefreshCw, Info } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import {
  fetchHeldAssetBalancesForAddresses,
  fetchHeldAssetIdsForAddresses,
} from './lib/indexer';
import { applyLiveLineupInjuries, applyLivePlayerDetails, buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import {
  fetchCurrentSeason,
  fetchGameCounter,
  fetchLeagueSeasonFixtures,
  fetchLeagueSeasonStats,
  fetchHistoricalLeagueTable,
  fetchLeagueTableTeams,
  fetchLeagueTeamsIndex,
  fetchSeasonTournamentFixtures,
  fetchTeamSeasonFixtures,
  fetchTeamLineup,
  fetchTeamBoostState,
  importOpponentFromTeamInput,
  normalizeSetPieceTaker,
  resolveOwnedTeamLeagues,
} from './lib/lostPigsTeamImport';
import {
  createEmptyTeamBoostState,
  createManualFallbackBoostState,
} from './lib/boosts';
import {
  getExpectedPointsFromOutcomePercentages,
} from './lib/matchProjection';
import { crossOriginForImageUrl, getGenericIpfsFallback, resolvePlayerImage } from './lib/assetImages';
import {
  BOOSTS,
  DR_DECAY,
  DR_MIN,
  FORMATIONS,
  OUT_OF_POSITION_SCALE,
  PLAYER_ROLES,
  SKILL_CURVE,
  TACTICS,
} from './lib/gameRules';

// --- Game Constants ---
const POSITIONS = {
  GK: { label: 'Goalkeeper', short: 'GK', color: 'from-yellow-500 to-yellow-600' },
  DF: { label: 'Defender', short: 'DF', color: 'from-blue-500 to-blue-600' },
  MF: { label: 'Midfielder', short: 'MF', color: 'from-emerald-500 to-emerald-600' },
  FW: { label: 'Forward', short: 'FW', color: 'from-red-500 to-red-600' },
};

const DEFAULT_TACTICS = {
  press: 'medium',
  tempo: 'normal',
  lineHeight: 'normal',
  setPieceTaker: '',
};

const normalizeTactics = (value) => ({
  ...DEFAULT_TACTICS,
  ...(value || {}),
});

const INJURIES = {
  None: { label: 'Healthy', reduction: 1.0, color: 'bg-green-500', text: 'text-green-400' },
  Low: { label: 'Minor (95%)', reduction: 0.95, color: 'bg-yellow-500', text: 'text-yellow-400' },
  Mid: { label: 'Moderate (90%)', reduction: 0.90, color: 'bg-orange-500', text: 'text-orange-400' },
  High: { label: 'Severe (85%)', reduction: 0.85, color: 'bg-red-600', text: 'text-red-400' },
};

// --- Math Functions ---
const getStat = (stats, key, fallbackKey = null) => {
  const value = Number(stats?.[key]);
  if (Number.isFinite(value) && value > 0) return value;
  if (!fallbackKey) return 0;
  const fallback = Number(stats?.[fallbackKey]);
  return Number.isFinite(fallback) ? fallback : 0;
};

const getBoostedStats = (stats, boostMults = {}) => ({
  SPD: getStat(stats, 'SPD') * (boostMults.SPD || 1),
  ATT: getStat(stats, 'ATT') * (boostMults.ATT || 1),
  CTL: getStat(stats, 'CTL') * (boostMults.CTL || 1),
  DEF: getStat(stats, 'DEF') * (boostMults.DEF || 1),
  GKP: getStat(stats, 'GKP') * (boostMults.GKP || 1),
  WRT: getStat(stats, 'WRT', 'SPD'),
  FIN: getStat(stats, 'FIN', 'ATT'),
  HDG: getStat(stats, 'HDG', 'ATT'),
  TEC: getStat(stats, 'TEC', 'CTL'),
  CMP: getStat(stats, 'CMP', 'CTL'),
  TCK: getStat(stats, 'TCK', 'DEF'),
});

const weightedRounded = (numerator, divisor) => {
  if (!divisor) return 0;
  return Math.round(numerator / divisor);
};

const applySkillCurve = (raw) => {
  if (raw <= 0) return SKILL_CURVE.floor;
  if (raw >= 100) return 100;
  return Math.max(SKILL_CURVE.floor, Math.pow(raw / 100, SKILL_CURVE.exponent) * 100);
};

const getRawControlScore = (stats, boostMults = {}, tacticsInput = DEFAULT_TACTICS) => {
  const boosted = getBoostedStats(stats, boostMults);
  const tactics = normalizeTactics(tacticsInput);
  if (tactics.press === 'high') {
    return weightedRounded((boosted.CTL * 3) + (boosted.WRT * 2), 5);
  }
  if (tactics.press === 'low') {
    return weightedRounded((boosted.CTL * 5) + boosted.WRT, 6);
  }
  return weightedRounded((boosted.CTL * 4) + boosted.WRT, 5);
};

const getControlScore = (stats, pos, injuryMod = 1.0, boostMults = {}, tacticsInput = DEFAULT_TACTICS) => (
  applySkillCurve(getRawControlScore(stats, boostMults, tacticsInput)) * injuryMod
);

const getAttackScoreForChance = (stats, chanceType = 'OpenPlay', injuryMod = 1.0, boostMults = {}) => {
  const boosted = getBoostedStats(stats, boostMults);
  let raw;
  switch (chanceType) {
    case 'Cross':
      raw = weightedRounded((boosted.ATT * 2) + (boosted.HDG * 2) + boosted.SPD, 5);
      break;
    case 'Corner':
      raw = weightedRounded((boosted.ATT * 2) + (boosted.HDG * 3), 5);
      break;
    case 'LongRange':
      raw = weightedRounded((boosted.ATT * 2) + (boosted.TEC * 3), 5);
      break;
    case 'FreeKick':
      raw = weightedRounded(boosted.ATT + (boosted.TEC * 3), 4);
      break;
    case 'Penalty':
      raw = weightedRounded((boosted.ATT * 2) + (boosted.CMP * 3), 5);
      break;
    case 'GoalKeeperShot':
      raw = weightedRounded(boosted.ATT + boosted.FIN + (boosted.SPD * 3), 5);
      break;
    case 'OpenPlay':
    default:
      raw = weightedRounded((boosted.ATT * 2) + boosted.FIN + boosted.SPD, 4);
      break;
  }
  return applySkillCurve(raw) * injuryMod;
};

const getAttackScore = (stats, pos, injuryMod = 1.0, boostMults = {}) =>
  getAttackScoreForChance(stats, 'OpenPlay', injuryMod, boostMults);

const getDefenseScore = (stats, pos, injuryMod = 1.0, boostMults = {}, tacticsInput = DEFAULT_TACTICS) => {
  const boosted = getBoostedStats(stats, boostMults);
  const tactics = normalizeTactics(tacticsInput);
  let raw;
  if (pos === 'GK') {
    raw = weightedRounded((boosted.GKP * 5) + boosted.SPD, 6);
  } else if (tactics.lineHeight === 'high') {
    raw = weightedRounded((boosted.DEF * 3) + (boosted.TCK * 2) + (boosted.SPD * 3), 8);
  } else if (tactics.lineHeight === 'deep') {
    raw = weightedRounded((boosted.DEF * 6) + (boosted.TCK * 2), 8);
  } else {
    raw = weightedRounded((boosted.DEF * 5) + (boosted.TCK * 2) + boosted.SPD, 8);
  }
  return applySkillCurve(raw) * injuryMod;
};

const getOfficialOvr = (stats, pos) => {
  if (pos === 'GK') return Math.round(((stats.GKP * 5) + stats.SPD) / 6);
  if (pos === 'DF') return Math.round(((stats.DEF * 5) + stats.SPD) / 6);
  if (pos === 'MF') return Math.round(((stats.CTL * 4) + stats.SPD) / 5);
  if (pos === 'FW') return Math.round(((stats.ATT * 3) + stats.SPD) / 4);
  return 0;
};

const hasPlayablePosition = (player, position) => {
  const valid = player.positions && player.positions.length > 0 ? player.positions : [player.pos];
  return valid.includes(position);
};

const captainQuality = (player) => {
  const stats = player?.stats || {};
  const primary = player?.pos === 'GK' ? getStat(stats, 'GKP') : getStat(stats, 'CTL');
  return (primary + getStat(stats, 'CMP', 'CTL')) / 2;
};

const assignLineupPositions = (players, structure) => {
  const slots = Object.entries(structure).flatMap(([pos, count]) => (
    Array.from({ length: count }, (_, index) => ({ pos, index }))
  ));
  if (players.length === 0 || slots.length === 0) return [];

  let best = null;
  let bestScore = -Infinity;
  const used = new Set();

  const backtrack = (slotIndex, current, score) => {
    if (slotIndex === slots.length || current.length === players.length) {
      if (score > bestScore) {
        bestScore = score;
        best = [...current];
      }
      return;
    }

    const slot = slots[slotIndex];
    const selectedPosition = slot.pos;
    for (const player of players) {
      if (used.has(player.id)) continue;
      used.add(player.id);
      const inPosition = hasPlayablePosition(player, selectedPosition);
      const fit = getOfficialOvr(player.stats, selectedPosition) + (inPosition ? 100 : 0);
      current.push({
        ...player,
        selectedPosition,
        slotIndex: slot.index,
        outOfPosition: !inPosition,
      });
      backtrack(slotIndex + 1, current, score + fit);
      current.pop();
      used.delete(player.id);
    }
  };

  backtrack(0, [], 0);
  return best || [];
};

const roughPlayerValue = (player) => (
  getOfficialOvr(player.stats, player.pos)
  + getStat(player.stats, 'WRT', 'SPD') * 0.08
  + getStat(player.stats, 'HDG', 'ATT') * 0.06
  + getStat(player.stats, 'TEC', 'CTL') * 0.06
  + getStat(player.stats, 'CMP', 'CTL') * 0.04
  + getStat(player.stats, 'TCK', 'DEF') * 0.06
);

const ROLE_ELIGIBLE_POSITIONS = {
  [PLAYER_ROLES.captain.value]: ['GK', 'DF', 'MF', 'FW'],
  [PLAYER_ROLES.targetMan.value]: ['FW'],
  [PLAYER_ROLES.playmaker.value]: ['MF'],
  [PLAYER_ROLES.ballWinner.value]: ['DF', 'MF'],
};

const isEligibleForRole = (player, roleValue) => {
  const eligiblePositions = ROLE_ELIGIBLE_POSITIONS[roleValue] || [];
  const selectedPosition = player.selectedPosition || player.pos;
  return eligiblePositions.includes(selectedPosition);
};

const positionPenaltyMod = (player) => (player.outOfPosition ? OUT_OF_POSITION_SCALE : 1);

const getRoleCandidateIds = (lineup, tactics) => ({
  captain: [...lineup]
    .filter((player) => isEligibleForRole(player, PLAYER_ROLES.captain.value))
    .sort((a, b) => captainQuality(b) - captainQuality(a))
    .slice(0, 3)
    .map((player) => player.id),
  targetMan: [...lineup]
    .filter((player) => isEligibleForRole(player, PLAYER_ROLES.targetMan.value))
    .sort((a, b) => (
      (getAttackScoreForChance(b.stats, 'Corner', positionPenaltyMod(b)) + getAttackScoreForChance(b.stats, 'Cross', positionPenaltyMod(b)))
      - (getAttackScoreForChance(a.stats, 'Corner', positionPenaltyMod(a)) + getAttackScoreForChance(a.stats, 'Cross', positionPenaltyMod(a)))
    ))
    .slice(0, 3)
    .map((player) => player.id),
  playmaker: [...lineup]
    .filter((player) => isEligibleForRole(player, PLAYER_ROLES.playmaker.value))
    .sort((a, b) => (
      getControlScore(b.stats, b.selectedPosition || b.pos, positionPenaltyMod(b), {}, tactics)
      - getControlScore(a.stats, a.selectedPosition || a.pos, positionPenaltyMod(a), {}, tactics)
    ))
    .slice(0, 3)
    .map((player) => player.id),
  ballWinner: [...lineup]
    .filter((player) => isEligibleForRole(player, PLAYER_ROLES.ballWinner.value))
    .sort((a, b) => (
      getDefenseScore(b.stats, b.selectedPosition || b.pos, positionPenaltyMod(b), {}, tactics)
      - getDefenseScore(a.stats, a.selectedPosition || a.pos, positionPenaltyMod(a), {}, tactics)
    ))
    .slice(0, 3)
    .map((player) => player.id),
});

const applyRolesToLineup = (lineup, roleById) => lineup.map((player) => ({
  ...player,
  role: roleById[String(player.id)] || '',
}));

const candidateRoles = (lineup, tactics, offset = 0) => {
  const candidates = getRoleCandidateIds(lineup, tactics);
  const roles = [['captain', PLAYER_ROLES.captain.value], ['targetMan', PLAYER_ROLES.targetMan.value], ['playmaker', PLAYER_ROLES.playmaker.value], ['ballWinner', PLAYER_ROLES.ballWinner.value]];
  const assigned = {};
  const used = new Set();
  for (const [name, role] of roles) {
    const ordered = [...candidates[name].slice(offset), ...candidates[name].slice(0, offset)];
    const id = ordered.find((candidate) => !used.has(String(candidate)) && (role !== PLAYER_ROLES.captain.value || captainQuality(lineup.find((p) => String(p.id) === String(candidate))) >= 60));
    if (id != null) { assigned[String(id)] = role; used.add(String(id)); }
  }
  return applyRolesToLineup(lineup, assigned);
};

const getSetPieceCandidates = (lineup) => [
  '',
  ...[...lineup]
    .sort((a, b) => (
      (getAttackScoreForChance(b.stats, 'FreeKick') + getAttackScoreForChance(b.stats, 'Penalty') + getStat(b.stats, 'TEC', 'CTL'))
      - (getAttackScoreForChance(a.stats, 'FreeKick') + getAttackScoreForChance(a.stats, 'Penalty') + getStat(a.stats, 'TEC', 'CTL'))
    ))
    .slice(0, 4)
    .map((player) => player.id),
];

const formatNumber = (value, decimals = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '0';
  return parsed.toFixed(decimals);
};

const formatOrdinal = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'N/A';
  const suffix = parsed % 100 >= 11 && parsed % 100 <= 13
    ? 'th'
    : parsed % 10 === 1
      ? 'st'
      : parsed % 10 === 2
        ? 'nd'
        : parsed % 10 === 3
          ? 'rd'
          : 'th';
  return `${parsed}${suffix}`;
};

const formatStatValue = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '0';
  return Math.abs(parsed) >= 10 ? String(Math.round(parsed)) : parsed.toFixed(1);
};

const getLineupCoverageGaps = (squad) => {
  const counts = { GK: 0, DF: 0, MF: 0, FW: 0 };

  squad.forEach((player) => {
    const positions = player.positions && player.positions.length > 0 ? player.positions : [player.pos];
    positions.forEach((position) => {
      if (counts[position] !== undefined) counts[position] += 1;
    });
  });

  let closestFormationGaps = null;

  Object.values(FORMATIONS).forEach((formation) => {
    const gaps = [];

    Object.entries(formation.structure).forEach(([position, requiredCount]) => {
      const deficit = requiredCount - counts[position];
      if (deficit > 0) {
        gaps.push(`${deficit} more ${POSITIONS[position]?.label || position}`);
      }
    });

    if (gaps.length === 0) {
      closestFormationGaps = [];
      return;
    }

    if (!closestFormationGaps
      || gaps.length < closestFormationGaps.length
      || (gaps.length === closestFormationGaps.length
        && gaps.join(', ').length < closestFormationGaps.join(', ').length)) {
      closestFormationGaps = gaps;
    }
  });

  return closestFormationGaps || [];
};

function getFormationRows(suggestion) {
  if (!suggestion?.formation || !Array.isArray(suggestion.lineup)) return [];
  const order = ['FW', 'MF', 'DF', 'GK'];
  const grouped = suggestion.lineup.reduce((acc, player) => {
    const pos = player.selectedPosition || player.pos;
    if (!acc[pos]) acc[pos] = [];
    acc[pos].push(player);
    return acc;
  }, {});

  return order
    .map((pos) => ({
      pos,
      label: POSITIONS[pos]?.label || pos,
      players: [...(grouped[pos] || [])].sort((a, b) => {
        const slotA = Number.isFinite(a.slotIndex) ? a.slotIndex : 0;
        const slotB = Number.isFinite(b.slotIndex) ? b.slotIndex : 0;
        return slotA - slotB;
      }),
    }))
    .filter((row) => row.players.length > 0);
}

const getSuggestionDetails = (suggestion) => {
  if (!suggestion?.formation) {
    return {
      formation: '',
      setPiecePlayer: null,
      roleLabels: [],
      rows: [],
    };
  }

  const setPiecePlayer = suggestion.tactics?.setPieceTaker
    ? suggestion.lineup.find((player) => String(player.id) === String(suggestion.tactics.setPieceTaker))
    : null;
  const roleLabels = suggestion.lineup
    .filter((player) => player.role)
    .map((player) => `${Object.values(PLAYER_ROLES).find((role) => role.value === player.role)?.label || player.role}: ${player.name}`);

  return {
    formation: FORMATIONS[suggestion.formation]?.name || suggestion.formation,
    setPiecePlayer,
    roleLabels,
    rows: getFormationRows(suggestion),
  };
};

// --- Initial Fallback Data ---
const initialMyTeam = [];

const initialOpponent = [];

const TEAM_BOOST_STATE_EMPTY = createEmptyTeamBoostState();

const getErrorMessage = (error, fallback = 'Failed to load boost data.') =>
  error instanceof Error ? error.message : fallback;

const getFixtureTimeValue = (fixture) => {
  const value = fixture?.game_time ? new Date(fixture.game_time).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
};

const hasFixtureStarted = (fixture, now = Date.now()) => {
  const fixtureTime = getFixtureTimeValue(fixture);
  return fixtureTime !== Number.MAX_SAFE_INTEGER && fixtureTime <= now;
};

const canSelectFixture = (fixture, now = Date.now()) => (
  Boolean(fixture)
  && !fixture.cup_bye
  && (Boolean(fixture.game_result) || !hasFixtureStarted(fixture, now))
);

const FIXTURE_NAV_BUTTON_CLASS = 'flex h-11 w-11 items-center justify-center rounded-md border border-[#2a3a50] bg-[#111620] text-[#9aa5bb] transition-[transform,background-color,border-color,color] duration-150 hover:border-[#00e676]/60 hover:bg-[#0f2a1b] hover:text-[#00e676] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e676]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161c28] active:scale-[0.96] disabled:cursor-not-allowed disabled:border-[#1e2a3a] disabled:text-[#46536a] disabled:hover:bg-[#111620]';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ITEM_USE_COOLDOWN_DAYS = 2;
const WALLET_SYNC_RETRY_DELAYS_MS = [500, 1500];

const getUtcDayExpiryTime = (startTime, durationDays) => {
  if (!Number.isFinite(startTime)) return startTime;
  const days = Math.max(0, Math.floor(Number(durationDays || 0)));
  if (days <= 0) return startTime;
  const date = new Date(startTime);
  const startUtcDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return startUtcDay + (days * MS_PER_DAY) - 1;
};

const formatFixtureTime = (value) => {
  if (!value) return 'Time TBC';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const getTimestamp = (value) => {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const formatDateTimeLocalValue = (value) => {
  const timestamp = getTimestamp(value);
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const getFixtureRound = (fixture) => {
  const parsed = Number(fixture?.sort_round ?? fixture?.game_round);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 999;
};

const getFixtureRoundLabel = (fixture) => {
  if (fixture?.competition === 'cup') {
    return fixture.cup_round_label || `Cup R${fixture.cup_round_number || '?'}`;
  }
  return `R${fixture?.game_round || '?'}`;
};

const sortFixturesByRoundAndTime = (fixturesToSort) => [...fixturesToSort].sort((a, b) => (
  getFixtureRound(a) - getFixtureRound(b)
  || getFixtureTimeValue(a) - getFixtureTimeValue(b)
  || String(a.game_key || '').localeCompare(String(b.game_key || ''))
));

const WALLET_ITEM_DEFINITIONS = [
  {
    key: 'MagicTruffle',
    assetId: '1246863021',
    boostKey: 'MagicTruffle',
    label: 'Magic Truffle',
    icon: '🍄',
    minDays: 1,
    maxDays: 3,
  },
  {
    key: 'GoldenTruffle',
    assetId: '1246863069',
    boostKey: 'GoldenTruffle',
    label: 'Golden Truffle',
    icon: '🟡',
    minDays: 3,
    maxDays: 5,
  },
  {
    key: 'IridiumTruffle',
    assetId: '2282991862',
    boostKey: 'IridiumTruffle',
    label: 'Iridium Truffle',
    icon: '💎',
    minDays: 3,
    maxDays: 5,
  },
  {
    key: 'HalftimeOrange',
    assetId: '1278938088',
    boostKey: 'HalftimeOrange',
    label: 'Half-time Orange',
    icon: '🍊',
    minDays: 3,
    maxDays: 5,
  },
  {
    key: 'MedicalKit',
    assetId: '2305115576',
    boostKey: null,
    label: 'Medical Kit',
    icon: '🩹',
    minDays: 0,
    maxDays: 0,
  },
];

const EMPTY_HELD_ITEMS = {};

const WALLET_ITEM_BY_ASSET_ID = Object.fromEntries(
  WALLET_ITEM_DEFINITIONS.map((definition) => [definition.assetId, definition]),
);

const buildHeldItemCounts = (heldAssetBalances) => {
  const items = {};

  for (const [assetId, amount] of heldAssetBalances.entries()) {
    const item = WALLET_ITEM_BY_ASSET_ID[String(assetId)];
    if (!item) continue;
    const current = items[item.key] || {
      ...item,
      count: 0,
      assetIds: [],
    };
    current.count += Number(amount || 0);
    current.assetIds.push(assetId);
    items[item.key] = current;
  }

  return items;
};

const getHeldPerformanceItems = (heldItems) => (
  Object.values(heldItems || {})
    .filter((item) => item.boostKey && item.count > 0 && BOOSTS[item.boostKey])
);

const createPlannedItemBoostState = ({ boostKey, effectivenessPct }) => {
  const state = createManualFallbackBoostState(boostKey, 1);
  return {
    ...state,
    source: 'live',
    daysBoosted: null,
    effectivenessPct,
  };
};

const getBoostEffectivenessForPlannedUse = (baseEffectivenessPct, plannedBoostedDays) => {
  const parsedBase = baseEffectivenessPct === null || baseEffectivenessPct === undefined
    ? Number.NaN
    : Number(baseEffectivenessPct);
  const base = Number.isFinite(parsedBase) ? parsedBase : 100;
  const decay = Math.max(DR_MIN, Math.pow(DR_DECAY, Math.max(0, Number(plannedBoostedDays) || 0)));
  return Math.max(0, Math.min(100, base * decay));
};

const getBoostEntry = (entry) => entry?.boost || entry || {};

const nearlyEqual = (a, b, epsilon = 0.0001) => Math.abs(Number(a) - Number(b)) <= epsilon;

const getLiveBoostItemDefinition = (entry) => {
  const boost = getBoostEntry(entry);
  const boostType = String(boost.boost_type || '').toLowerCase();
  const boostPosition = String(boost.boost_position || '').toLowerCase();
  const minBoost = Number(boost.min_boost);
  const maxBoost = Number(boost.max_boost);

  return WALLET_ITEM_DEFINITIONS.find((item) => {
    if (!item.boostKey) return false;
    const rule = BOOSTS[item.boostKey];
    if (!rule) return false;

    const expectedType = rule.type === 'CTL' ? 'Position Boost' : 'Team Boost';
    const expectedPosition = rule.type === 'CTL' ? 'midfield' : '';
    const typeMatches = expectedType === 'Team Boost'
      ? boostType.includes('team')
      : boostType.includes('position');

    return typeMatches
      && (expectedType !== 'Position Boost' || boostPosition === expectedPosition)
      && nearlyEqual(minBoost, rule.min)
      && nearlyEqual(maxBoost, rule.max);
  }) || null;
};

const readTimeField = (entry, fieldNames) => {
  const boost = getBoostEntry(entry);
  for (const source of [entry, boost]) {
    if (!source || typeof source !== 'object') continue;
    for (const fieldName of fieldNames) {
      const raw = source[fieldName];
      if (!raw) continue;
      const value = new Date(raw).getTime();
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
};

const getActiveBoostWindows = (teamBoostState, now = Date.now()) => {
  if (teamBoostState?.source !== 'live' || !Array.isArray(teamBoostState.boosts)) {
    return [];
  }

  return teamBoostState.boosts
    .map((entry, index) => {
      const item = getLiveBoostItemDefinition(entry);
      if (!item) return null;

      const startTime = readTimeField(entry, [
        'starts',
        'starts_at',
        'started_at',
        'start_time',
        'startedAt',
        'startTime',
        'activated_at',
        'activatedAt',
        'used_at',
        'usedAt',
        'created_at',
        'createdAt',
      ]) || now;
      const explicitEndTime = readTimeField(entry, [
        'expires',
        'expires_at',
        'expiresAt',
        'ends_at',
        'endsAt',
        'end_time',
        'endTime',
        'active_until',
        'activeUntil',
      ]);
      const maxDays = Math.max(0, Number(item.maxDays || 0));
      const endTime = explicitEndTime || getUtcDayExpiryTime(startTime, maxDays);

      return {
        key: `${item.key}-${index}`,
        ...item,
        startTime,
        endTime,
        explicitEndTime: Boolean(explicitEndTime),
        effectivenessPct: teamBoostState.effectivenessPct,
      };
    })
    .filter(Boolean);
};

const getBoostStateForFixture = (state, fixture) => (
  getFixtureBoostState(state, getFixtureTimeValue(fixture), TEAM_BOOST_STATE_EMPTY)
);

const getFixtureActiveBoost = (fixture, activeBoostWindows) => {
  if (!fixture || activeBoostWindows.length === 0) return null;
  const fixtureTime = getFixtureTimeValue(fixture);
  return activeBoostWindows.find((window) => (
    fixtureTime >= window.startTime
    && fixtureTime <= window.endTime
  )) || null;
};

export default function OinkSoccerCalc() {
  const { wallets } = useWallet();
  const persistedState = useMemo(() => loadCalculatorState(), []);
  const autoSyncedAddressKeyRef = useRef('');
  const walletSyncRunRef = useRef(0);

  const [importingTeamUrl, setImportingTeamUrl] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [leagueIndex, setLeagueIndex] = useState(null);
  const [leagueIndexLoading, setLeagueIndexLoading] = useState(false);
  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [selectedLeagueName, setSelectedLeagueName] = useState('');
  const [leagueTeams, setLeagueTeams] = useState([]);
  const [gameCounter, setGameCounter] = useState(null);
  const [fixtures, setFixtures] = useState([]);
  const [fixturesLoading, setFixturesLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [selectedFixtureKey, setSelectedFixtureKey] = useState('');
  const [seasonFixtures, setSeasonFixtures] = useState([]);
  const [teamSeasonFixtures, setTeamSeasonFixtures] = useState([]);
  const [seasonTeams, setSeasonTeams] = useState({});
  const [seasonPredictionLoading, setSeasonPredictionLoading] = useState(false);
  const [seasonPredictionError, setSeasonPredictionError] = useState('');
  const [seasonBoosts, setSeasonBoosts] = useState({});
  const [seasonItemHistory, setSeasonItemHistory] = useState(null);
  const [historicalFifth, setHistoricalFifth] = useState([]);
  const [pointsTarget, setPointsTarget] = useState('');
  const [detectedMyTeamIds, setDetectedMyTeamIds] = useState([]);
  const [ownedTeamModels, setOwnedTeamModels] = useState({});
  const [importedOpponentTeamId, setImportedOpponentTeamId] = useState(null);
  const [catalogSeason, setCatalogSeason] = useState(null);
  const [walletSyncing, setWalletSyncing] = useState(false);
  const [heldItems, setHeldItems] = useState(EMPTY_HELD_ITEMS);

  const initialOpponentPlayers = persistedState.opponentTeam || initialOpponent;
  const [mySquad, setMySquad] = useState(persistedState.mySquad || initialMyTeam); // Full roster
  const [myTeam, setMyTeam] = useState(persistedState.myTeam || initialMyTeam.slice(0, 5)); // Active 5
  const [opponentTeam, setOpponentTeam] = useState(initialOpponentPlayers);
  const [opponentLineupMeta, setOpponentLineupMeta] = useState({ isDefaultLineup: false });
  const [myForm, setMyForm] = useState(persistedState.myForm || 'Pyramid');
  const [oppForm, setOppForm] = useState(persistedState.oppForm || 'Pyramid');
  const [myTactics] = useState(normalizeTactics(persistedState.myTactics));
  const [oppTactics, setOppTactics] = useState(() => normalizeSetPieceTaker(normalizeTactics(persistedState.oppTactics), initialOpponentPlayers));

  const [myBoost] = useState(persistedState.myBoost || 'None');
  const [myBoostApps] = useState(persistedState.myBoostApps || 1);
  const [itemCooldownUntil, setItemCooldownUntil] = useState(persistedState.itemCooldownUntil || null);
  const [myBoostState, setMyBoostState] = useState(createManualFallbackBoostState(persistedState.myBoost || 'None', persistedState.myBoostApps || 1));
  const [oppBoostState, setOppBoostState] = useState(TEAM_BOOST_STATE_EMPTY);
  const [homeAdvantage, setHomeAdvantage] = useState(persistedState.homeAdvantage || 'home'); // 'home' or 'away'
  const [walletSyncMeta, setWalletSyncMeta] = useState(
    persistedState.walletSyncMeta || {
      lastSyncedAt: null,
      matchedCount: 0,
      unmatchedCount: 0,
      lastError: null,
    },
  );

  const [activeTab, setActiveTab] = useState('upcoming');
  const [editingId, setEditingId] = useState(null);
  const [formTarget, setFormTarget] = useState('mySquad');
  const [showManualForm, setShowManualForm] = useState(false);

  const [newPlayer, setNewPlayer] = useState({
    name: '', pos: 'FW',
    stats: { DEF: 50, CTL: 50, ATT: 50, SPD: 50, GKP: 0, WRT: 0, FIN: 0, HDG: 0, TEC: 0, CMP: 0, TCK: 0 },
    injury: null
  });

  const [autoSuggestions, setAutoSuggestions] = useState({});
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [autoError, setAutoError] = useState('');
  const [autoProgress, setAutoProgress] = useState('');
  const [injuryModalState, setInjuryModalState] = useState({
    open: false,
    playerId: null,
    teamType: null,
    selected: 'None',
    readOnly: false,
  });

  const connectedAddresses = useMemo(() => {
    const addresses = new Set();
    for (const wallet of wallets) {
      if (!wallet.isConnected) continue;
      for (const account of wallet.accounts) {
        addresses.add(account.address);
      }
    }
    return Array.from(addresses);
  }, [wallets]);

  const connectedAddressKey = useMemo(
    () => [...connectedAddresses].sort().join('|'),
    [connectedAddresses],
  );

  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => fixture.game_key === selectedFixtureKey) || null,
    [fixtures, selectedFixtureKey],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const displayedFixtures = useMemo(() => {
    if (connectedAddresses.length === 0) {
      return fixtures;
    }
    if (detectedMyTeamIds.length === 0) {
      return [];
    }
    const myTeams = new Set(detectedMyTeamIds);
    return fixtures.filter((fixture) => myTeams.has(fixture.home_team_id) || myTeams.has(fixture.away_team_id));
  }, [connectedAddresses.length, detectedMyTeamIds, fixtures]);

  const pastFixtures = useMemo(
    () => sortFixturesByRoundAndTime(displayedFixtures.filter((fixture) => (
      fixture.game_result || hasFixtureStarted(fixture, currentTime)
    ))),
    [currentTime, displayedFixtures],
  );

  const upcomingFixtures = useMemo(
    () => sortFixturesByRoundAndTime(displayedFixtures.filter((fixture) => (
      !fixture.game_result && !hasFixtureStarted(fixture, currentTime)
    ))),
    [currentTime, displayedFixtures],
  );

  const navigableFixtures = useMemo(
    () => sortFixturesByRoundAndTime(displayedFixtures.filter((fixture) => (
      canSelectFixture(fixture, currentTime)
    ))),
    [currentTime, displayedFixtures],
  );

  const selectedFixtureNavigationIndex = useMemo(
    () => navigableFixtures.findIndex((fixture) => fixture.game_key === selectedFixtureKey),
    [navigableFixtures, selectedFixtureKey],
  );

  const previousFixture = selectedFixtureNavigationIndex > 0
    ? navigableFixtures[selectedFixtureNavigationIndex - 1]
    : null;
  const nextFixture = selectedFixtureNavigationIndex >= 0
    && selectedFixtureNavigationIndex < navigableFixtures.length - 1
    ? navigableFixtures[selectedFixtureNavigationIndex + 1]
    : null;

  useEffect(() => {
    if (activeTab !== 'upcoming' || upcomingFixtures.length === 0 || detectedMyTeamIds.length === 0) {
      return undefined;
    }

    const myTeams = new Set(detectedMyTeamIds);
    const opponentIds = Array.from(new Set(
      upcomingFixtures
        .filter((fixture) => !fixture.cup_bye)
        .map((fixture) => {
          const isHome = myTeams.has(fixture.home_team_id);
          const isAway = myTeams.has(fixture.away_team_id);
          if (!isHome && !isAway) return null;
          return isHome ? fixture.away_team_id : fixture.home_team_id;
        })
        .filter((teamId) => teamId && !seasonTeams[teamId]),
    ));

    if (opponentIds.length === 0) {
      return undefined;
    }

    let cancelled = false;

    const loadUpcomingOpponents = async () => {
      const loadedEntries = await Promise.all(
        opponentIds.map(async (teamId) => {
          try {
            const lineup = await fetchTeamLineup(teamId);
            return [teamId, lineup];
          } catch (error) {
            return [teamId, { fetchError: getErrorMessage(error, 'Lineup unavailable.') }];
          }
        }),
      );

      if (cancelled) return;
      setSeasonTeams((current) => ({
        ...current,
        ...Object.fromEntries(loadedEntries),
      }));
    };

    void loadUpcomingOpponents();

    return () => {
      cancelled = true;
    };
  }, [activeTab, detectedMyTeamIds, seasonTeams, upcomingFixtures]);

  const fixtureSeason = gameCounter?.season || catalogSeason;
  const fixtureRounds = Math.max(1, Math.min(60, gameCounter?.games_per_season || 44));

  const getLeagueIdForTeamId = useCallback((teamId) => {
    if (!teamId || !leagueIndex?.allTeams) return null;
    const found = leagueIndex.allTeams.find((entry) => entry.teamId === teamId);
    return found?.leagueId || null;
  }, [leagueIndex]);

  const myTeamIdForBoosts = useMemo(() => {
    if (detectedMyTeamIds.length === 0) return null;
    if (!selectedLeagueId || !leagueIndex?.byLeague?.[selectedLeagueId]) {
      return detectedMyTeamIds[0] || null;
    }
    const leagueTeamIds = new Set((leagueIndex.byLeague[selectedLeagueId] || []).map((team) => team.teamId));
    return detectedMyTeamIds.find((teamId) => leagueTeamIds.has(teamId)) || detectedMyTeamIds[0] || null;
  }, [detectedMyTeamIds, leagueIndex, selectedLeagueId]);

  const opponentTeamIdForBoosts = useMemo(
    () => importedOpponentTeamId || null,
    [importedOpponentTeamId],
  );

  const myTeamLeagueIdForBoosts = useMemo(
    () => getLeagueIdForTeamId(myTeamIdForBoosts) || (selectedLeagueId ? String(selectedLeagueId) : null),
    [getLeagueIdForTeamId, myTeamIdForBoosts, selectedLeagueId],
  );

  const primaryOwnedTeamModel = myTeamIdForBoosts ? ownedTeamModels[myTeamIdForBoosts] || null : null;

  // The live team endpoint can be complete before the wallet catalog scan finishes.
  // Prefer the full wallet collection, but keep a complete owned lineup usable in the
  // meantime so the first selected fixture does not get stuck behind the sync.
  const selectedOwnedTeamId = useMemo(() => {
    const myTeams = new Set(detectedMyTeamIds);
    if (selectedFixture) {
      const homeOwned = myTeams.has(selectedFixture.home_team_id);
      const awayOwned = myTeams.has(selectedFixture.away_team_id);
      if (homeOwned && !awayOwned) return selectedFixture.home_team_id;
      if (awayOwned && !homeOwned) return selectedFixture.away_team_id;
    }
    return myTeamIdForBoosts;
  }, [detectedMyTeamIds, myTeamIdForBoosts, selectedFixture]);

  const liveOwnedLineupModel = useMemo(() => {
    const preferred = selectedOwnedTeamId ? ownedTeamModels[selectedOwnedTeamId] : null;
    if (preferred?.players?.length >= 5) return preferred;

    const completeOwnedModel = detectedMyTeamIds
      .map((teamId) => ownedTeamModels[teamId])
      .find((model) => model?.players?.length >= 5);
    return completeOwnedModel || preferred || primaryOwnedTeamModel;
  }, [detectedMyTeamIds, ownedTeamModels, primaryOwnedTeamModel, selectedOwnedTeamId]);

  const liveOwnedLineup = useMemo(
    () => (liveOwnedLineupModel?.players?.length >= 5 ? liveOwnedLineupModel.players : []),
    [liveOwnedLineupModel],
  );
  const effectiveMySquad = useMemo(() => {
    if (mySquad.length >= 5) return mySquad;
    if (liveOwnedLineup.length >= 5) return liveOwnedLineup;
    if (myTeam.length >= 5) return myTeam;
    return [];
  }, [liveOwnedLineup, mySquad, myTeam]);
  const effectiveMyTeam = useMemo(
    () => (myTeam.length >= 5 ? myTeam : liveOwnedLineup),
    [liveOwnedLineup, myTeam],
  );
  const setupFallbackLabel = mySquad.length >= 5
    ? ''
    : liveOwnedLineup.length >= 5
      ? 'Live team lineup'
      : myTeam.length >= 5
        ? 'Active lineup'
        : '';

  useEffect(() => {
    if (detectedMyTeamIds.length === 0) {
      setOwnedTeamModels({});
      return undefined;
    }

    let cancelled = false;

    const loadOwnedLineups = async () => {
      const entries = await Promise.all(
        detectedMyTeamIds.map(async (teamId) => {
          try {
            return [teamId, await fetchTeamLineup(teamId)];
          } catch (_) {
            return null;
          }
        }),
      );

      if (!cancelled) {
        setOwnedTeamModels(Object.fromEntries(entries.filter(Boolean)));
      }
    };

    void loadOwnedLineups();

    return () => {
      cancelled = true;
    };
  }, [activeTab, detectedMyTeamIds, walletSyncMeta.lastSyncedAt]);

  const oppTeamLeagueIdForBoosts = useMemo(
    () => getLeagueIdForTeamId(opponentTeamIdForBoosts) || (selectedLeagueId ? String(selectedLeagueId) : null),
    [getLeagueIdForTeamId, opponentTeamIdForBoosts, selectedLeagueId],
  );

  const hasLiveMyTeamBoosts = useMemo(() => (
    myBoostState.source === 'live'
    && Array.isArray(myBoostState.boosts)
    && myBoostState.boosts.length > 0
  ), [myBoostState]);

  const mySimulationBoostContext = useMemo(() => (
    hasLiveMyTeamBoosts
      ? selectedFixture && !selectedFixture.game_result ? getBoostStateForFixture(myBoostState, selectedFixture) : myBoostState
      : createManualFallbackBoostState(myBoost, myBoostApps, myBoostState.fetchError)
  ), [hasLiveMyTeamBoosts, myBoost, myBoostApps, myBoostState, selectedFixture]);

  const activeBoostWindows = useMemo(
    () => getActiveBoostWindows(myBoostState),
    [myBoostState],
  );

  const itemCooldownEndTime = useMemo(() => {
    const savedCooldownEndTime = getTimestamp(itemCooldownUntil);
    const liveCooldownEndTime = myBoostState?.source === 'live'
      ? getTimestamp(myBoostState.cooldownUntil)
      : null;
    const activeBoostCooldownEndTime = activeBoostWindows.reduce((latest, window) => (
      Number.isFinite(Number(window.endTime))
        ? Math.max(latest, Number(window.endTime) + (ITEM_USE_COOLDOWN_DAYS * MS_PER_DAY))
        : latest
    ), 0);
    const endTime = Math.max(savedCooldownEndTime || 0, liveCooldownEndTime || 0, activeBoostCooldownEndTime);
    return endTime > Date.now() ? endTime : null;
  }, [activeBoostWindows, itemCooldownUntil, myBoostState]);

  const oppBoostContext = useMemo(() => (
    oppBoostState.source === 'live'
      ? selectedFixture && !selectedFixture.game_result ? getBoostStateForFixture(oppBoostState, selectedFixture) : oppBoostState
      : createEmptyTeamBoostState(oppBoostState.fetchError)
  ), [oppBoostState, selectedFixture]);

  useEffect(() => {
    let cancelled = false;
    void loadPlayableCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setCatalogSeason(catalog?.season ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogSeason(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLeagueIndexLoading(true);

    void fetchLeagueTeamsIndex()
      .then((index) => {
        if (cancelled) return;
        setLeagueIndex(index);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load league teams.';
        setUploadStatus({ tone: 'error', message });
      })
      .finally(() => {
        if (!cancelled) {
          setLeagueIndexLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchGameCounter()
      .then((payload) => {
        if (cancelled) return;
        setGameCounter(payload);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load game round.';
        setUploadStatus({ tone: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!leagueIndex) return;

    let cancelled = false;

    const detectMyLeague = async () => {
      if (connectedAddresses.length === 0) {
        if (!cancelled) {
          setDetectedMyTeamIds([]);
        }
        return;
      }

      try {
        const heldAssetIds = await fetchHeldAssetIdsForAddresses(connectedAddresses);
        if (cancelled) return;

        const resolved = resolveOwnedTeamLeagues(heldAssetIds, leagueIndex);
        setDetectedMyTeamIds(resolved.ownedTeamIds);

        if (!selectedLeagueId && resolved.preferredLeagueId) {
          setSelectedLeagueId(resolved.preferredLeagueId);
        }
      } catch (_) {
        if (!cancelled) {
          setDetectedMyTeamIds([]);
        }
      }
    };

    void detectMyLeague();

    return () => {
      cancelled = true;
    };
  }, [connectedAddresses, leagueIndex, selectedLeagueId]);

  useEffect(() => {
    if (selectedLeagueId || connectedAddresses.length > 0 || !leagueIndex?.byLeague) return;
    const firstLeagueId = Object.keys(leagueIndex.byLeague).sort((a, b) => Number(a) - Number(b))[0];
    if (firstLeagueId) {
      setSelectedLeagueId(firstLeagueId);
    }
  }, [connectedAddresses.length, leagueIndex, selectedLeagueId]);

  useEffect(() => {
    if (!selectedLeagueId) {
      setLeagueTeams([]);
      setSelectedLeagueName('');
      return;
    }

    let cancelled = false;

    void fetchLeagueTableTeams(selectedLeagueId)
      .then((payload) => {
        if (cancelled) return;
        setLeagueTeams(payload.teams);
        setSelectedLeagueName(payload.leagueName);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load league table teams.';
        setUploadStatus({ tone: 'error', message });
        setLeagueTeams([]);
        setSelectedLeagueName('');
      })

    return () => {
      cancelled = true;
    };
  }, [selectedLeagueId]);

  useEffect(() => {
    if (!selectedLeagueId || !fixtureSeason) {
      setFixtures([]);
      setTeamSeasonFixtures([]);
      setSelectedFixtureKey('');
      return;
    }

    let cancelled = false;
    const fixtureTeamId = detectedMyTeamIds.find((teamId) => getLeagueIdForTeamId(teamId) === selectedLeagueId)
      || detectedMyTeamIds[0]
      || null;
    setFixturesLoading(true);

    const loadFixturePayload = async () => {
      if (fixtureTeamId) {
        try {
          const teamPayload = await fetchTeamSeasonFixtures({
            teamId: fixtureTeamId,
            leagueId: selectedLeagueId,
            season: fixtureSeason,
          });
          if (teamPayload.length > 0) {
            return {
              fixturesPayload: teamPayload,
              seasonPayload: teamPayload.filter((fixture) => fixture.competition !== 'cup'),
              teamPayload,
            };
          }
        } catch (_) {
          // Fall back to the league and cup feeds when the team feed is unavailable.
        }
      }

      const [leaguePayload, cupPayload] = await Promise.all([
        fetchLeagueSeasonFixtures({
          leagueId: selectedLeagueId,
          season: fixtureSeason,
          rounds: fixtureRounds,
        }),
        fetchSeasonTournamentFixtures({
          season: fixtureSeason,
          leagueRounds: fixtureRounds,
        }).catch(() => []),
      ]);

      return {
        fixturesPayload: [...leaguePayload, ...cupPayload],
        seasonPayload: leaguePayload,
        teamPayload: [],
      };
    };

    void loadFixturePayload()
      .then(({ fixturesPayload, seasonPayload, teamPayload }) => {
        if (cancelled) return;
        const payload = sortFixturesByRoundAndTime(
          fixturesPayload,
        );
        setFixtures(payload);
        setSeasonFixtures(seasonPayload);
        setTeamSeasonFixtures(sortFixturesByRoundAndTime(teamPayload));
        setSelectedFixtureKey((current) => (
          current && payload.some((fixture) => fixture.game_key === current)
            ? current
            : ''
        ));
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load fixtures.';
        setUploadStatus({ tone: 'error', message });
        setFixtures([]);
        setTeamSeasonFixtures([]);
        setSelectedFixtureKey('');
      })
      .finally(() => {
        if (!cancelled) {
          setFixturesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detectedMyTeamIds, fixtureRounds, fixtureSeason, getLeagueIdForTeamId, selectedLeagueId]);

  useEffect(() => {
    if (activeTab !== 'season' || !selectedLeagueId || !fixtureSeason) {
      return undefined;
    }

    let cancelled = false;
    setSeasonPredictionLoading(true);
    setSeasonPredictionError('');
    setSeasonBoosts({});
    setSeasonItemHistory(null);
    setHistoricalFifth([]);

    const loadSeasonPredictionInputs = async () => {
      const nextFixtures = await fetchLeagueSeasonFixtures({
        leagueId: selectedLeagueId,
        season: fixtureSeason,
        rounds: fixtureRounds,
      });

      if (cancelled) return;
      setSeasonFixtures(nextFixtures);

      const teamIds = Array.from(new Set(
        nextFixtures.flatMap((fixture) => [fixture.home_team_id, fixture.away_team_id]).filter(Boolean),
      ));
      const contextPromise = Promise.all([
        fetchLeagueSeasonStats(selectedLeagueId, fixtureSeason).catch(() => null),
        Promise.all(Array.from({ length: Math.min(5, Math.max(0, Number(fixtureSeason) - 1)) }, (_, index) => Number(fixtureSeason) - index - 1)
          .map(async (season) => {
            try {
              const rows = await fetchHistoricalLeagueTable(selectedLeagueId, season);
              return rows.length >= 5 && Number.isFinite(Number(rows[4].points)) ? { season, points: Number(rows[4].points) } : null;
            } catch { return null; }
          })),
      ]);
      const boostPromise = Promise.all(teamIds.map(async (teamId) => {
        try {
          return [teamId, await fetchTeamBoostState({ teamId, leagueId: selectedLeagueId, season: fixtureSeason })];
        } catch (error) {
          return [teamId, createEmptyTeamBoostState(getErrorMessage(error, 'Boost check unavailable.'))];
        }
      }));
      const loadedEntries = await Promise.all(
        teamIds.map(async (teamId) => {
          try {
            const lineup = await fetchTeamLineup(teamId);
            return [teamId, lineup];
          } catch (error) {
            return [teamId, { fetchError: getErrorMessage(error, 'Lineup unavailable.') }];
          }
        }),
      );

      if (cancelled) return;
      setSeasonTeams(Object.fromEntries(loadedEntries));
      const [boostEntries, [itemHistory, fifth]] = await Promise.all([boostPromise, contextPromise]);
      if (!cancelled) {
        setSeasonBoosts(Object.fromEntries(boostEntries));
        setSeasonItemHistory(itemHistory);
        setHistoricalFifth(fifth.filter(Boolean));
      }
    };

    void loadSeasonPredictionInputs()
      .catch((error) => {
        if (cancelled) return;
        setSeasonFixtures([]);
        setSeasonTeams({});
        setSeasonBoosts({});
        setSeasonPredictionError(getErrorMessage(error, 'Failed to load season prediction.'));
      })
      .finally(() => {
        if (!cancelled) {
          setSeasonPredictionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, fixtureRounds, fixtureSeason, selectedLeagueId]);

  useEffect(() => {
    let cancelled = false;

    const loadBoostStates = async () => {
      const myFallback = createManualFallbackBoostState(myBoost, myBoostApps);
      const oppFallback = createEmptyTeamBoostState();

      const canFetchMyTeam = Boolean(myTeamIdForBoosts && myTeamLeagueIdForBoosts);
      const canFetchOppTeam = Boolean(opponentTeam.length > 0 && opponentTeamIdForBoosts && oppTeamLeagueIdForBoosts);

      if (!canFetchMyTeam && !canFetchOppTeam) {
        if (!cancelled) {
          setMyBoostState(myFallback);
          setOppBoostState(oppFallback);
        }
        return;
      }

      try {
        const season = await fetchCurrentSeason();

        const myStatePromise = canFetchMyTeam
          ? fetchTeamBoostState({
            teamId: myTeamIdForBoosts,
            leagueId: myTeamLeagueIdForBoosts,
            season,
          }).catch((error) => createManualFallbackBoostState(myBoost, myBoostApps, getErrorMessage(error)))
          : Promise.resolve(myFallback);

        const oppStatePromise = canFetchOppTeam
          ? fetchTeamBoostState({
            teamId: opponentTeamIdForBoosts,
            leagueId: oppTeamLeagueIdForBoosts,
            season,
          }).catch((error) => createEmptyTeamBoostState(getErrorMessage(error)))
          : Promise.resolve(oppFallback);

        const [nextMyBoostState, nextOppBoostState] = await Promise.all([myStatePromise, oppStatePromise]);
        if (cancelled) return;
        setMyBoostState(nextMyBoostState);
        setOppBoostState(nextOppBoostState);
      } catch (error) {
        if (cancelled) return;
        const message = getErrorMessage(error);
        setMyBoostState(createManualFallbackBoostState(myBoost, myBoostApps, message));
        setOppBoostState(createEmptyTeamBoostState(message));
      }
    };

    void loadBoostStates();

    return () => {
      cancelled = true;
    };
  }, [
    myBoost,
    myBoostApps,
    myTeamIdForBoosts,
    myTeamLeagueIdForBoosts,
    opponentTeam.length,
    opponentTeamIdForBoosts,
    oppTeamLeagueIdForBoosts,
  ]);

  const saveToDb = useCallback((overrides = {}) => {
    saveCalculatorState({
      mySquad: overrides.mySquad !== undefined ? overrides.mySquad : mySquad,
      myTeam: overrides.myTeam !== undefined ? overrides.myTeam : myTeam,
      opponentTeam: overrides.opponentTeam !== undefined ? overrides.opponentTeam : opponentTeam,
      myForm: overrides.myForm !== undefined ? overrides.myForm : myForm,
      oppForm: overrides.oppForm !== undefined ? overrides.oppForm : oppForm,
      myTactics: overrides.myTactics !== undefined ? overrides.myTactics : myTactics,
      oppTactics: overrides.oppTactics !== undefined ? overrides.oppTactics : oppTactics,
      myBoost: overrides.myBoost !== undefined ? overrides.myBoost : myBoost,
      myBoostApps: overrides.myBoostApps !== undefined ? overrides.myBoostApps : myBoostApps,
      itemCooldownUntil: overrides.itemCooldownUntil !== undefined ? overrides.itemCooldownUntil : itemCooldownUntil,
      homeAdvantage: overrides.homeAdvantage !== undefined ? overrides.homeAdvantage : homeAdvantage,
      walletSyncMeta: overrides.walletSyncMeta !== undefined ? overrides.walletSyncMeta : walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myTactics, oppTactics, myBoost, myBoostApps, itemCooldownUntil, homeAdvantage, walletSyncMeta]);

  useEffect(() => {
    saveCalculatorState({
      mySquad,
      myTeam,
      opponentTeam,
      myForm,
      oppForm,
      myTactics,
      oppTactics,
      myBoost,
      myBoostApps,
      itemCooldownUntil,
      homeAdvantage,
      walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myTactics, oppTactics, myBoost, myBoostApps, itemCooldownUntil, homeAdvantage, walletSyncMeta]);

  const refreshOwnedTeamInjuries = useCallback(async ({
    squad = mySquad,
    team = myTeam,
    applyState = true,
    save = true,
  } = {}) => {
    if (detectedMyTeamIds.length === 0 || squad.length === 0) {
      return { nextSquad: squad, nextTeam: team, livePlayers: [], refreshedCount: 0 };
    }

    const liveLineups = await Promise.all(
      detectedMyTeamIds.map(async (teamId) => {
        try {
          const lineup = await fetchTeamLineup(teamId);
          return lineup.availablePlayers || lineup.players || [];
        } catch (_) {
          return [];
        }
      }),
    );

    const livePlayers = liveLineups.flat();
    if (livePlayers.length === 0) {
      return { nextSquad: squad, nextTeam: team, livePlayers, refreshedCount: 0 };
    }

    const nextSquad = applyLivePlayerDetails(applyLiveLineupInjuries(squad, livePlayers), livePlayers);
    const nextTeam = applyLivePlayerDetails(applyLiveLineupInjuries(team, livePlayers), livePlayers);

    if (applyState) {
      if (nextSquad !== squad) setMySquad(nextSquad);
      if (nextTeam !== team) setMyTeam(nextTeam);
    }
    if (save && (nextSquad !== squad || nextTeam !== team)) {
      saveToDb({ mySquad: nextSquad, myTeam: nextTeam });
    }

    return { nextSquad, nextTeam, livePlayers, refreshedCount: livePlayers.length };
  }, [detectedMyTeamIds, mySquad, myTeam, saveToDb]);

  const handleSyncWalletAssets = useCallback(async (addressesOverride = connectedAddresses) => {
    const requestedAddresses = Array.isArray(addressesOverride) ? addressesOverride : connectedAddresses;
    const addressesToSync = Array.from(new Set(requestedAddresses.filter(Boolean)));
    if (addressesToSync.length === 0 || walletSyncing) {
      return;
    }

    setWalletSyncing(true);
    const syncRun = walletSyncRunRef.current + 1;
    walletSyncRunRef.current = syncRun;
    const nextMeta = {
      ...walletSyncMeta,
      lastError: null,
    };
    setWalletSyncMeta(nextMeta);

    try {
      let catalogPayload;
      let heldAssetBalances;
      let lastError;
      for (let attempt = 0; attempt <= WALLET_SYNC_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          [catalogPayload, heldAssetBalances] = await Promise.all([
            loadPlayableCatalog(),
            fetchHeldAssetBalancesForAddresses(addressesToSync),
          ]);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const retryDelay = WALLET_SYNC_RETRY_DELAYS_MS[attempt];
          if (retryDelay === undefined) break;
          await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        }
      }
      if (lastError) throw lastError;

      const catalogByAssetId = catalogPayload?.assets || {};
      const heldAssetIds = new Set(heldAssetBalances.keys());
      const nextHeldItems = buildHeldItemCounts(heldAssetBalances);
      const { walletPlayers, matchedCount, unmatchedCount } = buildWalletPlayers(heldAssetIds, catalogByAssetId);
      const merged = mergeWalletPlayers({ mySquad, myTeam, walletPlayers });

      const updatedMeta = {
        lastSyncedAt: new Date().toISOString(),
        matchedCount,
        unmatchedCount,
        lastError: null,
      };

      // Show the wallet roster as soon as indexer/catalog data is ready. Live injury
      // details are an enhancement and must not hold the lineup behind another API call.
      setMySquad(merged.nextSquad);
      setMyTeam(merged.nextTeam);
      setHeldItems(nextHeldItems);
      setWalletSyncMeta(updatedMeta);
      saveToDb({ mySquad: merged.nextSquad, myTeam: merged.nextTeam, walletSyncMeta: updatedMeta });

      void refreshOwnedTeamInjuries({
        squad: merged.nextSquad,
        team: merged.nextTeam,
        applyState: false,
        save: false,
      }).then(({ livePlayers }) => {
        if (walletSyncRunRef.current !== syncRun || livePlayers.length === 0) return;
        setMySquad((current) => applyLiveLineupInjuries(current, livePlayers));
        setMyTeam((current) => applyLiveLineupInjuries(current, livePlayers));
      }).catch(() => {
        // Wallet data is already usable when the optional lineup refresh fails.
      });
    } catch (error) {
      const updatedMeta = {
        ...nextMeta,
        lastError: error instanceof Error ? error.message : 'Wallet sync failed',
      };
      setWalletSyncMeta(updatedMeta);
      saveToDb({ walletSyncMeta: updatedMeta });
    } finally {
      setWalletSyncing(false);
    }
  }, [connectedAddresses, mySquad, myTeam, refreshOwnedTeamInjuries, saveToDb, walletSyncMeta, walletSyncing]);

  useEffect(() => {
    if (detectedMyTeamIds.length === 0 || mySquad.length === 0) return;

    let cancelled = false;

    const refresh = async () => {
      const { nextSquad, nextTeam } = await refreshOwnedTeamInjuries({ applyState: false, save: false });
      if (cancelled) return;
      if (nextSquad !== mySquad) setMySquad(nextSquad);
      if (nextTeam !== myTeam) setMyTeam(nextTeam);
      if (nextSquad !== mySquad || nextTeam !== myTeam) {
        saveToDb({ mySquad: nextSquad, myTeam: nextTeam });
      }
    };

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [detectedMyTeamIds, refreshOwnedTeamInjuries, mySquad, mySquad.length, myTeam, saveToDb]);

  useEffect(() => {
    if (!connectedAddressKey) {
      autoSyncedAddressKeyRef.current = '';
      setHeldItems(EMPTY_HELD_ITEMS);
      return;
    }

    if (walletSyncing || autoSyncedAddressKeyRef.current === connectedAddressKey) {
      return;
    }

    autoSyncedAddressKeyRef.current = connectedAddressKey;
    void handleSyncWalletAssets(connectedAddresses);
  }, [connectedAddressKey, connectedAddresses, handleSyncWalletAssets, walletSyncing]);

  const importOpponentFromInput = useCallback(async (teamInput, { quiet = false } = {}) => {
    if (importingTeamUrl) return;

    setImportingTeamUrl(true);
    if (!quiet) {
      setUploadStatus({ tone: 'info', message: 'Fetching opponent lineup from Lost Pigs API...' });
    }

    try {
      const imported = await importOpponentFromTeamInput(teamInput);
      const nextFormation = imported.formationKey && FORMATIONS[imported.formationKey]
        ? imported.formationKey
        : oppForm;
      const nextTactics = normalizeTactics(imported.tactics);

      setImportedOpponentTeamId(imported.teamId || null);
      setOpponentLineupMeta({ isDefaultLineup: Boolean(imported.isDefaultLineup) });
      setOppForm(nextFormation);
      setOppTactics(nextTactics);
      setOpponentTeam(imported.players);
      saveToDb({ opponentTeam: imported.players, oppForm: nextFormation, oppTactics: nextTactics });

      if (!quiet) {
        const formationText = imported.formationKey
          ? ` Formation: ${FORMATIONS[imported.formationKey].name}.`
          : '';
        const defaultText = imported.isDefaultLineup ? ' Using default player lineup.' : '';

        setUploadStatus({
          tone: 'success',
          message: `Imported ${imported.players.length} opponent lineup players from ${imported.teamLabel}.${formationText}${defaultText}`,
        });
      }
    } catch (err) {
      setImportedOpponentTeamId(null);
      setOpponentLineupMeta({ isDefaultLineup: false });
      setOppTactics(DEFAULT_TACTICS);
      setOpponentTeam([]);
      saveToDb({ opponentTeam: [], oppTactics: DEFAULT_TACTICS });
      setUploadStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Team import failed.',
      });
    } finally {
      setImportingTeamUrl(false);
    }
  }, [importingTeamUrl, oppForm, saveToDb]);

  const handleSelectFixture = useCallback(async (fixture, { quiet = false } = {}) => {
    if (!fixture) return;
    const myTeams = new Set(detectedMyTeamIds);
    const isHome = myTeams.has(fixture.home_team_id);
    const isAway = myTeams.has(fixture.away_team_id);
    const opponentId = isHome
      ? fixture.away_team_id
      : isAway
        ? fixture.home_team_id
        : fixture.away_team_id;
    const nextHomeAdvantage = isAway ? 'away' : 'home';

    setSelectedFixtureKey(fixture.game_key || '');
    setHomeAdvantage(nextHomeAdvantage);
    setUploadStatus(null);
    setActiveTab('matchup');
    saveToDb({ homeAdvantage: nextHomeAdvantage });

    if (!opponentId) {
      if (!quiet) {
        setUploadStatus({ tone: 'error', message: 'Could not identify opponent from that fixture.' });
      }
      return;
    }

    await importOpponentFromInput(opponentId, { quiet: true });
  }, [detectedMyTeamIds, importOpponentFromInput, saveToDb]);

  const handleFormChange = (type, val) => {
    if (type === 'my') {
      setMyForm(val);
      saveToDb({ myForm: val });
    } else {
      setOppForm(val);
      saveToDb({ oppForm: val });
    }
  };

  const handleRoleChange = (player, role, teamType) => {
    const isMySide = teamType === 'myTeam' || teamType === 'mySquad';
    const normalizeRole = role === 'none' ? '' : role;

    if (isMySide) {
      const nextSquad = mySquad.map((item) => item.id === player.id ? { ...item, role: normalizeRole } : item);
      const nextTeam = myTeam.map((item) => item.id === player.id ? { ...item, role: normalizeRole } : item);
      setMySquad(nextSquad);
      setMyTeam(nextTeam);
      saveToDb({ mySquad: nextSquad, myTeam: nextTeam });
      return;
    }

    const nextOpponent = opponentTeam.map((item) => item.id === player.id ? { ...item, role: normalizeRole } : item);
    setOpponentTeam(nextOpponent);
    saveToDb({ opponentTeam: nextOpponent });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setNewPlayer({ name: '', pos: 'FW', stats: { DEF: 50, CTL: 50, ATT: 50, SPD: 50, GKP: 0, WRT: 0, FIN: 0, HDG: 0, TEC: 0, CMP: 0, TCK: 0 }, injury: null });
    setShowManualForm(false);
  };

  const handleSavePlayer = () => {
    const isMySquad = formTarget === 'mySquad';
    const currentList = isMySquad ? mySquad : opponentTeam;
    const existingPlayer = editingId ? currentList.find(item => item.id === editingId) : null;

    const p = {
      ...newPlayer,
      id: editingId || Date.now(),
      ovr: getOfficialOvr(newPlayer.stats, newPlayer.pos),
      injury: newPlayer.injury === 'None' ? null : newPlayer.injury,
      source: existingPlayer?.source || 'manual',
      role: existingPlayer?.role || '',
    };
    p.positions = existingPlayer?.positions || [p.pos];

    let newList;
    if (editingId) {
      newList = currentList.map(item => item.id === editingId ? p : item);
      if (isMySquad) {
        const newActive = myTeam.map(item => item.id === editingId ? p : item);
        setMyTeam(newActive);
        saveToDb({ myTeam: newActive });
      }
    } else {
      newList = [...currentList, p];
    }

    if (isMySquad) {
      setMySquad(newList);
      saveToDb({ mySquad: newList });
    } else {
      setOpponentTeam(newList);
      saveToDb({ opponentTeam: newList });
    }

    handleCancelEdit();
  };

  const handleStatChange = (k, v) => setNewPlayer(prev => ({ ...prev, stats: { ...prev.stats, [k]: parseInt(v) || 0 } }));

  const handleInjuryChange = useCallback((player, severity, teamType) => {
    const isMySide = teamType === 'myTeam' || teamType === 'mySquad';

    if (isMySide) {
      const newSquad = mySquad.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setMySquad(newSquad);
      const newActive = myTeam.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setMyTeam(newActive);

      saveToDb({ mySquad: newSquad, myTeam: newActive });
    } else {
      const newList = opponentTeam.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setOpponentTeam(newList);
      saveToDb({ opponentTeam: newList });
    }
  }, [mySquad, myTeam, opponentTeam, saveToDb]);

  const getCombinations = useCallback((arr, k) => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];
    const [first, ...rest] = arr;
    const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = getCombinations(rest, k);
    return [...withFirst, ...withoutFirst];
  }, []);

  const buildSettingsCandidates = useCallback(() => {
    const pools = { GK: [], DF: [], MF: [], FW: [] };
    effectiveMySquad.forEach((player) => (player.positions?.length ? player.positions : [player.pos]).forEach((pos) => pools[pos]?.push(player)));
    Object.keys(pools).forEach((pos) => { pools[pos] = pools[pos].sort((a, b) => roughPlayerValue(b) - roughPlayerValue(a)).slice(0, 8); });
    const tactics = ['low', 'medium', 'high'].flatMap((press) => ['slow', 'normal', 'fast'].flatMap((tempo) => ['deep', 'normal', 'high'].map((lineHeight) => ({ press, tempo, lineHeight }))));
    const candidates = [];
    Object.entries(FORMATIONS).forEach(([formation, { structure }]) => {
      const combos = Object.entries(structure).map(([pos, count]) => getCombinations(pools[pos], count));
      const lineups = [];
      const walk = (index, chosen) => {
        if (index === combos.length) {
          if (new Set(chosen.map((p) => String(p.assetId || p.id))).size === chosen.length) lineups.push(chosen);
          return;
        }
        combos[index].forEach((players) => walk(index + 1, [...chosen, ...players]));
      };
      walk(0, []);
      const seen = new Set();
      lineups.sort((a, b) => b.reduce((sum, p) => sum + roughPlayerValue(p), 0) - a.reduce((sum, p) => sum + roughPlayerValue(p), 0));
      const unique = lineups.filter((lineup) => { const key = lineup.map((p) => String(p.assetId || p.id)).sort().join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
      const shortlist = unique.slice(0, 3);
      effectiveMySquad.forEach((player) => {
        if (shortlist.length >= 8 || shortlist.some((lineup) => lineup.some((p) => String(p.assetId || p.id) === String(player.assetId || player.id)))) return;
        const alternative = unique.find((lineup) => lineup.some((p) => String(p.assetId || p.id) === String(player.assetId || player.id)));
        if (alternative) shortlist.push(alternative);
      });
      shortlist.forEach((players, lineupIndex) => {
        const assigned = assignLineupPositions(players, structure);
        const tacticShortlist = lineupIndex < 3 ? tactics : tactics.filter((_, index) => (index + Math.floor(index / 3) + lineupIndex) % 3 === 0);
        tacticShortlist.forEach((tactic) => {
          [0, 1].forEach((roleOffset) => {
            const lineup = candidateRoles(assigned, tactic, roleOffset);
            getSetPieceCandidates(lineup).slice(1, 3).forEach((setPieceTaker) => {
              candidates.push({ formation, lineup, tactics: { ...tactic, setPieceTaker } });
            });
          });
        });
      });
    });
    return candidates;
  }, [effectiveMySquad, getCombinations]);

  useEffect(() => {
    if (activeTab !== 'matchup' || effectiveMySquad.length < 5 || opponentTeam.length < 5 || !selectedFixture || selectedFixture.game_result || importingTeamUrl) {
      setAutoSuggestions({}); setAutoAnalyzing(false); return undefined;
    }
    let worker;
    setAutoSuggestions({}); setAutoError(''); setAutoProgress('Preparing candidates…'); setAutoAnalyzing(true);
    const timeoutId = window.setTimeout(() => {
      const candidates = buildSettingsCandidates();
      const opponentPlayers = opponentTeam.every((player) => player.selectedPosition) ? opponentTeam : assignLineupPositions(opponentTeam, FORMATIONS[oppForm].structure);
      const opponent = engineLineup(opponentPlayers, oppForm, oppTactics, engineBoosts(oppBoostContext, DR_DECAY, DR_MIN));
      const myHome = homeAdvantage === 'home';
      const boosts = engineBoosts(mySimulationBoostContext, DR_DECAY, DR_MIN);
      if (!candidates.length) { setAutoAnalyzing(false); return; }
      const makeJob = (candidate, key, trials, seed) => {
        const own = engineLineup(candidate.lineup, candidate.formation, candidate.tactics, boosts);
        return { key: String(key), request: { home: myHome ? own : opponent, away: myHome ? opponent : own, myHome, trials, seed, scenarios: [{ key: 'baseline', boosts }] } };
      };
      worker = new Worker(new URL('./lib/simulationWorker.js', import.meta.url), { type: 'module' });
      let screening = true;
      worker.onmessage = ({ data }) => {
        if (data.error) { setAutoError(data.error); setAutoAnalyzing(false); worker.terminate(); return; }
        if (!data.batchResults) { if (data.progress === data.total || data.progress % 20 === 0) setAutoProgress(`${screening ? 'Screening' : 'Checking finalists'} ${data.progress}/${data.total}`); return; }
        if (data.batchResults.some((job) => job.error)) { setAutoError('A candidate simulation failed; try selecting the fixture again.'); setAutoAnalyzing(false); worker.terminate(); return; }
        const scored = data.batchResults.flatMap(({ key, results: rows, error }) => {
          const row = rows[0];
          const candidate = candidates[Number(key)];
          return !error && row?.trials && candidate ? [{ key, candidate, row, value: (3 * row.wins + row.draws) / row.trials }] : [];
        }).sort((a, b) => b.value - a.value);
        if (screening) {
          screening = false;
          setAutoProgress('Checking finalists…');
          const counts = {};
          const finalists = scored.filter(({ candidate }) => { counts[candidate.formation] = (counts[candidate.formation] || 0) + 1; return counts[candidate.formation] <= 3; });
          if (!finalists.length) { setAutoAnalyzing(false); worker.terminate(); return; }
          worker.postMessage({ baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, jobs: finalists.map(({ candidate, key }) => makeJob(candidate, key, 5000, 1729)) });
          return;
        }
        const results = {};
        scored.forEach(({ candidate, row }) => {
          if (results[candidate.formation]) return;
          results[candidate.formation] = { ...candidate, win: 100 * row.wins / row.trials, draw: 100 * row.draws / row.trials, loss: 100 * row.losses / row.trials, myxG: row.goalsFor / row.trials, oppxG: row.goalsAgainst / row.trials };
        });
        setAutoSuggestions(results); setAutoAnalyzing(false); worker.terminate();
      };
      worker.onerror = () => { setAutoError('Setup simulation failed; try selecting the fixture again.'); setAutoAnalyzing(false); worker.terminate(); };
      worker.postMessage({ baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, jobs: candidates.map((candidate, index) => makeJob(candidate, index, 200, 8119)) });
    }, 120);
    return () => { window.clearTimeout(timeoutId); worker?.terminate(); };
  }, [activeTab, buildSettingsCandidates, effectiveMySquad.length, opponentTeam, selectedFixture, importingTeamUrl, oppForm, oppTactics, oppBoostContext, homeAdvantage, mySimulationBoostContext]);

  const tabItems = useMemo(() => ([
    { key: 'upcoming', icon: '📅', label: 'Upcoming' },
    { key: 'matchup', icon: '⚽', label: 'Setup' },
    { key: 'season', icon: '📈', label: 'Season' },
  ]), []);

  const activeSuggestions = autoSuggestions;

  const activeSuggestionList = useMemo(() => (
    Object.values(activeSuggestions)
      .filter((suggestion) => suggestion?.formation)
      .sort((a, b) => (3 * b.win + b.draw) - (3 * a.win + a.draw))
  ), [activeSuggestions]);

  const topSuggestion = activeSuggestionList[0] || null;

  const activeBoostsByFixture = useMemo(() => {
    if (activeBoostWindows.length === 0 || upcomingFixtures.length === 0 || detectedMyTeamIds.length === 0) {
      return {};
    }

    const myTeams = new Set(detectedMyTeamIds);
    const byFixture = {};
    upcomingFixtures.forEach((fixture) => {
      if (fixture.cup_bye) return;
      if (!myTeams.has(fixture.home_team_id) && !myTeams.has(fixture.away_team_id)) return;
      const activeBoost = getFixtureActiveBoost(fixture, activeBoostWindows);
      if (!activeBoost || !fixture.game_key) return;
      byFixture[fixture.game_key] = activeBoost;
    });
    return byFixture;
  }, [activeBoostWindows, detectedMyTeamIds, upcomingFixtures]);

  const activeBoostSummaryRows = useMemo(() => (
    activeBoostWindows.map((window) => {
      const fixtureCount = Object.values(activeBoostsByFixture)
        .filter((activeBoost) => activeBoost.key === window.key)
        .length;
      return {
        ...window,
        fixtureCount,
      };
    })
  ), [activeBoostWindows, activeBoostsByFixture]);

  // Season jobs use each team's actual formation slots and only boosts known to
  // cover the fixture. Keep the fingerprint with the results to prevent stale
  // forecasts from being reused after lineups or fixtures change.
  const seasonEngineJobs = useMemo(() => {
    if (seasonPredictionLoading) return [];
    const mine = new Set(detectedMyTeamIds);
    const itemDefs = getHeldPerformanceItems(heldItems);
    const fixtures = [...new Map([...seasonFixtures, ...teamSeasonFixtures].filter((f) => !f.game_result && !f.cup_bye && f.game_key).map((f) => [String(f.game_key), f])).values()];
    const firstOwned = new Set(sortFixturesByRoundAndTime(fixtures.filter((f) => mine.has(f.home_team_id) || mine.has(f.away_team_id))).slice(0, 6).map((f) => String(f.game_key)));
    return fixtures.flatMap((fixture) => {
      const buildTeam = (teamId) => {
        const model = ownedTeamModels[teamId]?.players?.length >= 5 ? ownedTeamModels[teamId] : seasonTeams[teamId];
        if (!model?.players || model.players.length !== 5) return null;
        const formation = FORMATIONS[model.formationKey] ? model.formationKey : 'Pyramid';
        const players = model.players.every((player) => player.selectedPosition) ? model.players : assignLineupPositions(model.players, FORMATIONS[formation].structure);
        return engineLineup(players, formation, normalizeTactics(model.tactics), engineBoosts(getBoostStateForFixture(seasonBoosts[teamId], fixture), DR_DECAY, DR_MIN));
      };
      const home = buildTeam(fixture.home_team_id);
      const away = buildTeam(fixture.away_team_id);
      if (!home || !away) return [];
      const id = String(fixture.game_key);
      const baseline = { key: id, request: { home, away, myHome: true, trials: 1000, seed: 1729, scenarios: [{ key: 'baseline', boosts: home.item_boosts }] } };
      const myHome = mine.has(fixture.home_team_id);
      if (myHome === mine.has(fixture.away_team_id)) return [baseline];
      const ownBoosts = (myHome ? home : away).item_boosts;
      const exactEffectiveness = Math.max(0, Math.min(100, Number(myBoostState.effectivenessPct ?? 100)));
      const levels = [...new Set([0, 25, 50, 75, 100, exactEffectiveness])];
      const scenarios = [{ key: 'baseline', boosts: ownBoosts }, ...itemDefs.flatMap((item) => levels.map((effectivenessPct) => ({ key: `${item.boostKey}:${effectivenessPct}`, boosts: engineBoosts(createPlannedItemBoostState({ boostKey: item.boostKey, effectivenessPct }), DR_DECAY, DR_MIN) })))];
      const jobs = [];
      for (let index = 0; index < scenarios.length; index += 10) {
        jobs.push({ key: `own:${id}:${index}`, request: { home, away, myHome, trials: 1000, seed: 1729, scenarios: scenarios.slice(index, index + 10) } });
      }
      if (firstOwned.has(id)) {
        const ownId = myHome ? fixture.home_team_id : fixture.away_team_id;
        const model = ownedTeamModels[ownId]?.players?.length >= 5 ? ownedTeamModels[ownId] : seasonTeams[ownId];
        const formation = FORMATIONS[model?.formationKey] ? model.formationKey : 'Pyramid';
        const current = model.players.every((p) => p.selectedPosition) ? model.players : assignLineupPositions(model.players, FORMATIONS[formation].structure);
        const identity = (p) => String(p.assetId || p.id);
        const selected = new Set(current.map(identity));
        current.forEach((out) => effectiveMySquad.forEach((candidate) => {
          const pos = out.selectedPosition || out.pos;
          if (selected.has(identity(candidate)) || !(candidate.positions?.length ? candidate.positions : [candidate.pos]).includes(pos)) return;
          const replacement = { ...candidate, selectedPosition: pos, role: isEligibleForRole({ ...candidate, selectedPosition: pos }, out.role) ? out.role : '' };
          const players = current.map((p) => identity(p) === identity(out) ? replacement : p);
          const tactics = normalizeTactics(model.tactics);
          if (String(tactics.setPieceTaker) === String(out.id)) tactics.setPieceTaker = '';
          const ownLineup = engineLineup(players, formation, tactics, ownBoosts);
          jobs.push({ key: `swap:${id}:${jobs.length}`, swap: { fixture: id, out: out.name, candidate: candidate.name }, request: { home: myHome ? ownLineup : home, away: myHome ? away : ownLineup, myHome, trials: 1000, seed: 1729, scenarios: [{ key: 'baseline', boosts: ownBoosts }] } });
        }));
      }
      return [...jobs, baseline];
    });
  }, [seasonPredictionLoading, seasonFixtures, teamSeasonFixtures, seasonTeams, ownedTeamModels, seasonBoosts, detectedMyTeamIds, heldItems, myBoostState.effectivenessPct, effectiveMySquad]);
  const seasonEngineFingerprint = JSON.stringify(seasonEngineJobs);
  const completedSeasonFingerprint = useRef('');
  const [seasonEngine, setSeasonEngine] = useState({ fingerprint: '', status: 'idle', results: {}, progress: 0, total: 0, error: '' });
  useEffect(() => {
    if (activeTab !== 'season' || !seasonEngineJobs.length || completedSeasonFingerprint.current === seasonEngineFingerprint) return undefined;
    const worker = new Worker(new URL('./lib/simulationWorker.js', import.meta.url), { type: 'module' });
    setSeasonEngine({ fingerprint: seasonEngineFingerprint, status: 'running', results: {}, progress: 0, total: seasonEngineJobs.length, error: '' });
    worker.onmessage = ({ data }) => {
      if (data.error) { setSeasonEngine({ fingerprint: seasonEngineFingerprint, status: 'error', results: {}, progress: 0, total: seasonEngineJobs.length, error: data.error }); worker.terminate(); return; }
      if (!data.batchResults) { setSeasonEngine((state) => ({ ...state, progress: data.progress || 0 })); return; }
      const failures = data.batchResults.filter((job) => job.error);
      const results = Object.fromEntries(data.batchResults.filter((job) => !job.error && job.results?.length).map((job) => [job.key, job.results]));
      if (!failures.length) completedSeasonFingerprint.current = seasonEngineFingerprint;
      setSeasonEngine({ fingerprint: seasonEngineFingerprint, status: failures.length ? 'error' : 'done', results, progress: data.batchResults.length, total: seasonEngineJobs.length, error: failures.length ? `${failures.length} fixture simulations failed.` : '' });
      worker.terminate();
    };
    worker.onerror = () => { setSeasonEngine({ fingerprint: seasonEngineFingerprint, status: 'error', results: {}, progress: 0, total: seasonEngineJobs.length, error: 'Season simulation failed.' }); worker.terminate(); };
    worker.postMessage({ baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, jobs: seasonEngineJobs });
    return () => worker.terminate();
  }, [activeTab, seasonEngineFingerprint, seasonEngineJobs]);
  const seasonEngineResults = useMemo(() => seasonEngine.fingerprint === seasonEngineFingerprint ? seasonEngine.results : {}, [seasonEngine, seasonEngineFingerprint]);
  const ownSimulationIndex = useMemo(() => indexOwnResults(seasonEngineResults), [seasonEngineResults]);
  const simulatedFixture = useCallback((fixture, own, boostKey = '', effectiveness = 100) => fixtureProjection(seasonEngineResults, ownSimulationIndex, String(fixture.game_key), own, boostKey, effectiveness), [seasonEngineResults, ownSimulationIndex]);

  const fixtureWinChances = useMemo(() => {
    const ids = new Set(detectedMyTeamIds);
    return Object.fromEntries(upcomingFixtures.flatMap((fixture) => {
      const own = ids.has(fixture.home_team_id) || ids.has(fixture.away_team_id);
      const result = own && simulatedFixture(fixture, true);
      return result ? [[fixture.game_key, { ...result, source: 'current' }]] : [];
    }));
  }, [detectedMyTeamIds, upcomingFixtures, simulatedFixture]);

  const catalogOutOfDate = Boolean(gameCounter?.season && catalogSeason && Number(gameCounter.season) !== Number(catalogSeason));

  const simulationWorkerRef = useRef(null);
  const [engineSimulation, setEngineSimulation] = useState({ status: 'idle', fingerprint: '', results: [], error: '' });
  useEffect(() => () => simulationWorkerRef.current?.terminate(), []);

  const engineRequest = useMemo(() => {
    if (!selectedFixture || selectedFixture.game_result || effectiveMyTeam.length < 5 || opponentTeam.length < 5 || importingTeamUrl || autoAnalyzing) return null;
    const formation = topSuggestion?.formation || myForm;
    const tactics = topSuggestion?.tactics || myTactics;
    const ownPlayers = topSuggestion?.lineup || effectiveMyTeam;
    const myPlayers = ownPlayers.every((player) => player.selectedPosition) ? ownPlayers : assignLineupPositions(ownPlayers, FORMATIONS[formation].structure);
    const opponents = opponentTeam.every((player) => player.selectedPosition) ? opponentTeam : assignLineupPositions(opponentTeam, FORMATIONS[oppForm].structure);
    const myBoosts = engineBoosts(mySimulationBoostContext, DR_DECAY, DR_MIN);
    const opponentBoosts = engineBoosts(oppBoostContext, DR_DECAY, DR_MIN);
    const myLineup = engineLineup(myPlayers, formation, tactics, myBoosts);
    const opponentLineup = engineLineup(opponents, oppForm, oppTactics, opponentBoosts);
    const myHome = homeAdvantage === 'home';
    const effectiveness = myBoostState.source === 'live' && myBoostState.effectivenessPct != null && Number.isFinite(Number(myBoostState.effectivenessPct)) ? Number(myBoostState.effectivenessPct) : 100;
    const scenarios = [{ key: 'baseline', boosts: myBoosts }, ...getHeldPerformanceItems(heldItems).map((item) => ({
      key: item.boostKey, boosts: engineBoosts(createPlannedItemBoostState({ boostKey: item.boostKey, effectivenessPct: effectiveness }), DR_DECAY, DR_MIN),
    }))];
    return { home: myHome ? myLineup : opponentLineup, away: myHome ? opponentLineup : myLineup, myHome, trials: 5000, seed: 424242, scenarios };
  }, [selectedFixture, effectiveMyTeam, opponentTeam, importingTeamUrl, autoAnalyzing, topSuggestion, myForm, myTactics, mySimulationBoostContext, oppBoostContext, oppForm, oppTactics, homeAdvantage, myBoostState, heldItems]);
  const engineFingerprint = engineRequest ? JSON.stringify(engineRequest) : '';
  const runEngineSimulation = useCallback(() => {
    if (!engineRequest) return;
    simulationWorkerRef.current?.terminate();
    const worker = new Worker(new URL('./lib/simulationWorker.js', import.meta.url), { type: 'module' });
    simulationWorkerRef.current = worker;
    setEngineSimulation({ status: 'running', fingerprint: engineFingerprint, results: [], error: '' });
    worker.onmessage = ({ data }) => {
      if (simulationWorkerRef.current !== worker) return;
      setEngineSimulation({ status: data.error ? 'error' : 'done', fingerprint: engineFingerprint, results: data.results || [], error: data.error || '' });
      worker.terminate();
      simulationWorkerRef.current = null;
    };
    worker.onerror = () => {
      if (simulationWorkerRef.current !== worker) return;
      setEngineSimulation({ status: 'error', fingerprint: engineFingerprint, results: [], error: 'Could not run the game engine. Try again.' });
      worker.terminate();
      simulationWorkerRef.current = null;
    };
    worker.postMessage({ baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, request: engineRequest });
  }, [engineRequest, engineFingerprint]);
  useEffect(() => {
    if (activeTab !== 'matchup' || !engineRequest) return undefined;
    runEngineSimulation();
    return () => {
      simulationWorkerRef.current?.terminate();
      simulationWorkerRef.current = null;
    };
  }, [activeTab, engineRequest, runEngineSimulation]);
  const currentEngineSimulation = engineSimulation.fingerprint === engineFingerprint ? engineSimulation : { status: 'idle', results: [], error: '' };

  const headlineProjection = selectMatchupDisplay({}, currentEngineSimulation, engineFingerprint, activeTab);
  const forecastWin = Number.parseFloat(headlineProjection.win) || 0;
  const forecastDraw = Number.parseFloat(headlineProjection.draw) || 0;
  const forecastLoss = Number.parseFloat(headlineProjection.loss) || 0;
  const hasLineups = headlineProjection.source === 'engine';
  const displayedWin = hasLineups ? `${headlineProjection.win}%` : '—';
  const displayedForecastWin = hasLineups ? forecastWin : 0;
  const displayedForecastDraw = hasLineups ? forecastDraw : 0;
  const displayedForecastLoss = hasLineups ? forecastLoss : 0;


  const opponentPitchSuggestion = useMemo(() => {
    if (opponentTeam.length === 0 || !FORMATIONS[oppForm]) return null;
    return {
      formation: oppForm,
      lineup: assignLineupPositions(opponentTeam, FORMATIONS[oppForm].structure),
      tactics: normalizeTactics(oppTactics),
      isDefaultLineup: opponentLineupMeta.isDefaultLineup,
    };
  }, [oppForm, oppTactics, opponentLineupMeta.isDefaultLineup, opponentTeam]);

  const seasonDecisionContext = useMemo(() => {
    const myIds = new Set(detectedMyTeamIds);
    const mine = leagueTeams.find((team) => myIds.has(team.teamId));
    const leagueMatches = seasonFixtures.filter((fixture) => myIds.has(fixture.home_team_id) || myIds.has(fixture.away_team_id));
    const remaining = leagueMatches.filter((fixture) => !fixture.game_result).length;
    const historyValues = historicalFifth.map((row) => row.points);
    const suggested = historyValues.length ? Math.ceil(historyValues.reduce((sum, value) => sum + value, 0) / historyValues.length) : null;
    const inputTarget = Number(pointsTarget);
    const target = pointsTarget !== '' && Number.isFinite(inputTarget) && inputTarget >= 0 ? inputTarget : suggested;
    const points = Number(mine?.currentPoints);
    const needed = Number.isFinite(points) && target !== null ? Math.max(0, target - points) : null;
    return { mine, remaining, suggested, target, needed, historyValues };
  }, [detectedMyTeamIds, historicalFifth, leagueTeams, pointsTarget, seasonFixtures]);

  const matchupLevers = useMemo(() => {
    const myIds = new Set(detectedMyTeamIds);
    const fixturesForTeam = teamSeasonFixtures.length ? teamSeasonFixtures : seasonFixtures;
    return sortFixturesByRoundAndTime(fixturesForTeam.filter((fixture) => !fixture.game_result && !fixture.cup_bye && !hasFixtureStarted(fixture, currentTime) && (myIds.has(fixture.home_team_id) || myIds.has(fixture.away_team_id)))).slice(0, 6).map((fixture) => {
      const isHome = myIds.has(fixture.home_team_id);
      const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
      const name = isHome ? fixture.away_team_name : fixture.home_team_name;
      const base = simulatedFixture(fixture, true);
      if (!base) return { fixture, name, unavailable: true };
      const effectiveness = myBoostState.source === 'live' && myBoostState.effectivenessPct != null ? myBoostState.effectivenessPct : 100;
      const items = getHeldPerformanceItems(heldItems).flatMap((item) => {
        const projection = simulatedFixture(fixture, true, item.boostKey, effectiveness);
        return projection ? [{ label: item.label, projection }] : [];
      });
      const options = seasonEngineJobs.filter((job) => job.swap?.fixture === String(fixture.game_key)).flatMap((job) => {
        const projection = fixtureProjection(seasonEngineResults, {}, job.key, false);
        return projection ? [{ ...job.swap, projection }] : [];
      }).sort((a, b) => (3 * b.projection.win + b.projection.draw) - (3 * a.projection.win + a.projection.draw));
      const best = options[0];
      const swap = best && (3 * best.projection.win + best.projection.draw) > (3 * base.win + base.draw) ? best : null;
      return { fixture, opponentId, name, base, items, swap, history: seasonItemHistory?.find((entry) => entry.team_id === opponentId), rank: leagueTeams.find((team) => team.teamId === opponentId)?.currentRank };
    });
  }, [currentTime, detectedMyTeamIds, heldItems, leagueTeams, myBoostState, seasonFixtures, seasonItemHistory, teamSeasonFixtures, simulatedFixture, seasonEngineJobs, seasonEngineResults]);

  const seasonForecast = useMemo(() => {
    const loadedSeasonTeamCount = Object.keys(seasonTeams).length;
    const seasonModelsReady = leagueTeams.length === 0 || loadedSeasonTeamCount >= leagueTeams.length;
    if (activeTab !== 'season' || seasonPredictionLoading || !seasonModelsReady) {
      return {
        rows: [],
        projectedFixtures: [],
        optimizedFixtureCount: 0,
        liveFixtureCount: 0,
        ownedProjectedFixtureCount: 0,
        ownedBaselinePoints: 0,
        ownedOptimizedPoints: 0,
        optimizedPointsGain: 0,
      };
    }

    const myTeamIds = new Set(detectedMyTeamIds);
    const rows = new Map();
    const ensureRow = (teamId, teamName) => {
      if (!teamId) return null;
      if (!rows.has(teamId)) {
        rows.set(teamId, {
          teamId,
          teamName: teamName || seasonTeams[teamId]?.teamLabel || teamId,
          played: 0,
          projected: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          gf: 0,
          ga: 0,
          points: 0,
          unavailable: 0,
        });
      }
      return rows.get(teamId);
    };

    leagueTeams.forEach((team) => ensureRow(team.teamId, team.teamName));

    const projectedFixtures = [];
    const optimizedFixtureCount = 0;
    let liveFixtureCount = 0;
    let ownedProjectedFixtureCount = 0;
    let ownedBaselinePoints = 0;
    let ownedOptimizedPoints = 0;

    seasonFixtures.forEach((fixture) => {
      const home = ensureRow(fixture.home_team_id, fixture.home_team_name);
      const away = ensureRow(fixture.away_team_id, fixture.away_team_name);
      if (!home || !away) return;

      if (fixture.game_result) {
        const homeGoals = Number(fixture.game_result.home_team_score || 0);
        const awayGoals = Number(fixture.game_result.away_team_score || 0);
        home.played += 1;
        away.played += 1;
        home.gf += homeGoals;
        home.ga += awayGoals;
        away.gf += awayGoals;
        away.ga += homeGoals;
        if (homeGoals > awayGoals) {
          home.won += 1;
          away.lost += 1;
          home.points += 3;
        } else if (awayGoals > homeGoals) {
          away.won += 1;
          home.lost += 1;
          away.points += 3;
        } else {
          home.drawn += 1;
          away.drawn += 1;
          home.points += 1;
          away.points += 1;
        }
        return;
      }

      const simulated = seasonEngineResults[String(fixture.game_key)]?.[0];
      if (!simulated) {
        home.unavailable += 1;
        away.unavailable += 1;
        return;
      }
      const baseline = {
        win: 100 * simulated.wins / simulated.trials,
        draw: 100 * simulated.draws / simulated.trials,
        loss: 100 * simulated.losses / simulated.trials,
        myxG: simulated.goalsFor / simulated.trials,
        oppxG: simulated.goalsAgainst / simulated.trials,
      };
      const isOwnedFixture = myTeamIds.has(fixture.home_team_id) !== myTeamIds.has(fixture.away_team_id);
      if (isOwnedFixture) { ownedProjectedFixtureCount += 1; liveFixtureCount += 1; }
      const optimized = null;
      const projection = baseline;
      const homeGoals = projection.myxG;
      const awayGoals = projection.oppxG;
      const expectedPoints = getExpectedPointsFromOutcomePercentages(projection);
      if (isOwnedFixture) {
        const baselinePoints = getExpectedPointsFromOutcomePercentages(baseline);
        const homeIsMine = myTeamIds.has(fixture.home_team_id);
        ownedBaselinePoints += homeIsMine ? baselinePoints.my : baselinePoints.opponent;
        ownedOptimizedPoints += homeIsMine ? expectedPoints.my : expectedPoints.opponent;
      }

      home.projected += 1;
      away.projected += 1;
      home.gf += homeGoals;
      home.ga += awayGoals;
      away.gf += awayGoals;
      away.ga += homeGoals;
      home.won += projection.win / 100;
      away.won += projection.loss / 100;
      home.drawn += projection.draw / 100;
      away.drawn += projection.draw / 100;
      home.lost += projection.loss / 100;
      away.lost += projection.win / 100;
      home.points += expectedPoints.my;
      away.points += expectedPoints.opponent;

      projectedFixtures.push({
        fixture,
        homeWin: projection.win,
        homeXg: projection.myxG,
        awayXg: projection.oppxG,
        scenario: optimized?.scenario || 'live',
        baselineHomeWin: baseline.win,
        optimizedSetup: optimized?.setup || null,
        predicted: projection.win >= projection.draw && projection.win >= projection.loss
          ? fixture.home_team_name
          : projection.loss >= projection.draw
            ? fixture.away_team_name
            : 'Draw',
      });
    });

    return {
      rows: Array.from(rows.values())
        .map((row) => ({
          ...row,
          gd: row.gf - row.ga,
        }))
        .sort((a, b) => (
          b.points - a.points
          || b.gd - a.gd
          || b.gf - a.gf
          || a.teamName.localeCompare(b.teamName)
        )),
      projectedFixtures,
      optimizedFixtureCount,
      liveFixtureCount,
      ownedProjectedFixtureCount,
      ownedBaselinePoints,
      ownedOptimizedPoints,
      optimizedPointsGain: ownedOptimizedPoints - ownedBaselinePoints,
    };
  }, [activeTab, detectedMyTeamIds, leagueTeams, seasonFixtures, seasonPredictionLoading, seasonTeams, seasonEngineResults]);

  const itemSuggestions = useMemo(() => {
    const planningFixtures = teamSeasonFixtures.length > 0 ? teamSeasonFixtures : seasonFixtures;
    const planningModel = primaryOwnedTeamModel?.players?.length
      ? primaryOwnedTeamModel
      : null;
    const planningPlayers = planningModel?.players?.length >= 5 ? planningModel.players : effectiveMyTeam;
    const primaryTeamId = myTeamIdForBoosts || detectedMyTeamIds[0];

    if (planningPlayers.length < 5 || !primaryTeamId || planningFixtures.length === 0 || seasonEngine.status !== 'done' || seasonEngine.fingerprint !== seasonEngineFingerprint || seasonFixtures.some((fixture) => !fixture.game_result && !fixture.cup_bye && !seasonEngineResults[String(fixture.game_key)])) return [];
    const heldPerformanceItems = getHeldPerformanceItems(heldItems);
    if (heldPerformanceItems.length === 0) return [];

    const myTeamIds = new Set(detectedMyTeamIds);
    const remainingMyFixtures = sortFixturesByRoundAndTime(
      planningFixtures.filter((fixture) => (
        !fixture.game_result
        && !fixture.cup_bye
        && !hasFixtureStarted(fixture, currentTime)
        && (fixture.home_team_id === primaryTeamId || fixture.away_team_id === primaryTeamId)
      )),
    );

    const baseStats = { boostKey: '', effectivenessPct: 100 };
    const liveEffectiveness = myBoostState?.source === 'live' && myBoostState.effectivenessPct != null ? Number(myBoostState.effectivenessPct) : Number.NaN;
    const baseEffectivenessPct = Number.isFinite(liveEffectiveness) ? liveEffectiveness : 100;
    const boostCounts = Object.fromEntries(heldPerformanceItems.map((item) => [item.boostKey, item.count]));
    const selectedWindows = [];
    const currentTeamMetaById = new Map(leagueTeams.map((team) => [team.teamId, team]));
    const myCurrentPoints = detectedMyTeamIds.reduce((best, teamId) => {
      const points = Number(currentTeamMetaById.get(teamId)?.currentPoints);
      return Number.isFinite(points) ? Math.max(best, points) : best;
    }, 0);
    const getOpponentLeverage = (opponentId) => {
      const meta = currentTeamMetaById.get(opponentId);
      const currentRank = Number(meta?.currentRank);
      const currentPoints = Number(meta?.currentPoints);
      let leverage = 1;

      if (Number.isFinite(currentRank)) {
        if (currentRank <= 3) leverage += 2.6;
        else if (currentRank <= 6) leverage += 1.8;
        else if (currentRank <= 8) leverage += 1.1;
        else if (currentRank <= 12) leverage += 0.4;
      }

      if (Number.isFinite(currentPoints) && Number.isFinite(myCurrentPoints)) {
        const pointsGap = currentPoints - myCurrentPoints;
        if (pointsGap >= 0) leverage += 1.8;
        else if (pointsGap >= -3) leverage += 1.2;
        else if (pointsGap >= -6) leverage += 0.7;
      }

      return leverage;
    };

    const getOpponentModel = (fixture) => {
      const isHome = myTeamIds.has(fixture.home_team_id);
      const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
      const opponentModel = seasonTeams[opponentId];
      if (!opponentModel?.players?.length) return null;

      return {
        opponentId,
        isHome,
        opponentName: isHome ? fixture.away_team_name : fixture.home_team_name,
      };
    };

    const projectFixture = (fixture, stats) => {
      const opponent = getOpponentModel(fixture);
      const projection = simulatedFixture(fixture, true, stats.boostKey, stats.effectivenessPct);
      return opponent && projection ? { opponent, projection } : null;
    };

    const intervalsOverlap = (startA, endA, startB, endB) => startA <= endB && startB <= endA;
    const hasWindowConflict = (startTime, endTime) => (
      (Number.isFinite(itemCooldownEndTime) && startTime < itemCooldownEndTime)
      || selectedWindows.some((window) => (
        intervalsOverlap(startTime, endTime, window.startTime, window.blockedEndTime)
      ))
    );
    const getDurationDays = (item) => {
      const minDays = Math.max(0, Math.floor(Number(item.minDays ?? item.maxDays ?? 0)));
      const maxDays = Math.max(minDays, Math.floor(Number(item.maxDays ?? minDays)));
      return Array.from({ length: (maxDays - minDays) + 1 }, (_, index) => minDays + index);
    };
    const getExpectedBoostedDays = (item) => {
      const durationDays = getDurationDays(item);
      if (durationDays.length === 0) return 0;
      return (durationDays[0] + durationDays[durationDays.length - 1]) / 2;
    };

    const evaluateCandidate = ({ fixture, startIndex, item, plannedUseIndex }) => {
      const baseFirst = projectFixture(fixture, baseStats);
      if (!baseFirst) return null;
      const startsAt = getFixtureTimeValue(fixture);
      const durationDays = getDurationDays(item);
      const maxDurationDays = durationDays[durationDays.length - 1] || 0;
      const maxEndsAt = Number.isFinite(startsAt)
        ? getUtcDayExpiryTime(startsAt, maxDurationDays)
        : startsAt;
      if (hasWindowConflict(startsAt, maxEndsAt)) return null;

      const effectivenessPct = (plannedUseIndex === 0 ? baseEffectivenessPct : Math.floor(getBoostEffectivenessForPlannedUse(baseEffectivenessPct, plannedUseIndex) / 25) * 25);
      const boostedStats = { boostKey: item.boostKey, effectivenessPct };
      const windowFixtures = remainingMyFixtures
        .slice(startIndex)
        .map((candidate) => {
          const candidateTime = getFixtureTimeValue(candidate);
          const coverageCount = durationDays.filter((days) => {
            const endsAt = Number.isFinite(startsAt)
              ? getUtcDayExpiryTime(startsAt, days)
              : startsAt;
            return candidateTime >= startsAt
              && (candidateTime <= endsAt || candidate.game_key === fixture.game_key);
          }).length;

          return {
            fixture: candidate,
            coverageChance: durationDays.length > 0 ? coverageCount / durationDays.length : 0,
          };
        })
        .filter((candidate) => candidate.coverageChance > 0);
      let seasonDelta = 0;
      let firstFixtureDelta = 0;
      let firstBoostedWin = baseFirst.projection.win;
      let expectedFixtureCount = 0;
      let guaranteedFixtureCount = 0;
      let maxFixtureCount = 0;
      let standingsLeverage = 0;
      let rivalCoverage = 0;
      let expectedPointsDelta = 0;

      windowFixtures.forEach((candidate, windowIndex) => {
        const base = projectFixture(candidate.fixture, baseStats);
        const boosted = projectFixture(candidate.fixture, boostedStats);
        if (!base || !boosted) return;
        const delta = boosted.projection.win - base.projection.win;
        const basePoints = getExpectedPointsFromOutcomePercentages(base.projection);
        const boostedPoints = getExpectedPointsFromOutcomePercentages(boosted.projection);
        const myPointsGain = boostedPoints.my - basePoints.my;
        const opponentPointsDenied = basePoints.opponent - boostedPoints.opponent;
        const opponentLeverage = getOpponentLeverage(base.opponent.opponentId);
        seasonDelta += delta * candidate.coverageChance;
        standingsLeverage += (
          (myPointsGain * 8)
          + (opponentPointsDenied * opponentLeverage * 6)
          + (delta * 0.04)
        ) * candidate.coverageChance;
        rivalCoverage += opponentLeverage * candidate.coverageChance;
        expectedPointsDelta += myPointsGain * candidate.coverageChance;
        expectedFixtureCount += candidate.coverageChance;
        if (candidate.coverageChance >= 1) guaranteedFixtureCount += 1;
        maxFixtureCount += 1;
        if (windowIndex === 0) {
          firstFixtureDelta = delta;
          firstBoostedWin = boosted.projection.win;
        }
      });

      if (expectedFixtureCount === 0 || (seasonDelta <= 0.05 && standingsLeverage <= 0)) return null;
      return {
        fixture,
        boostKey: item.boostKey,
        boostLabel: item.label,
        boostIcon: item.icon,
        heldCount: item.count,
        baseWin: baseFirst.projection.win,
        boostedWin: firstBoostedWin,
        delta: firstFixtureDelta,
        seasonDelta,
        expectedPointsDelta,
        standingsLeverage,
        rivalCoverage,
        effectivenessPct,
        windowCount: expectedFixtureCount,
        guaranteedWindowCount: guaranteedFixtureCount,
        maxWindowCount: maxFixtureCount,
        minDays: durationDays[0] || 0,
        maxDays: maxDurationDays,
        startTime: startsAt,
        endTime: maxEndsAt,
        opponentName: baseFirst.opponent.opponentName,
        boostedStats,
      };
    };

    const maxPlannedUses = heldPerformanceItems.reduce((sum, item) => sum + item.count, 0);
    const remainingCounts = { ...boostCounts };
    const schedule = [];
    let plannedBoostedDaysForSelection = 0;

    for (let plannedUseIndex = 0; plannedUseIndex < maxPlannedUses; plannedUseIndex += 1) {
      let bestCandidate = null;
      remainingMyFixtures.forEach((fixture, startIndex) => {
        heldPerformanceItems.forEach((item) => {
          if ((remainingCounts[item.boostKey] || 0) <= 0) return;
          const candidate = evaluateCandidate({
            fixture,
            startIndex,
            item,
            plannedUseIndex: plannedBoostedDaysForSelection,
          });
          if (!candidate) return;
          const leverageDelta = candidate.standingsLeverage - (bestCandidate?.standingsLeverage ?? 0);
          const seasonDeltaGap = candidate.seasonDelta - (bestCandidate?.seasonDelta ?? 0);
          if (
            !bestCandidate
            || leverageDelta > 0.001
            || (
              Math.abs(leverageDelta) <= 0.001
              && seasonDeltaGap > 0.001
            )
            || (
              Math.abs(leverageDelta) <= 0.001
              && Math.abs(seasonDeltaGap) <= 0.001
              && getFixtureTimeValue(candidate.fixture) < getFixtureTimeValue(bestCandidate.fixture)
            )
          ) {
            bestCandidate = candidate;
          }
        });
      });

      if (!bestCandidate) break;
      plannedBoostedDaysForSelection += getExpectedBoostedDays(bestCandidate);
      remainingCounts[bestCandidate.boostKey] = Math.max(0, remainingCounts[bestCandidate.boostKey] - 1);
      selectedWindows.push({
        startTime: bestCandidate.startTime,
        endTime: bestCandidate.endTime,
        blockedEndTime: Number.isFinite(bestCandidate.endTime)
          ? bestCandidate.endTime + (ITEM_USE_COOLDOWN_DAYS * MS_PER_DAY)
          : bestCandidate.endTime,
      });
      schedule.push({
        ...bestCandidate,
        remainingAfterUse: remainingCounts[bestCandidate.boostKey],
      });
    }

    const sortedSchedule = schedule
      .sort((a, b) => (
        getFixtureRound(a.fixture) - getFixtureRound(b.fixture)
        || getFixtureTimeValue(a.fixture) - getFixtureTimeValue(b.fixture)
        || b.seasonDelta - a.seasonDelta
      ));

    const chronologicalRemainingCounts = { ...boostCounts };
    const recalculateChronologicalItem = (item, plannedUseIndex) => {
      const effectivenessPct = (plannedUseIndex === 0 ? baseEffectivenessPct : Math.floor(getBoostEffectivenessForPlannedUse(baseEffectivenessPct, plannedUseIndex) / 25) * 25);
      const boostedStats = { boostKey: item.boostKey, effectivenessPct };
      const durationDays = Array.from(
        { length: Math.max(0, (item.maxDays || 0) - (item.minDays || 0)) + 1 },
        (_, index) => (item.minDays || 0) + index,
      );
      const baseFirst = projectFixture(item.fixture, baseStats);
      const boostedFirst = projectFixture(item.fixture, boostedStats);
      let seasonDelta = 0;
      let standingsLeverage = 0;
      let rivalCoverage = 0;
      let expectedPointsDelta = 0;
      let expectedFixtureCount = 0;
      let guaranteedFixtureCount = 0;
      let maxFixtureCount = 0;

      remainingMyFixtures.forEach((candidate) => {
        const candidateTime = getFixtureTimeValue(candidate);
        const coverageCount = durationDays.filter((days) => {
          const endsAt = Number.isFinite(item.startTime)
            ? getUtcDayExpiryTime(item.startTime, days)
            : item.startTime;
          return candidateTime >= item.startTime
            && (candidateTime <= endsAt || candidate.game_key === item.fixture.game_key);
        }).length;
        const coverageChance = durationDays.length > 0 ? coverageCount / durationDays.length : 0;
        if (coverageChance <= 0) return;
        const base = projectFixture(candidate, baseStats);
        const boosted = projectFixture(candidate, boostedStats);
        if (!base || !boosted) return;
        const delta = boosted.projection.win - base.projection.win;
        const basePoints = getExpectedPointsFromOutcomePercentages(base.projection);
        const boostedPoints = getExpectedPointsFromOutcomePercentages(boosted.projection);
        const myPointsGain = boostedPoints.my - basePoints.my;
        const opponentPointsDenied = basePoints.opponent - boostedPoints.opponent;
        const opponentLeverage = getOpponentLeverage(base.opponent.opponentId);
        seasonDelta += delta * coverageChance;
        standingsLeverage += (
          (myPointsGain * 8)
          + (opponentPointsDenied * opponentLeverage * 6)
          + (delta * 0.04)
        ) * coverageChance;
        rivalCoverage += opponentLeverage * coverageChance;
        expectedPointsDelta += myPointsGain * coverageChance;
        expectedFixtureCount += coverageChance;
        if (coverageChance >= 1) guaranteedFixtureCount += 1;
        maxFixtureCount += 1;
      });

      return {
        ...item,
        baseWin: baseFirst?.projection.win ?? item.baseWin,
        boostedWin: boostedFirst?.projection.win ?? item.boostedWin,
        delta: boostedFirst && baseFirst ? boostedFirst.projection.win - baseFirst.projection.win : item.delta,
        seasonDelta,
        expectedPointsDelta,
        standingsLeverage,
        rivalCoverage,
        effectivenessPct,
        windowCount: expectedFixtureCount,
        guaranteedWindowCount: guaranteedFixtureCount,
        maxWindowCount: maxFixtureCount,
        boostedStats,
      };
    };

    let chronologicalBoostedDays = 0;
    const plannedSchedule = sortedSchedule.map((item) => {
      const heldCount = boostCounts[item.boostKey] || item.heldCount || 0;
      const useNumber = heldCount - (chronologicalRemainingCounts[item.boostKey] || 0) + 1;
      const plannedBoostedDays = chronologicalBoostedDays;
      chronologicalBoostedDays += getExpectedBoostedDays(item);
      chronologicalRemainingCounts[item.boostKey] = Math.max(0, (chronologicalRemainingCounts[item.boostKey] || 0) - 1);
      return {
        ...recalculateChronologicalItem(item, plannedBoostedDays),
        heldCount,
        useNumber,
        remainingAfterUse: chronologicalRemainingCounts[item.boostKey],
      };
    });

    const getProjectedSummary = (plan) => {
      const rows = new Map();
      const ensureRow = (teamId, teamName) => {
        if (!teamId) return null;
        if (!rows.has(teamId)) {
          rows.set(teamId, {
            teamId,
            teamName: teamName || seasonTeams[teamId]?.teamLabel || teamId,
            won: 0,
            drawn: 0,
            lost: 0,
            gf: 0,
            ga: 0,
            points: 0,
          });
        }
        return rows.get(teamId);
      };

      leagueTeams.forEach((team) => ensureRow(team.teamId, team.teamName));

      const getPlannedWindow = (fixture) => {
        const fixtureTime = getFixtureTimeValue(fixture);
        return plan.find((item) => (
          fixtureTime >= item.startTime
          && (fixtureTime <= item.endTime || fixture.game_key === item.fixture.game_key)
          && (fixture.home_team_id === primaryTeamId || fixture.away_team_id === primaryTeamId)
        ));
      };

      seasonFixtures.forEach((fixture) => {
        const home = ensureRow(fixture.home_team_id, fixture.home_team_name);
        const away = ensureRow(fixture.away_team_id, fixture.away_team_name);
        if (!home || !away) return;

        let homeGoals;
        let awayGoals;
        let expectedPoints = null;

        if (fixture.game_result) {
          homeGoals = Number(fixture.game_result.home_team_score || 0);
          awayGoals = Number(fixture.game_result.away_team_score || 0);
          expectedPoints = playedPoints(homeGoals, awayGoals);
        } else {
          const plannedWindow = getPlannedWindow(fixture);
          const homeIsMine = fixture.home_team_id === primaryTeamId;
          const awayIsMine = fixture.away_team_id === primaryTeamId;
          const own = homeIsMine || awayIsMine;
          const baseline = simulatedFixture(fixture, own);
          if (!baseline) return;
          let projection = baseline;
          if (plannedWindow) {
            const boosted = simulatedFixture(fixture, own, plannedWindow.boostKey, plannedWindow.effectivenessPct);
            if (!boosted) return;
            const durations = getDurationDays(plannedWindow);
            const coverage = durations.filter((days) => getFixtureTimeValue(fixture) <= getUtcDayExpiryTime(plannedWindow.startTime, days)).length / durations.length;
            projection = blendProjections(baseline, boosted, coverage);
          }
          homeGoals = awayIsMine ? projection.oppxG : projection.myxG;
          awayGoals = awayIsMine ? projection.myxG : projection.oppxG;
          const points = getExpectedPointsFromOutcomePercentages(projection);
          expectedPoints = awayIsMine ? { my: points.opponent, opponent: points.my } : points;
        }

        home.gf += homeGoals;
        home.ga += awayGoals;
        away.gf += awayGoals;
        away.ga += homeGoals;

        if (expectedPoints) {
          home.points += expectedPoints.my;
          away.points += expectedPoints.opponent;
        }
      });

      const sortedRows = Array.from(rows.values())
        .map((row) => ({
          ...row,
          gd: row.gf - row.ga,
        }))
        .sort((a, b) => (
          b.points - a.points
          || b.gd - a.gd
          || b.gf - a.gf
          || a.teamName.localeCompare(b.teamName)
        ));
      const myIndex = sortedRows.findIndex((row) => myTeamIds.has(row.teamId));
      const myRow = myIndex >= 0 ? sortedRows[myIndex] : null;
      const promotionCutoff = Math.min(5, sortedRows.length);
      const promotionEdge = promotionCutoff > 0 ? sortedRows[promotionCutoff - 1] : null;
      const firstOutsidePromotion = sortedRows[promotionCutoff] || null;
      const promotionBuffer = myRow && promotionCutoff > 0
        ? myIndex < promotionCutoff
          ? myRow.points - (firstOutsidePromotion?.points ?? myRow.points)
          : myRow.points - (promotionEdge?.points ?? myRow.points)
        : null;

      return {
        rows: sortedRows,
        position: myIndex >= 0 ? myIndex + 1 : null,
        points: myRow?.points ?? null,
        gd: myRow?.gd ?? null,
        promotionBuffer,
      };
    };

    const isUsefulPlanStep = (before, after) => {
      if (!before?.position || !after?.position) return true;
      if (after.position < before.position) return true;
      if (Number.isFinite(before.points) && Number.isFinite(after.points) && after.points > before.points) return true;
      const beforeBuffer = Number(before.promotionBuffer);
      const afterBuffer = Number(after.promotionBuffer);
      if (Number.isFinite(beforeBuffer) && Number.isFinite(afterBuffer)) {
        if (before.position <= 5 && beforeBuffer < 3 && afterBuffer > beforeBuffer) return true;
        if (before.position > 5 && afterBuffer > beforeBuffer) return true;
      }
      return false;
    };

    const baseSummary = getProjectedSummary([]);
    let currentSummary = baseSummary;
    const usefulSchedule = [];

    plannedSchedule.forEach((item) => {
      const nextPlan = [...usefulSchedule, item];
      const nextSummary = getProjectedSummary(nextPlan);
      if (!isUsefulPlanStep(currentSummary, nextSummary)) return;
      usefulSchedule.push(item);
      currentSummary = nextSummary;
    });

    const initialFinalRemainingCounts = { ...boostCounts };
    const initialFinalSchedule = usefulSchedule.map((item) => {
      const heldCount = boostCounts[item.boostKey] || item.heldCount || 0;
      const useNumber = heldCount - (initialFinalRemainingCounts[item.boostKey] || 0) + 1;
      initialFinalRemainingCounts[item.boostKey] = Math.max(0, (initialFinalRemainingCounts[item.boostKey] || 0) - 1);
      return {
        ...item,
        heldCount,
        useNumber,
        remainingAfterUse: initialFinalRemainingCounts[item.boostKey],
      };
    });

    const fullSummary = getProjectedSummary(initialFinalSchedule);
    const fullPlacementGain = baseSummary.position && fullSummary.position ? Math.max(0, baseSummary.position - fullSummary.position) : 0;
    let efficientSchedule = initialFinalSchedule;

    if (initialFinalSchedule.length > 1) {
      for (let count = 1; count <= initialFinalSchedule.length; count += 1) {
        const prefix = initialFinalSchedule.slice(0, count);
        const prefixSummary = getProjectedSummary(prefix);
        const prefixPlacementGain = baseSummary.position && prefixSummary.position
          ? Math.max(0, baseSummary.position - prefixSummary.position)
          : 0;
        const baseBuffer = Number(baseSummary.promotionBuffer);
        const fullBuffer = Number(fullSummary.promotionBuffer);
        const prefixBuffer = Number(prefixSummary.promotionBuffer);
        const isStillBelowPromotion = Number(fullSummary.position) > 5;
        const matchesPromotionGapTarget = isStillBelowPromotion
          && Number.isFinite(fullBuffer)
          && Number.isFinite(prefixBuffer)
          && prefixBuffer >= fullBuffer;
        const matchesPlacementTarget = !isStillBelowPromotion
          && fullPlacementGain > 0
          && prefixPlacementGain >= fullPlacementGain
          && prefixSummary.position <= fullSummary.position;
        const matchesBufferTarget = !isStillBelowPromotion
          && fullPlacementGain === 0
          && Number.isFinite(baseBuffer)
          && Number.isFinite(fullBuffer)
          && Number.isFinite(prefixBuffer)
          && fullBuffer > baseBuffer
          && prefixBuffer >= fullBuffer;

        if (matchesPromotionGapTarget || matchesPlacementTarget || matchesBufferTarget) {
          efficientSchedule = prefix;
          break;
        }
      }
    }

    const finalRemainingCounts = { ...boostCounts };
    let finalBoostedDays = 0;
    const finalSchedule = efficientSchedule.map((item) => {
      const heldCount = boostCounts[item.boostKey] || item.heldCount || 0;
      const useNumber = heldCount - (finalRemainingCounts[item.boostKey] || 0) + 1;
      const plannedBoostedDays = finalBoostedDays;
      finalBoostedDays += getExpectedBoostedDays(item);
      finalRemainingCounts[item.boostKey] = Math.max(0, (finalRemainingCounts[item.boostKey] || 0) - 1);
      return {
        ...recalculateChronologicalItem(item, plannedBoostedDays),
        heldCount,
        useNumber,
        remainingAfterUse: finalRemainingCounts[item.boostKey],
      };
    });

    const plannedSummary = getProjectedSummary(finalSchedule);
    const placementGain = baseSummary.position && plannedSummary.position ? Math.max(0, baseSummary.position - plannedSummary.position) : 0;

    return finalSchedule
      .map((item) => ({
        ...item,
        planBasePosition: baseSummary.position,
        planProjectedPosition: plannedSummary.position,
        planBasePoints: baseSummary.points,
        planProjectedPoints: plannedSummary.points,
        planBasePromotionBuffer: baseSummary.promotionBuffer,
        planProjectedPromotionBuffer: plannedSummary.promotionBuffer,
        placementGain,
      }))
      .slice(0, 10);
  }, [currentTime, detectedMyTeamIds, heldItems, itemCooldownEndTime, leagueTeams, myBoostState, effectiveMyTeam, myTeamIdForBoosts, primaryOwnedTeamModel, seasonFixtures, seasonTeams, teamSeasonFixtures, simulatedFixture, seasonEngine.status, seasonEngine.fingerprint, seasonEngineFingerprint, seasonEngineResults]);

  const plannedItemsByFixture = useMemo(() => {
    const planned = {};
    itemSuggestions.forEach((item) => {
      if (!item.fixture?.game_key) return;
      planned[item.fixture.game_key] = {
        icon: item.boostIcon,
        label: item.boostLabel,
        useNumber: item.useNumber,
        heldCount: item.heldCount,
      };
    });
    return planned;
  }, [itemSuggestions]);

  const itemPlanSummary = useMemo(() => {
    const first = itemSuggestions[0];
    if (!first?.planBasePosition || !first?.planProjectedPosition) return null;
    return {
      basePosition: first.planBasePosition,
      projectedPosition: first.planProjectedPosition,
      basePoints: first.planBasePoints,
      projectedPoints: first.planProjectedPoints,
      basePromotionBuffer: first.planBasePromotionBuffer,
      projectedPromotionBuffer: first.planProjectedPromotionBuffer,
      promotionBufferDelta: Number(first.planProjectedPromotionBuffer) - Number(first.planBasePromotionBuffer),
      placementGain: first.placementGain,
      itemCount: itemSuggestions.length,
    };
  }, [itemSuggestions]);

  const heldPerformanceUseCount = Object.values(heldItems || {})
    .filter((item) => item.boostKey && Number(item.count) > 0)
    .reduce((sum, item) => sum + Number(item.count), 0);

  const lineupCoverageGaps = useMemo(
    () => getLineupCoverageGaps(effectiveMySquad),
    [effectiveMySquad],
  );

  const openInjuryModal = useCallback((player, teamType, { readOnly = false } = {}) => {
    setInjuryModalState({
      open: true,
      playerId: player.id,
      teamType,
      selected: player.injury || 'None',
      readOnly,
    });
  }, []);

  const closeInjuryModal = useCallback(() => {
    setInjuryModalState({
      open: false,
      playerId: null,
      teamType: null,
      selected: 'None',
      readOnly: false,
    });
  }, []);

  const confirmInjuryModal = useCallback(() => {
    if (!injuryModalState.playerId || !injuryModalState.teamType) {
      closeInjuryModal();
      return;
    }
    const player = injuryModalState.teamType === 'opponent'
      ? opponentTeam.find((p) => p.id === injuryModalState.playerId)
      : mySquad.find((p) => p.id === injuryModalState.playerId);
    if (player) {
      handleInjuryChange(player, injuryModalState.selected, injuryModalState.teamType);
    }
    closeInjuryModal();
  }, [closeInjuryModal, handleInjuryChange, injuryModalState, mySquad, opponentTeam]);

  const injuryModalPlayer = injuryModalState.teamType === 'opponent'
    ? opponentTeam.find((p) => p.id === injuryModalState.playerId)
    : mySquad.find((p) => p.id === injuryModalState.playerId);
  const injuryModalDefinition = injuryModalPlayer?.injury && INJURIES[injuryModalPlayer.injury]
    ? INJURIES[injuryModalPlayer.injury]
    : null;
  const injuryModalDetails = injuryModalPlayer?.injuryDetails || null;

  const isMatchupView = activeTab === 'matchup';

  return (
    <div className={`${isMatchupView
      ? 'flex min-h-[100dvh] flex-col bg-[#0a0d12] text-[#e8edf5] font-sans lg:h-[100dvh] lg:min-h-[600px] lg:overflow-hidden lg:pb-0'
      : 'min-h-screen bg-[#0a0d12] text-[#e8edf5] font-sans pb-8'}`}
    >
      <header className="sticky top-0 z-[100] border-b border-[#1e2a3a] bg-[#111620]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 md:px-6">
          <div className="min-w-0">
            <div className="truncate font-['Barlow_Condensed'] text-xl font-black leading-none tracking-[0.04em] md:text-2xl">
              <span className="text-[#00e676]">OINK</span> SOCCER CALCULATOR
            </div>
            <div className="text-[11px] text-[#6b7a94]">Season {catalogSeason ?? 'Unknown'}</div>
          </div>
          <div className="flex items-center gap-2">
            <WalletConnector
              onSync={handleSyncWalletAssets}
              isSyncing={walletSyncing}
              syncMeta={walletSyncMeta}
            />
          </div>
        </div>
      </header>

      <nav className="sticky top-14 z-[99] shrink-0 border-b border-[#1e2a3a] bg-[#111620]">
        <div className="mx-auto max-w-[1200px] overflow-x-auto px-2 md:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max items-center gap-1">
            {tabItems.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative flex items-center gap-1.5 px-4 py-3 text-sm font-semibold transition ${isActive ? 'text-[#e8edf5]' : 'text-[#6b7a94] hover:text-[#9aa5bb]'
                    }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {isActive && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-t bg-[#00e676]" />}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <section className="shrink-0 border-b border-[#1e2a3a] bg-[linear-gradient(135deg,#161c28,rgba(0,230,118,0.05))]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-6 px-4 py-3 md:px-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#6b7a94]">{headlineProjection.label}</div>
            <div className="font-['Barlow_Condensed'] text-[32px] font-black leading-none text-[#00e676] lg:text-[36px]">{displayedWin}</div>
            <div className="text-[11px] text-[#6b7a94]">{headlineProjection.source === 'engine' ? `Based on ${headlineProjection.trials.toLocaleString()} simulated matches; goals are match averages.` : 'Waiting for the match simulation.'}</div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[24px] font-black leading-none text-[#00e676] lg:text-[26px]">{headlineProjection.myxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">You</div>
            </div>
            <div className="font-['Barlow_Condensed'] text-xl leading-none text-[#6b7a94]">:</div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[24px] font-black leading-none text-[#ffab00] lg:text-[26px]">{headlineProjection.oppxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Opp</div>
            </div>
          </div>

          <div className="hidden items-end gap-5 sm:flex">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-lg font-bold text-[#00e676] lg:text-xl">{hasLineups ? `${displayedForecastWin.toFixed(1)}%` : '—'}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Win</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-lg font-bold text-[#9aa5bb] lg:text-xl">{hasLineups ? `${displayedForecastDraw.toFixed(1)}%` : '—'}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Draw</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-lg font-bold text-[#ff4444] lg:text-xl">{hasLineups ? `${displayedForecastLoss.toFixed(1)}%` : '—'}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Loss</div>
            </div>
          </div>
        </div>
      </section>

      <main className={`mx-auto px-4 md:px-6 ${isMatchupView ? 'max-w-[1500px] min-h-0 flex-1 py-3' : 'py-5 md:py-6'}`}>
        {activeTab === 'squad' && (
          <section id="tab-squad" className="space-y-4">
            <div className="grid grid-cols-1 gap-3 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4 md:grid-cols-[1fr_auto_1fr]">
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">▲ My Team</div>
                <select
                  value={myForm}
                  onChange={(e) => handleFormChange('my', e.target.value)}
                  className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#00e676]"
                >
                  {Object.keys(FORMATIONS).map((k) => (
                    <option key={k} value={k}>{FORMATIONS[k].name}</option>
                  ))}
                </select>
              </div>
              <div className="hidden flex-col items-center justify-center md:flex">
                <div className="h-4 w-px bg-[#1e2a3a]" />
                <div className="font-['Barlow_Condensed'] text-xl font-black text-[#6b7a94]">VS</div>
                <div className="h-4 w-px bg-[#1e2a3a]" />
              </div>
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#ffab00]">▼ Opponent</div>
                <select
                  value={oppForm}
                  onChange={(e) => handleFormChange('opp', e.target.value)}
                  className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#ffab00]"
                >
                  {Object.keys(FORMATIONS).map((k) => (
                    <option key={k} value={k}>{FORMATIONS[k].name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              {myTeam.map((p) => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  teamType="myTeam"
                  onInjuryOpen={() => openInjuryModal(p, 'myTeam')}
                  onRoleChange={(role) => handleRoleChange(p, role, 'myTeam')}
                />
              ))}
              {myTeam.length === 0 && (
                <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No active lineup yet.</div>
              )}
            </div>

            <div id="player-form" className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <button
                onClick={() => setShowManualForm(!showManualForm)}
                className="mb-3 flex w-full items-center justify-between text-sm font-semibold text-[#9aa5bb]"
              >
                <span className="inline-flex items-center gap-2">
                  {editingId ? <Pencil size={14} className="text-[#ffab00]" /> : <Plus size={14} className="text-[#00e676]" />}
                  {editingId ? 'Edit Player' : 'Manual Entry'}
                </span>
                {showManualForm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showManualForm && (
                <div className="space-y-4">
                  {editingId && (
                    <div className="flex justify-end">
                      <button onClick={handleCancelEdit} className="inline-flex items-center gap-1 rounded bg-[#161c28] px-2 py-1 text-xs text-[#9aa5bb]">
                        <RotateCcw size={12} /> Cancel Edit
                      </button>
                    </div>
                  )}

                  {!editingId && (
                    <div className="flex rounded-md border border-[#1e2a3a] bg-[#161c28] p-1">
                      <button
                        onClick={() => setFormTarget('mySquad')}
                        className={`flex-1 rounded py-1.5 text-xs font-semibold ${formTarget === 'mySquad' ? 'bg-[#00e676] text-black' : 'text-[#9aa5bb]'}`}
                      >
                        My Squad
                      </button>
                      <button
                        onClick={() => setFormTarget('opponent')}
                        className={`flex-1 rounded py-1.5 text-xs font-semibold ${formTarget === 'opponent' ? 'bg-[#ffab00] text-black' : 'text-[#9aa5bb]'}`}
                      >
                        Opponent
                      </button>
                    </div>
                  )}

                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Name</label>
                    <input
                      type="text"
                      placeholder="Player Name"
                      className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-white outline-none focus:border-[#00e676]"
                      value={newPlayer.name}
                      onChange={(e) => setNewPlayer({ ...newPlayer, name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Position</label>
                    <div className="grid grid-cols-4 gap-2">
                      {Object.keys(POSITIONS).map((k) => (
                        <button
                          key={k}
                          onClick={() => setNewPlayer({ ...newPlayer, pos: k })}
                          className={`rounded border py-2 text-xs font-semibold ${newPlayer.pos === k ? 'border-[#00e676] bg-[#00e676]/10 text-[#00e676]' : 'border-[#1e2a3a] bg-[#161c28] text-[#9aa5bb]'}`}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {['ATT', 'CTL', 'SPD', 'DEF'].map((s) => (
                      <div key={s}>
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">{s}</label>
                        <input
                          type="number"
                          className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-[#00e676]"
                          value={newPlayer.stats[s]}
                          onChange={(e) => handleStatChange(s, e.target.value)}
                        />
                      </div>
                    ))}
                    {newPlayer.pos === 'GK' && (
                      <div className="col-span-2">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">GKP</label>
                        <input
                          type="number"
                          className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-[#00e676]"
                          value={newPlayer.stats.GKP}
                          onChange={(e) => handleStatChange('GKP', e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Specialists</div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {[
                        ['WRT', 'Work rate'],
                        ['FIN', 'Finishing'],
                        ['HDG', 'Heading'],
                        ['TEC', 'Technique'],
                        ['CMP', 'Composure'],
                        ['TCK', 'Tackling'],
                      ].map(([key, label]) => (
                        <div key={key}>
                          <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">{label}</label>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            placeholder="Auto"
                            className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-[#00e676]"
                            value={newPlayer.stats[key] || ''}
                            onChange={(e) => handleStatChange(key, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={handleSavePlayer}
                    className={`inline-flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold ${editingId ? 'bg-[#ffab00] text-black' : 'bg-[#00e676] text-black'}`}
                  >
                    {editingId ? <Save size={15} /> : <Plus size={15} />}
                    {editingId ? 'Update Player' : 'Add Player'}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === 'upcoming' && (
          <section id="tab-upcoming" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div>
                <div className="mb-1 text-sm font-bold">Fixtures</div>
                <div className="text-xs text-[#6b7a94]">
                  {fixtureSeason
                    ? `Season ${fixtureSeason}${selectedLeagueName ? ` • ${selectedLeagueName}` : ''}`
                    : leagueIndexLoading
                      ? 'Loading league...'
                      : 'Loading season fixtures...'}
                </div>
              </div>

              {activeBoostSummaryRows.length > 0 && (
                <div className="mt-4 space-y-2 rounded-md border border-[#00e676]/25 bg-[#0f2a1b]/70 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Active Item Boosts</div>
                  {activeBoostSummaryRows.map((item) => (
                    <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[#00e676]/25 bg-[#111620] text-base">
                          {item.icon || '⬢'}
                        </span>
                        <div className="min-w-0">
                          <div className="font-semibold text-[#e8edf5]">{item.label}</div>
                          <div className="text-[#9aa5bb]">
                            {formatNumber(item.effectivenessPct ?? 100)}% effectiveness
                          </div>
                        </div>
                      </div>
                      <div className="text-right text-[#9af7cb]">
                        <div className="font-semibold">
                          Eligible for {item.fixtureCount} upcoming fixture{item.fixtureCount === 1 ? '' : 's'}
                        </div>
                        <div className="text-[#7f8aa3]">
                          Until {formatFixtureTime(item.endTime)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <FixtureTableSection
                title="Upcoming Fixtures"
                fixtures={upcomingFixtures}
                selectedFixtureKey={selectedFixtureKey}
                detectedMyTeamIds={detectedMyTeamIds}
                fixtureWinChances={fixtureWinChances}
                plannedItemsByFixture={plannedItemsByFixture}
                activeBoostsByFixture={activeBoostsByFixture}
                loading={fixturesLoading}
                emptyText={connectedAddresses.length > 0
                  ? 'No upcoming fixtures found for the connected wallet team.'
                  : 'Connect your team wallet to load its league fixtures.'}
                onSelect={(fixture) => void handleSelectFixture(fixture)}
              />

              <FixtureTableSection
                title="Past Matches"
                fixtures={pastFixtures}
                selectedFixtureKey={selectedFixtureKey}
                detectedMyTeamIds={detectedMyTeamIds}
                fixtureWinChances={fixtureWinChances}
                plannedItemsByFixture={plannedItemsByFixture}
                activeBoostsByFixture={{}}
                loading={false}
                emptyText="No completed matches found for this season."
                onSelect={(fixture) => void handleSelectFixture(fixture)}
              />

              {uploadStatus && (
                <div className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${uploadStatus.tone === 'success'
                  ? 'border-[#00e676]/40 bg-[#00e676]/10 text-[#9af7cb]'
                  : uploadStatus.tone === 'error'
                    ? 'border-[#ff4444]/50 bg-[#ff4444]/10 text-[#ff9e9e]'
                    : 'border-[#2979ff]/40 bg-[#2979ff]/10 text-[#9fc6ff]'
                  }`}>
                  {uploadStatus.message}
                </div>
              )}
            </div>
          </section>
        )}

        {catalogOutOfDate && <div role="alert" className="mx-auto my-3 max-w-[1200px] rounded border border-[#ffab00]/60 bg-[#2d230d] p-3 text-sm text-[#ffdc99]">Player catalog is season {catalogSeason}, but the live game is season {gameCounter.season}. Player recommendations may use outdated assignments; update the catalog before relying on them.</div>}
        {activeTab === 'matchup' && (
          <section id="tab-matchup" className={selectedFixture ? 'lg:grid lg:h-full lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-3' : 'space-y-4'}>
              <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-3">
                <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Selected Matchup</div>
                {selectedFixture ? (
                  <div className="mt-2 grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSelectFixture(previousFixture)}
                      disabled={!previousFixture || importingTeamUrl}
                      aria-label={previousFixture
                        ? `Previous game: ${previousFixture.home_team_name} versus ${previousFixture.away_team_name}`
                        : 'No previous game'}
                      title={previousFixture
                        ? `${previousFixture.home_team_name} vs ${previousFixture.away_team_name}`
                        : 'No previous game'}
                      className={FIXTURE_NAV_BUTTON_CLASS}
                    >
                      <ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />
                    </button>

                    <div className="min-w-0">
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
                        <div className={`min-w-0 truncate text-right ${homeAdvantage === 'home' ? 'text-[#00e676]' : 'text-[#e8edf5]'}`}>{selectedFixture.home_team_name}</div>
                        <div className="rounded bg-[#ffab00] px-2 py-1 text-xs font-bold text-black">
                          {selectedFixture.game_result
                            ? `${selectedFixture.game_result.home_team_score}-${selectedFixture.game_result.away_team_score}`
                            : 'vs'}
                        </div>
                        <div className={`min-w-0 truncate ${homeAdvantage === 'away' ? 'text-[#00e676]' : 'text-[#e8edf5]'}`}>{selectedFixture.away_team_name}</div>
                      </div>
                      {selectedFixtureNavigationIndex >= 0 && (
                        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-1 text-center text-[9px] font-bold uppercase tracking-[0.08em] text-[#6b7a94]">
                          <span>{getFixtureRoundLabel(selectedFixture)}</span>
                          <span aria-hidden="true">•</span>
                          <span>{formatFixtureTime(selectedFixture.game_time)}</span>
                          <span aria-hidden="true">•</span>
                          <span>Game {selectedFixtureNavigationIndex + 1} of {navigableFixtures.length}</span>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleSelectFixture(nextFixture)}
                      disabled={!nextFixture || importingTeamUrl}
                      aria-label={nextFixture
                        ? `Next game: ${nextFixture.home_team_name} versus ${nextFixture.away_team_name}`
                        : 'No next game'}
                      title={nextFixture
                        ? `${nextFixture.home_team_name} vs ${nextFixture.away_team_name}`
                        : 'No next game'}
                      className={FIXTURE_NAV_BUTTON_CLASS}
                    >
                      <ChevronRight size={22} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-[#9aa5bb]">Choose a fixture from Upcoming to calculate the best setup.</div>
                )}
                {importedOpponentTeamId && oppBoostState.fetchError && <p className="mt-2 text-xs text-[#ffcf66]">Opponent item check failed; the matchup assumes no boost. Refresh the fixture to retry.</p>}
                {importedOpponentTeamId && oppBoostState.source === 'live' && selectedFixture && <p className="mt-2 text-xs text-[#aebbd0]">Opponent: {oppBoostState.boosts.length} active boost(s), {formatNumber(oppBoostState.effectivenessPct)}% current effectiveness; {oppBoostContext.boosts.length} confirmed to cover this fixture. Unknown expiry times are excluded.</p>}
                {selectedFixture && !selectedFixture.game_result && <div className="mt-3 border-t border-[#253040] pt-3 text-xs text-[#c7d0df]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-[#e8edf5]">Game engine simulations</div>
                    <button type="button" onClick={runEngineSimulation} disabled={!engineRequest || currentEngineSimulation.status === 'running'} className="rounded border border-[#00e676]/50 px-3 py-2 font-semibold text-[#9af7cb] disabled:cursor-not-allowed disabled:opacity-50">{currentEngineSimulation.status === 'running' ? 'Simulating…' : 'Run 5,000 matches'}</button>
                  </div>
                  <p className="mt-1 text-[#aebbd0]">Runs the pinned public v2 engine on your device using {topSuggestion ? 'the recommended setup' : 'the current setup'}, current injuries and known fixture boosts. Each held item replaces your current boost for comparison.</p>
                  {currentEngineSimulation.status === 'error' && <p role="alert" className="mt-2 text-[#ff9e9e]">{currentEngineSimulation.error}</p>}
                  {currentEngineSimulation.status === 'done' && currentEngineSimulation.results.map((result, index, rows) => {
                    const base = rows[0];
                    const win = 100 * result.wins / result.trials;
                    const draw = 100 * result.draws / result.trials;
                    const point = win + draw;
                    const basePoint = 100 * (base.wins + base.draws) / base.trials;
                    const item = getHeldPerformanceItems(heldItems).find((entry) => entry.boostKey === result.key);
                    return <div key={result.key} className="mt-2 rounded-md bg-[#111620] p-2.5"><div className="font-semibold text-[#e8edf5]">{index === 0 ? 'Current boost state' : item?.label || result.key}</div><div className="mt-1">Win {formatNumber(win)}% · Draw {formatNumber(draw)}% · Win or draw {formatNumber(point)}%{index > 0 ? ` (${point >= basePoint ? '+' : ''}${formatNumber(point - basePoint)} percentage points)` : ''}</div></div>;
                  })}
                  {currentEngineSimulation.status === 'done' && <p className="mt-2 text-[#aebbd0]">A 5,000-match sample has up to about 1.4 percentage points of sampling uncertainty; results vary with the seed. Future lineup changes, unknown boosts and item expiry are not predicted; effectiveness is based on current data (100% assumed if unavailable).</p>}
                </div>}
              </div>

              {selectedFixture ? (
                <>
                  <div className="grid gap-4 lg:min-h-0 lg:grid-cols-2 lg:h-full lg:gap-3">
                    <BestSetupCard
                      suggestion={topSuggestion}
                      error={autoError}
                      progress={autoProgress}
                      liveSetup={selectedOwnedTeamId ? ownedTeamModels[selectedOwnedTeamId] : null}
                      analyzing={autoAnalyzing || importingTeamUrl}
                      syncing={walletSyncing}
                      fallbackLabel={setupFallbackLabel}
                      syncError={walletSyncMeta.lastError}
                      canAnalyze={effectiveMySquad.length >= 5 && opponentTeam.length > 0}
                      lineupGaps={lineupCoverageGaps}
                      onInjuryOpen={(player) => openInjuryModal(player, 'myTeam', { readOnly: true })}
                    />

                    <TeamFormationCard
                      title="Opponent Squad"
                      subtitle={opponentLineupMeta.isDefaultLineup
                        ? `${FORMATIONS[oppForm]?.name || 'Current formation'} · Default lineup`
                        : FORMATIONS[oppForm]?.name || 'Current formation'}
                      suggestion={opponentPitchSuggestion}
                      emptyText={importingTeamUrl ? 'Loading opponent lineup...' : 'No active opponent lineup found for this fixture.'}
                      tone="opp"
                      onInjuryOpen={(player) => openInjuryModal(player, 'opponent', { readOnly: true })}
                    />
                  </div>
                </>
              ) : null}
          </section>
        )}

        {activeTab === 'season' && (
          <section id="tab-season" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Season Prediction</div>
                  <div className="mt-1 text-sm font-semibold text-[#e8edf5]">
                    {selectedLeagueName || 'Select a league'}
                  </div>
                  <div className="mt-1 text-xs text-[#6b7a94]">
                    Actual results and 1,000 engine simulations per remaining fixture, using current lineups. Sampling uncertainty can exceed 3 percentage points. Known boosts are included when their expiry covers the fixture; future changes are unknown. Rankings compare expected points, not top-five probabilities.
                  </div>
                </div>
                <div className="rounded-md border border-[#253040] bg-[#111620] px-3 py-2 text-xs text-[#9aa5bb]">
                    {seasonPredictionLoading || seasonEngine.status === 'running'
                      ? `Simulating season... ${seasonEngine.progress}/${seasonEngine.total}`
                      : seasonForecast.optimizedFixtureCount > 0
                      ? `${seasonForecast.optimizedFixtureCount}/${seasonForecast.ownedProjectedFixtureCount} optimized · ${seasonForecast.optimizedPointsGain >= 0 ? '+' : ''}${formatNumber(seasonForecast.optimizedPointsGain, 1)} pts vs live`
                      : `${seasonForecast.projectedFixtures.length} projected · live snapshot`}
                </div>
              </div>

              {(seasonPredictionError || seasonEngine.error) && (
                <div className="mt-3 rounded-md border border-[#ff4444]/50 bg-[#ff4444]/10 px-3 py-2 text-xs text-[#ff9e9e]">
                  {seasonPredictionError || seasonEngine.error}
                </div>
              )}

              {!seasonPredictionLoading && Object.keys(seasonBoosts).length > 0 && (
                <div className="mt-3 rounded-md border border-[#253040] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                  <div className="font-semibold text-[#e8edf5]">Upcoming opponent item checks</div>
                  {sortFixturesByRoundAndTime((teamSeasonFixtures.length ? teamSeasonFixtures : seasonFixtures).filter((fixture) => !fixture.game_result && !fixture.cup_bye && !hasFixtureStarted(fixture, currentTime) && (detectedMyTeamIds.includes(fixture.home_team_id) || detectedMyTeamIds.includes(fixture.away_team_id)))).slice(0, 6).map((fixture) => {
                    const isHome = detectedMyTeamIds.includes(fixture.home_team_id);
                    const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
                    const name = isHome ? fixture.away_team_name : fixture.home_team_name;
                    const state = seasonBoosts[opponentId];
                    const active = state?.boosts || [];
                    const covered = getBoostStateForFixture(state, fixture).boosts || [];
                    const uncertain = active.length - covered.length > 0 && active.some((entry) => !readTimeField(entry, ['expires', 'expires_at', 'expiresAt', 'ends_at', 'endsAt', 'end_time', 'endTime', 'active_until', 'activeUntil']));
                    return <div key={fixture.game_key} className="mt-2">{name} · {formatFixtureTime(fixture.game_time)}: {state?.source !== 'live' ? 'Boost check unavailable; assumed unboosted.' : `${active.length} active boost${active.length === 1 ? '' : 's'}${active.length ? ` (${active.map((entry) => getLiveBoostItemDefinition(entry)?.label || getBoostEntry(entry).boost_type || 'Unknown item').join(', ')})` : ''}, ${formatNumber(state.effectivenessPct)}% effectiveness; ${covered.length} confirmed to cover this fixture.${uncertain ? ' Some expiry times are unknown and excluded.' : ''}`}</div>;
                  })}
                  {Object.values(seasonBoosts).some((state) => state.source !== 'live') && <div className="mt-2 text-[#ffcf66]">Some team boost checks failed; those teams are assumed unboosted in projections.</div>}
                </div>
              )}
              {seasonDecisionContext.mine && (
                <div className="mt-4 border-t border-[#253040] pt-3 text-sm text-[#c7d0df]">
                  <div className="font-semibold text-[#e8edf5]">Top-five points target</div>
                  {historicalFifth.length > 0 ? <div className="mt-1 text-xs text-[#aebbd0]">Previous fifth-place totals: {historicalFifth.map((row) => `S${row.season}: ${row.points}`).join(' · ')}. Average rounded up: {seasonDecisionContext.suggested}; the cutoff can change.</div> : <div className="mt-1 text-xs text-[#aebbd0]">Historical fifth-place totals unavailable; enter a target.</div>}
                  <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">Target points <input type="number" min="0" max="200" value={pointsTarget} placeholder={seasonDecisionContext.suggested === null ? 'Enter target' : String(seasonDecisionContext.suggested)} onChange={(event) => setPointsTarget(event.target.value)} className="w-20 rounded border border-[#42536a] bg-[#111620] px-2 py-1 text-[#e8edf5]" /></label>
                  {seasonDecisionContext.needed !== null && <div className="mt-2 text-xs">{seasonDecisionContext.needed} more points needed from {seasonDecisionContext.remaining} remaining league games{seasonDecisionContext.remaining ? ` (${formatNumber(seasonDecisionContext.needed / seasonDecisionContext.remaining, 2)} per game)` : ''}. A target is a benchmark, not a guaranteed finish.</div>}
                </div>
              )}
              <SeasonPredictionTable rows={seasonForecast.rows} loading={seasonPredictionLoading || seasonEngine.status === 'running'} myTeamIds={detectedMyTeamIds} />
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <h2 className="text-sm font-semibold text-[#e8edf5]">Upcoming match levers</h2>
              <p className="mt-1 text-xs text-[#aebbd0]">Each fixture uses 1,000 engine simulations. Current effectiveness is used where available; future opponent activations are unknown.</p>
              {matchupLevers.length === 0 && <p className="mt-3 text-xs text-[#aebbd0]">Connect a team and load its lineup and fixtures to compare options.</p>}
              {matchupLevers.map((match) => <div key={match.fixture.game_key} className="mt-3 border-t border-[#253040] pt-3 text-xs text-[#c7d0df]">
                <div className="font-semibold text-[#e8edf5]">{match.name}{match.rank ? ` · ${formatOrdinal(match.rank)} now` : ''} · {formatFixtureTime(match.fixture.game_time)}</div>
                {match.unavailable ? <p className="mt-1">{seasonEngine.status === 'running' ? 'Simulating fixture…' : 'Simulation unavailable; check fixture lineups.'}</p> : <>
                  <p className="mt-1">Current setup: {formatNumber(match.base.win + match.base.draw)}% win or draw · {formatNumber(match.base.myxG, 2)}–{formatNumber(match.base.oppxG, 2)} average goals.</p>
                  {match.items.length > 0 && <p className="mt-1">Held item scenarios: {match.items.map((item) => `${item.label} ${formatNumber(item.projection.win + item.projection.draw)}% win or draw`).join(' · ')}. Scenarios replace any current boost and do not check availability at kickoff.</p>}
                  {match.swap && <p className="mt-1">Test {match.swap.candidate} for {match.swap.out}: {formatNumber(match.swap.projection.win + match.swap.projection.draw)}% win or draw. The swap is ranked by expected points; confirm roles in game.</p>}
                  <p className="mt-1">Item history: {seasonItemHistory === null ? 'unavailable' : !match.history ? 'team not found in league history' : Object.entries(match.history.items_used || {}).filter(([, count]) => Number(count) > 0).map(([key, count]) => `${({ SOCCER_ITEM_GOLDEN_TRUFFLE: 'Golden Truffle', SOCCER_ITEM_TRUFFLE: 'Magic Truffle', SOCCER_ITEM_IRIDIUM_TRUFFLE: 'Iridium Truffle', SOCCER_ITEM_HALF_TIME_ORANGE: 'Half-Time Orange' })[key] || key}: ${count} games`).join(' · ') || 'no recorded item use'}.</p>
                </>}
              </div>)}
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#ffab00]">Item Timing</div>
              <div className="mt-1 text-xs text-[#6b7a94]">
                Engine simulations compare held items and fixture windows. The first item uses current effectiveness; later uses are rounded down to the nearest 25%. Future lineups and item use remain uncertain.
              </div>
              <div className="mt-2 inline-flex rounded-md border border-[#253040] bg-[#111620] px-2 py-1 text-xs text-[#9aa5bb]">
                Detected {heldPerformanceUseCount} performance item use{heldPerformanceUseCount === 1 ? '' : 's'}
              </div>

              <div className="mt-3 flex flex-col gap-3 rounded-md border border-[#ffab00]/30 bg-[#2d230d]/45 p-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#ffab00]">Item Cooldown</div>
                  <div className="mt-1 text-xs text-[#d7bd80]">
                    {itemCooldownEndTime
                      ? `No new item will be suggested before ${formatFixtureTime(itemCooldownEndTime)}.`
                      : 'No current item cooldown is blocking suggestions.'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="Item cooldown ends"
                    className="min-h-9 rounded-md border border-[#5b4820] bg-[#111620] px-2 text-xs text-[#e8edf5] outline-none focus:border-[#ffab00]"
                    value={formatDateTimeLocalValue(itemCooldownUntil || myBoostState.cooldownUntil)}
                    onChange={(event) => {
                      const timestamp = getTimestamp(event.target.value);
                      setItemCooldownUntil(timestamp ? new Date(timestamp).toISOString() : null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setItemCooldownUntil(null)}
                    className="min-h-9 rounded-md border border-[#5b4820] px-2.5 text-xs font-semibold text-[#d7bd80] transition hover:border-[#ffab00] hover:text-[#ffca63]"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {itemPlanSummary && (
                <div className="mt-3 grid gap-2 rounded-md border border-[#253040] bg-[#111620] p-3 text-xs text-[#9aa5bb] sm:grid-cols-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">Base</div>
                    <div className="mt-1 font-['Barlow_Condensed'] text-[22px] font-black text-[#e8edf5]">
                      {formatOrdinal(itemPlanSummary.basePosition)}
                    </div>
                    <div>{formatNumber(itemPlanSummary.basePoints, 1)} pts</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">With Items</div>
                    <div className="mt-1 font-['Barlow_Condensed'] text-[22px] font-black text-[#00e676]">
                      {formatOrdinal(itemPlanSummary.projectedPosition)}
                    </div>
                    <div>{formatNumber(itemPlanSummary.projectedPoints, 1)} pts</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">Plan Value</div>
                    <div className="mt-1 font-['Barlow_Condensed'] text-[22px] font-black text-[#ffab00]">
                      {itemPlanSummary.placementGain > 0
                        ? `+${itemPlanSummary.placementGain}`
                        : Number(itemPlanSummary.promotionBufferDelta) > 0
                          ? `+${formatNumber(itemPlanSummary.promotionBufferDelta, 0)} pts`
                          : 'Hold'}
                    </div>
                    <div>
                      {itemPlanSummary.placementGain > 0
                        ? `${itemPlanSummary.itemCount} item use${itemPlanSummary.itemCount === 1 ? '' : 's'}`
                        : 'Top-five buffer'}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-2">
                {(seasonPredictionLoading || seasonEngine.status === 'running') && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">Simulating item windows...</div>
                )}
                {!seasonPredictionLoading && seasonEngine.status !== 'running' && itemSuggestions.length === 0 && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                    {heldPerformanceUseCount === 0
                      ? 'No performance boosts detected in the connected wallet. Sync wallet assets, then check again.'
                      : seasonEngine.error || seasonForecast.rows.some((row) => row.unavailable > 0)
                        ? 'Item planning needs all league fixture simulations. Check the season error and unavailable lineups.'
                        : 'No efficient held performance item window found after cooldown and coverage checks.'}
                  </div>
                )}
                {!seasonPredictionLoading && itemSuggestions.map((item) => (
                  <div key={`${item.fixture.game_key}-${item.boostKey}`} className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#253040] bg-[#161c28] text-lg">
                          {item.boostIcon || '⬢'}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[#e8edf5]">{item.boostLabel} vs {item.opponentName}</div>
                          <div className="mt-1 text-xs text-[#7f8aa3]">
                            Use round {item.fixture.game_round || '?'} • {formatFixtureTime(item.fixture.game_time)} • use {item.useNumber || 1} of {formatNumber(item.heldCount, 0)} • {formatNumber(item.remainingAfterUse, 0)} left
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-['Barlow_Condensed'] text-[22px] font-black text-[#00e676]">
                          {item.expectedPointsDelta >= 0 ? '+' : ''}{formatNumber(item.expectedPointsDelta, 2)} pts
                        </div>
                        <div className="mt-1 text-xs text-[#7f8aa3]">
                          {item.planBasePosition && item.planProjectedPosition
                            ? `Plan ${formatOrdinal(item.planBasePosition)} → ${formatOrdinal(item.planProjectedPosition)}`
                            : 'Expected points'}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-[#c7d0df]">Start no earlier than {formatFixtureTime(Math.max(Date.UTC(new Date(item.startTime).getUTCFullYear(), new Date(item.startTime).getUTCMonth(), new Date(item.startTime).getUTCDate()), currentTime, itemCooldownEndTime || 0))} and before kickoff to preserve this UTC-day coverage. Confirm expiry in game.</div>
                    <div className="mt-1 text-xs text-[#9aa5bb]">
                      Covered fixtures (minimum duration): {sortFixturesByRoundAndTime((teamSeasonFixtures.length ? teamSeasonFixtures : seasonFixtures).filter((fixture) => !fixture.game_result && !fixture.cup_bye && getFixtureTimeValue(fixture) >= item.startTime && getFixtureTimeValue(fixture) <= getUtcDayExpiryTime(item.startTime, item.minDays) && (detectedMyTeamIds.includes(fixture.home_team_id) || detectedMyTeamIds.includes(fixture.away_team_id)))).map((fixture) => detectedMyTeamIds.includes(fixture.home_team_id) ? fixture.away_team_name : fixture.home_team_name).join(', ') || item.opponentName}. First match estimated win: {formatNumber(item.baseWin)}% to {formatNumber(item.boostedWin)}%. Expected coverage {formatNumber(item.windowCount)} fixture-equivalents ({item.guaranteedWindowCount}-{item.maxWindowCount} possible over {item.minDays}-{item.maxDays} days) at {formatNumber(item.effectivenessPct)}% assumed effectiveness. Expected-point gain: {formatNumber(item.expectedPointsDelta, 2)}.
                      {Number(item.rivalCoverage) > 0 ? (
                        <> Rival leverage {formatNumber(item.rivalCoverage)}.</>
                      ) : null}
                      {item.planBasePoints !== null && item.planProjectedPoints !== null ? (
                        <> Item plan projects {formatNumber(item.planBasePoints, 0)} → {formatNumber(item.planProjectedPoints, 0)} pts.</>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}


      </main>

      {injuryModalState.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-[320px] rounded-xl border border-[#253040] bg-[#161c28] p-6">
            <div className="text-[15px] font-bold">🩹 {injuryModalState.readOnly ? 'Injury Details' : 'Injury Severity'}</div>
            <p className="mt-1 text-xs text-[#6b7a94]">{injuryModalPlayer?.name || 'Player injury status'}</p>

            {injuryModalDefinition ? (
              <div className="mt-4 rounded-[8px] border border-[rgba(255,68,68,0.25)] bg-[rgba(255,68,68,0.08)] p-3 text-xs text-[#d0d7e5]">
                <div className="font-bold text-[#ff9e9e]">
                  {injuryModalDetails?.name || injuryModalDefinition.label}
                </div>
                <div className="mt-1 text-[#9aa5bb]">
                  {injuryModalDetails?.label || injuryModalDefinition.label} · {formatNumber((injuryModalDetails?.statsReduction ?? injuryModalDefinition.reduction) * 100, 0)}% effectiveness
                </div>
                {injuryModalDetails?.expires ? (
                  <div className="mt-1 text-[#9aa5bb]">Expires {formatFixtureTime(injuryModalDetails.expires)}</div>
                ) : null}
                {injuryModalDetails?.description ? (
                  <div className="mt-2 leading-snug text-[#c5cedd]">{injuryModalDetails.description}</div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 rounded-[8px] border border-[#253040] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                No live injury details are currently attached to this player.
              </p>
            )}

            {!injuryModalState.readOnly && (
              <div className="mt-4 space-y-2">
                {[
                  { key: 'None', label: '⬜ No injury' },
                  { key: 'Low', label: '🟡 Minor — 95% effectiveness' },
                  { key: 'Mid', label: '🟠 Moderate — 90% effectiveness' },
                  { key: 'High', label: '🔴 Severe — 85% effectiveness' },
                ].map((option) => (
                  <button
                    key={option.key}
                    onClick={() => setInjuryModalState((prev) => ({ ...prev, selected: option.key }))}
                    className={`w-full rounded-[7px] border px-3 py-2 text-left text-sm ${injuryModalState.selected === option.key ? 'border-[#ffab00] bg-[rgba(255,171,0,0.08)] text-[#ffab00]' : 'border-[#1e2a3a] bg-[#111620] text-[#e8edf5]'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={closeInjuryModal} className="rounded-md border border-[#1e2a3a] bg-transparent px-3 py-1.5 text-xs font-semibold text-[#9aa5bb]">
                {injuryModalState.readOnly ? 'Close' : 'Cancel'}
              </button>
              {!injuryModalState.readOnly && (
                <button onClick={confirmInjuryModal} className="rounded-md bg-[#ffab00] px-3 py-1.5 text-xs font-bold text-black">Confirm</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// --- Components ---

function FixtureTableSection({
  title,
  fixtures,
  selectedFixtureKey,
  detectedMyTeamIds,
  fixtureWinChances = {},
  plannedItemsByFixture = {},
  activeBoostsByFixture = {},
  loading,
  emptyText,
  onSelect,
}) {
  const myTeams = new Set(detectedMyTeamIds);

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9aa5bb]">{title}</div>
        <div className="text-[11px] text-[#6b7a94]">{fixtures.length} matches</div>
      </div>
      <div className="overflow-hidden rounded-md border border-[#1e2a3a] bg-[#111620]">
        {loading && (
          <div className="p-3 text-xs text-[#9aa5bb]">Loading fixtures...</div>
        )}
        {!loading && fixtures.length === 0 && (
          <div className="p-3 text-xs text-[#9aa5bb]">{emptyText}</div>
        )}
        {!loading && fixtures.map((fixture) => {
          const isSelected = selectedFixtureKey === fixture.game_key;
          const isCup = fixture.competition === 'cup';
          const isBye = Boolean(fixture.cup_bye);
          const isResultPending = !fixture.game_result && !isBye && hasFixtureStarted(fixture);
          const isInactive = !canSelectFixture(fixture);
          const mySide = myTeams.has(fixture.home_team_id)
            ? 'home'
            : myTeams.has(fixture.away_team_id)
              ? 'away'
              : '';
          const hasPenaltyResult = fixture.game_result?.decided_on_penalties
            && fixture.game_result?.home_penalty_score !== null
            && fixture.game_result?.away_penalty_score !== null;
          const result = fixture.game_result
            ? hasPenaltyResult
              ? `${fixture.game_result.home_team_score}-${fixture.game_result.away_team_score}p`
              : `${fixture.game_result.home_team_score}-${fixture.game_result.away_team_score}`
            : isBye
              ? 'bye'
              : isResultPending
                ? 'pending'
              : 'vs';
          const chance = fixtureWinChances[fixture.game_key];
          const plannedItem = plannedItemsByFixture[fixture.game_key];
          const activeBoost = activeBoostsByFixture[fixture.game_key];

          return (
            <button
              key={fixture.game_key}
              type="button"
              onClick={() => {
                if (!isInactive) onSelect(fixture);
              }}
              disabled={isInactive}
              className={`grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[#1e2a3a] px-2 py-2 text-left text-xs transition last:border-b-0 sm:text-sm ${isSelected
                ? 'bg-[#0f2a1b] text-[#d7ffe9]'
                : isInactive
                  ? 'cursor-default text-[#7f8aa3]'
                  : 'text-[#e8edf5] hover:bg-[#161c28]'
                }`}
            >
              <div className={`min-w-0 text-right ${mySide === 'home' ? 'text-[#00e676]' : ''}`}>
                <div className="truncate">{fixture.home_team_name}</div>
                <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Home</div>
              </div>
              <div className="flex min-w-[74px] flex-col items-center">
                {isCup && (
                  <span className="mb-1 rounded border border-[#b05cff]/40 bg-[#b05cff]/12 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] text-[#d3a2ff]">
                    Cup
                  </span>
                )}
                <span className={`rounded px-2 py-1 font-bold text-black ${isCup ? 'bg-[#b05cff]' : 'bg-[#ffab00]'}`}>{result}</span>
                <span className="mt-1 text-center text-[10px] leading-tight text-[#7f8aa3]">
                  {getFixtureRoundLabel(fixture)} • {formatFixtureTime(fixture.game_time)}
                </span>
                {isBye ? (
                  <span className="mt-1 rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[#9aa5bb]">
                    Eliminated
                  </span>
                ) : isResultPending ? (
                  <span className="mt-1 rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[#9aa5bb]">
                    Result pending
                  </span>
                ) : !fixture.game_result && chance ? (
                  <span className="mt-1 rounded border border-[#00e676]/30 bg-[#00e676]/10 px-1.5 py-0.5 font-['Barlow_Condensed'] text-[13px] font-black leading-none text-[#00e676]">
                    {formatNumber(chance.win)}% estimated win
                  </span>
                ) : !fixture.game_result && mySide ? (
                  <span className="mt-1 rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[#6b7a94]">
                    Lineup pending
                  </span>
                ) : null}
                {!isInactive && !fixture.game_result && activeBoost ? (
                  <span
                    className="mt-1 inline-flex items-center gap-1 rounded border border-[#00e676]/35 bg-[#00e676]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#9af7cb]"
                    title={`${activeBoost.label} active until ${formatFixtureTime(activeBoost.endTime)}`}
                    aria-label={`${activeBoost.label} active for this fixture`}
                  >
                    <span className="text-[13px] leading-none">{activeBoost.icon || '⬢'}</span>
                    <span>Active</span>
                  </span>
                ) : !fixture.game_result && plannedItem ? (
                  <span
                    className="mt-1 inline-flex items-center gap-1 rounded border border-[#ffab00]/35 bg-[#ffab00]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#ffcf66]"
                    title={`${plannedItem.label} use ${plannedItem.useNumber || 1} of ${formatNumber(plannedItem.heldCount, 0)}`}
                    aria-label={`${plannedItem.label} suggested for this fixture`}
                  >
                    <span className="text-[13px] leading-none">{plannedItem.icon || '⬢'}</span>
                    <span>Use</span>
                  </span>
                ) : null}
              </div>
              <div className={`min-w-0 ${mySide === 'away' ? 'text-[#00e676]' : ''}`}>
                <div className="truncate">{fixture.away_team_name}</div>
                <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Away</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TeamFormationCard({ title, subtitle, suggestion, emptyText, tone = 'my', onInjuryOpen }) {
  if (!suggestion) {
    return (
      <section className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className={`text-[11px] font-bold uppercase tracking-[0.14em] ${tone === 'opp' ? 'text-[#ffab00]' : 'text-[#00e676]'}`}>{title}</div>
        <div className="mt-1 text-sm text-[#9aa5bb]">{emptyText}</div>
      </section>
    );
  }

  const details = getSuggestionDetails(suggestion);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[#1e2a3a] bg-[#111620]">
      <div className="shrink-0 border-b border-[#1e2a3a] p-3">
        <div className={`text-[11px] font-bold uppercase tracking-[0.14em] ${tone === 'opp' ? 'text-[#ffab00]' : 'text-[#00e676]'}`}>{title}</div>
          <div className="mt-1 font-['Barlow_Condensed'] text-[20px] font-black leading-none text-[#e8edf5]">
          {subtitle || details.formation}
        </div>
        {suggestion.isDefaultLineup ? (
          <div className="mt-2 text-xs text-[#9aa5bb]">Default 55 OVR players used for projection.</div>
        ) : null}
        {suggestion.lineup.length < 5 ? (
          <div className="mt-2 text-xs text-[#d7bd80]">
            Incomplete live lineup · projecting with {suggestion.lineup.length} available players.
          </div>
        ) : null}
        <TacticsSummaryChips
          tactics={suggestion.tactics}
          setPiecePlayer={details.setPiecePlayer}
          roleLabels={details.roleLabels}
          className="mt-2"
        />
      </div>
      <div className="min-h-0 flex-1">
        <FormationPitch suggestion={suggestion} details={details} onInjuryOpen={onInjuryOpen} />
      </div>
    </section>
  );
}

function TacticsSummaryChips({ tactics, setPiecePlayer, roleLabels = [], recommendation = false, className = '' }) {
  const normalizedTactics = normalizeTactics(tactics);
  const hasConfiguredSetPieceTaker = Boolean(normalizedTactics.setPieceTaker);
  const setPieceLabel = setPiecePlayer?.name || (hasConfiguredSetPieceTaker ? 'Unavailable' : 'Auto');
  const setPieceTitle = setPiecePlayer
    ? recommendation
      ? `${setPiecePlayer.name} is the recommended set-piece taker. Automatic selection and up to four specialist candidates were compared.`
      : `${setPiecePlayer.name} is the set-piece taker configured in the live team lineup.`
    : hasConfiguredSetPieceTaker
      ? 'A set-piece taker is configured, but that player is not in the active lineup returned by Lost Pigs.'
      : recommendation
        ? 'Auto won the projection comparison. It lets the game weight a different receiver for each chance; naming one player locks free kicks and penalties to them and removes them from corner finishes. Free kicks use ATT + 3x TEC, penalties use 2x ATT + 3x CMP, and WOR affects control rather than set-piece selection.'
        : 'No fixed set-piece taker is configured in the live lineup; the game chooses automatically.';

  return (
    <div className={`flex flex-wrap gap-1.5 text-[10px] leading-tight text-[#d0d7e5] ${className}`}>
      <span className="rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5">Press {TACTICS.press[normalizedTactics.press]?.label}</span>
      <span className="rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5">Tempo {TACTICS.tempo[normalizedTactics.tempo]?.label}</span>
      <span className="rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5">Line {TACTICS.lineHeight[normalizedTactics.lineHeight]?.label}</span>
      <span
        title={setPieceTitle}
        aria-label={`Set pieces: ${setPieceLabel}`}
        className="rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5"
      >
        Set pieces {setPieceLabel}
      </span>
      {roleLabels.map((roleLabel) => (
        <span key={roleLabel} className="max-w-full truncate rounded border border-[#253040] bg-[#161c28] px-1.5 py-0.5">{roleLabel}</span>
      ))}
    </div>
  );
}

function SeasonPredictionTable({ rows, loading, myTeamIds }) {
  const myTeams = new Set(myTeamIds);

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-[#1e2a3a] bg-[#111620]">
      <div className="grid grid-cols-[30px_minmax(0,1fr)_48px_52px_86px] gap-2 border-b border-[#1e2a3a] px-2 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">
        <div>#</div>
        <div>Team</div>
        <div className="text-right">Pts</div>
        <div className="text-right">GD</div>
        <div className="text-right">W-D-L</div>
      </div>
      {loading && (
        <div className="p-3 text-xs text-[#9aa5bb]">Loading every team configuration...</div>
      )}
      {!loading && rows.length === 0 && (
        <div className="p-3 text-xs text-[#9aa5bb]">Open this tab after selecting a league to generate the season prediction.</div>
      )}
      {!loading && rows.some((row) => row.unavailable > 0) && <div className="p-3 text-xs text-[#ffcf66]">Some fixtures could not be simulated. The projected table is unavailable until every lineup is loaded.</div>}
      {!loading && !rows.some((row) => row.unavailable > 0) && rows.slice(0, 24).map((row, index) => (
        <div
          key={row.teamId}
          className={`grid grid-cols-[30px_minmax(0,1fr)_48px_52px_86px] gap-2 border-b border-[#1e2a3a] px-2 py-2 text-xs last:border-b-0 ${myTeams.has(row.teamId) ? 'bg-[#0f2a1b] text-[#d7ffe9]' : 'text-[#d0d7e5]'}`}
        >
          <div className="font-bold text-[#6b7a94]">{index + 1}</div>
          <div className="min-w-0 truncate font-semibold">{row.teamName}</div>
          <div className="text-right font-bold tabular-nums text-[#00e676]">{formatNumber(row.points, 1)}</div>
          <div className="text-right">{formatNumber(row.gd, 1)}</div>
          <div className="text-right tabular-nums">
            {`${formatNumber(row.won, 1)}-${formatNumber(row.drawn, 1)}-${formatNumber(row.lost, 1)}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function BestSetupCard({ suggestion, liveSetup, analyzing, syncing = false, fallbackLabel = '', syncError = '', canAnalyze, lineupGaps = [], onInjuryOpen, error = '', progress = '' }) {
  if (error) return <section role="alert" className="mb-4 rounded-[10px] border border-[#ff4444]/50 bg-[#111620] p-4 text-sm text-[#ff9e9e]">{error}</section>;
  if (!canAnalyze) {
    return (
      <section className="mb-4 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Recommended Setup</div>
        <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-[#e8edf5]">
          {syncing && <Loader2 size={14} className="animate-spin text-[#00e676]" />}
          {syncing
            ? 'Syncing wallet squad'
            : syncError
              ? 'Wallet squad sync needs another try'
              : 'Waiting for squad and opponent lineups'}
        </div>
        <div className="mt-1 text-xs text-[#6b7a94]">
          {syncing
            ? 'Reading held players now; live lineup details will follow in the background.'
            : syncError
              ? syncError
            : 'Once both teams are available, the calculator will pick the setup automatically.'}
        </div>
      </section>
    );
  }

  if (analyzing && !suggestion) {
    return (
      <section className="mb-4 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#e8edf5]">
          <Loader2 size={14} className="animate-spin text-[#00e676]" />
          {progress || 'Simulating setups…'}
        </div>
      </section>
    );
  }

  if (!suggestion) {
    return (
      <section aria-live="polite" className="mb-4 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">No Valid Lineup</div>
        <div className="mt-1 text-sm font-semibold text-[#e8edf5]">The squad cannot fill a complete formation.</div>
        <div className="mt-1 text-xs text-[#6b7a94]">
          {lineupGaps.length > 0
            ? `Add: ${lineupGaps.join(', ')}.`
            : 'Check that players have eligible positions and the opponent lineup is available.'}
        </div>
      </section>
    );
  }

  const details = getSuggestionDetails(suggestion);
  const comparison = compareSetup(liveSetup, suggestion);
  const formationChanged = comparison?.changes.some((change) => change.type === 'formation');

  return (
    <section aria-busy={analyzing} className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[rgba(0,230,118,0.28)] bg-[#111620]">
      <div className="shrink-0 border-b border-[#1e2a3a] p-3">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Recommended Setup</div>
            {analyzing && (
              <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#00e676]/30 bg-[#0f2a1b] px-2 py-1 text-[10px] font-semibold text-[#9af7cb]">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                Updating
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-[#aebbd0]">The engine screens a limited set of lineups and tactics, then simulates finalists 5,000 times. The recommendation maximizes expected points; it is not an exhaustive search.</p>
          <div className="mt-1 font-['Barlow_Condensed'] text-[20px] font-black leading-none text-[#e8edf5]">
            {details.formation}{formationChanged && <span className="ml-2 rounded bg-[#ffcf66] px-1.5 py-0.5 align-middle font-sans text-[10px] font-bold text-[#241900]">CHANGE FORMATION</span>}
          </div>
          <TacticsSummaryChips
            tactics={suggestion.tactics}
            setPiecePlayer={details.setPiecePlayer}
            roleLabels={details.roleLabels}
            recommendation
            className="mt-2"
          />
          <div className="mt-3 max-h-36 overflow-y-auto rounded-md border border-[#42536a] bg-[#161c28] p-2 text-xs text-[#d0d7e5]" aria-live="polite">
            <div className="font-semibold text-[#e8edf5]">Changes to make in game</div>
            {!comparison ? <p className="mt-1 text-[#b8c4d6]">Live team selection unavailable. Refresh the fixture to compare.</p> : comparison.changes.length === 0 ? <p className="mt-1 text-[#9af7cb]">{comparison.tacticsAvailable && comparison.positionsAvailable ? 'Your live setup matches this recommendation.' : 'Players match; some live positions or tactics are unavailable.'}</p> : <ul className="mt-1 list-disc space-y-0.5 pl-4">{comparison.changes.map((change, index) => <li key={`${change.type}-${index}`}>{change.text}</li>)}</ul>}
            {comparison && (!comparison.tacticsAvailable || !comparison.positionsAvailable) && comparison.changes.length > 0 && <p className="mt-1 text-[#ffcf66]">Some live positions, tactics or set-piece details are unavailable.</p>}
          </div>
          {fallbackLabel && (
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#9aa5bb]">
              {fallbackLabel} · wallet collection {syncError ? 'unavailable' : 'syncing'}
            </div>
          )}
          <p aria-live="polite" className="sr-only">
            {analyzing ? 'Updating recommended setup.' : 'Recommended setup is current.'}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <FormationPitch suggestion={suggestion} details={details} onInjuryOpen={onInjuryOpen} comparison={comparison} />
      </div>
    </section>
  );
}

function FormationPitch({ suggestion, details, onInjuryOpen, comparison = null }) {
  const rows = details.rows;
  const pitchStyle = {
    backgroundColor: '#49b83f',
    backgroundImage: [
      'linear-gradient(90deg, rgba(255,255,255,0.08) 50%, transparent 50%)',
      'linear-gradient(0deg, rgba(255,255,255,0.08) 50%, transparent 50%)',
      'linear-gradient(90deg, rgba(7,17,12,0.14) 1px, transparent 1px)',
      'linear-gradient(0deg, rgba(7,17,12,0.14) 1px, transparent 1px)',
    ].join(', '),
    backgroundSize: '96px 96px, 96px 96px, 24px 24px, 24px 24px',
  };

  return (
    <div className="h-full min-h-0 p-2">
      <div className="relative h-full min-h-0 overflow-hidden rounded-[8px] border border-[#1e2a3a]" style={pitchStyle}>
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/20" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20" />
        <div className="pointer-events-none absolute inset-x-[18%] bottom-0 h-[19%] border border-b-0 border-white/20" />
        <div className="pointer-events-none absolute inset-x-[18%] top-0 h-[19%] border border-t-0 border-white/20" />

        <div className="relative z-10 flex h-full min-h-[430px] flex-col justify-between gap-4 px-3 py-4 sm:min-h-[520px] sm:px-5 lg:min-h-0 lg:gap-2 lg:px-3 lg:py-3">
          {rows.map((row) => (
            <div key={row.pos} className="flex min-h-0 min-w-0 flex-1 flex-col justify-center">
              <div className="mb-0.5 shrink-0 text-center font-['Barlow_Condensed'] text-[10px] font-black uppercase leading-none tracking-[0.14em] text-[#0d2414] lg:text-[11px]">
                {row.label}
              </div>
              <div
                className="grid min-h-0 flex-1 content-center items-stretch justify-center gap-2.5 sm:gap-4 lg:gap-2"
                style={{
                  gridTemplateColumns: `repeat(${row.players.length}, minmax(0, 1fr))`,
                  gridAutoRows: '1fr',
                }}
              >
                {row.players.map((player) => (
                  <div key={`${row.pos}-${player.id}`} className="mx-auto aspect-[4/5] h-full w-auto max-w-[130px] min-w-0">
                    <FormationPlayerCard
                      player={player}
                      setPieceTaker={suggestion.tactics?.setPieceTaker}
                      changes={comparison?.playerChanges[comparison.playerKey(player)] || []}
                      onInjuryOpen={onInjuryOpen}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FormationPlayerCard({ player, setPieceTaker, onInjuryOpen, changes = [] }) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonPosition, setReasonPosition] = useState({ left: 0, top: 0, width: 288 });
  const role = player.role
    ? Object.values(PLAYER_ROLES).find((entry) => entry.value === player.role)
    : null;
  const roleLabel = role?.label
    ? role.label.replace('Target Man', 'Target').replace('Ball Winner', 'Winner')
    : '';
  const selectedPosition = player.selectedPosition || player.pos;
  const playablePositions = player.positions && player.positions.length > 0 ? player.positions : [player.pos];
  const playableLabel = playablePositions.join('/');
  const isSetPieceTaker = setPieceTaker && String(setPieceTaker) === String(player.id);
  const injury = player.injury && INJURIES[player.injury] ? INJURIES[player.injury] : null;
  const injuryTitle = injury
    ? `${player.injuryDetails?.name || injury.label} - ${injury.label}`
    : '';
  const positionTone = selectedPosition === 'GK'
    ? 'from-[#f4d44d] to-[#b58a13] text-[#1d1703]'
    : selectedPosition === 'DF'
      ? 'from-[#3c8df0] to-[#18539a] text-white'
      : selectedPosition === 'MF'
        ? 'from-[#59d171] to-[#217a35] text-[#06130a]'
        : 'from-[#ff7070] to-[#b52235] text-white';
  const reasonId = `selection-reason-${player.id}`;

  useEffect(() => {
    if (!reasonOpen) return undefined;

    const closeReason = () => setReasonOpen(false);
    window.addEventListener('resize', closeReason);
    window.addEventListener('scroll', closeReason, true);

    return () => {
      window.removeEventListener('resize', closeReason);
      window.removeEventListener('scroll', closeReason, true);
    };
  }, [reasonOpen]);

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[8px] border bg-[#d8c22f] shadow-[4px_5px_0_rgba(7,17,12,0.35)] ${changes.length ? 'border-[#ffb300] ring-2 ring-[#ffb300]' : 'border-[#142315]'}`}>
      {changes.length > 0 && <div className="shrink-0 bg-[#ffcf66] px-1 py-0.5 text-center text-[9px] font-bold uppercase text-[#241900]" aria-label={`Changes: ${changes.join(', ')}`}>{changes.join(' · ')}</div>}
      <div className="flex min-h-[30px] shrink-0 items-start justify-between gap-1 bg-[#d9bd2b] px-1.5 py-1">
        <div className="min-w-0 flex-1 self-center truncate font-['Barlow_Condensed'] text-[11px] font-black uppercase leading-[0.95] tracking-[0.02em] text-[#2a2713]">
          {player.name}
        </div>
        <div className={`w-[26px] shrink-0 rounded-[4px] bg-gradient-to-b px-1 py-0.5 text-center font-['Barlow_Condensed'] text-[10px] font-black ${positionTone}`}>
          {selectedPosition}
        </div>
      </div>
      <div className="relative aspect-square overflow-hidden bg-[#f0e6a1] lg:aspect-auto lg:min-h-0 lg:flex-1">
        <PlayerCardPortrait player={player} />
        {player.selectionReason && (
          <div className="absolute right-2 top-2">
            <button
              type="button"
              onClick={(event) => {
                const buttonRect = event.currentTarget.getBoundingClientRect();
                const width = Math.min(288, window.innerWidth - 24);
                const estimatedHeight = 220;
                const left = Math.min(
                  Math.max(12, buttonRect.right - width),
                  Math.max(12, window.innerWidth - width - 12),
                );
                let top = buttonRect.bottom + 8;
                if (top + estimatedHeight > window.innerHeight - 12) {
                  top = Math.max(12, buttonRect.top - estimatedHeight - 8);
                }

                setReasonPosition({ left, top, width });
                setReasonOpen((open) => !open);
              }}
              onBlur={() => setReasonOpen(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setReasonOpen(false);
              }}
              aria-label={`Why ${player.name} was selected`}
              title="Why this player was selected"
              aria-expanded={reasonOpen}
              aria-describedby={reasonOpen ? reasonId : undefined}
              className="relative flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white transition-[background-color,transform] duration-150 after:absolute after:-inset-2 after:rounded-full after:content-[''] hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.96]"
            >
              <Info size={15} strokeWidth={2} aria-hidden="true" />
            </button>
            {reasonOpen && (
              <div
                id={reasonId}
                role="note"
                style={{
                  left: `${reasonPosition.left}px`,
                  top: `${reasonPosition.top}px`,
                  width: `${reasonPosition.width}px`,
                }}
                className="fixed z-[200] max-h-[calc(100vh-24px)] overflow-y-auto rounded-md border border-white/25 bg-[rgba(10,13,18,0.96)] p-2.5 text-xs font-medium normal-case leading-snug tracking-normal text-[#e8edf5] shadow-[0_12px_28px_rgba(4,8,12,0.5)]"
              >
                {player.selectionReason}
              </div>
            )}
          </div>
        )}
        {injury && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (onInjuryOpen) onInjuryOpen(player);
            }}
            className="absolute left-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-[5px] border border-white/70 bg-[#d73535] px-1.5 font-['Barlow_Condensed'] text-[18px] font-black leading-none text-white shadow-[2px_2px_0_rgba(7,17,12,0.4)] transition after:absolute after:-inset-2 after:content-[''] hover:bg-[#ff4444] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            title={injuryTitle}
            aria-label={injuryTitle}
          >
            +
          </button>
        )}
        <div className="absolute bottom-0 left-0 right-0 flex h-[22px] items-center justify-between gap-1 bg-[rgba(17,22,32,0.72)] px-1.5 font-['Barlow_Condensed'] text-[10px] font-black uppercase leading-none text-white">
          <span className="min-w-0 truncate">{isSetPieceTaker ? 'SP' : roleLabel}</span>
          <span className="min-w-0 truncate text-right">{player.outOfPosition ? `OOP ${playableLabel}` : playableLabel}</span>
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center justify-center gap-1.5 bg-[#c9ad28] px-2 font-['Barlow_Condensed'] text-[14px] font-black uppercase leading-none tracking-[0.06em] text-[#4a4114]">
        <span>{selectedPosition}</span>
        <span aria-hidden="true" className="text-[#6a5c1a]">|</span>
        <span>{player.ovr}</span>
      </div>
    </div>
  );
}

function PlayerCardPortrait({ player }) {
  const [imageSrc, setImageSrc] = useState(
    player.imageUrl && !player.imageUrl.startsWith('ipfs://') ? player.imageUrl : null,
  );
  const [fallbackSrc, setFallbackSrc] = useState(null);
  const displayedSrc = fallbackSrc || imageSrc;

  useEffect(() => {
    let cancelled = false;
    if (player.imageUrl) {
      setImageSrc(player.imageUrl);
      return undefined;
    }
    if (!player.assetId) {
      setImageSrc(null);
      return undefined;
    }

    const controller = new AbortController();
    resolvePlayerImage({ assetId: player.assetId, imageUrl: player.imageUrl }, controller.signal).then((resolved) => {
      if (!cancelled) {
        setImageSrc(resolved || null);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [player.assetId, player.imageUrl, player.id]);

  useEffect(() => {
    setFallbackSrc(null);
  }, [imageSrc]);

  if (!displayedSrc) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#d9d1a5] font-['Barlow_Condensed'] text-[16px] font-black text-[#6c653f]">
        NFT
      </div>
    );
  }

  return (
    <img
      src={displayedSrc}
      alt={player.name}
      className="absolute inset-0 h-full w-full object-cover"
      loading="lazy"
      crossOrigin={crossOriginForImageUrl(displayedSrc)}
      onError={() => {
        const genericFallback = getGenericIpfsFallback(imageSrc);
        if (genericFallback && genericFallback !== imageSrc && !fallbackSrc) {
          setFallbackSrc(genericFallback);
        } else {
          setImageSrc(null);
        }
      }}
    />
  );
}

function OutcomeBar({ label, value, color, textClass }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-10 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6b7a94]">{label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded bg-[#161c28]">
        <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }} />
      </div>
      <div className={`w-12 text-right font-['Barlow_Condensed'] text-base font-bold ${textClass}`}>{value.toFixed(1)}%</div>
    </div>
  );
}

function AssetAvatar({ player }) {
  const [imageSrc, setImageSrc] = useState(
    player.imageUrl && !player.imageUrl.startsWith('ipfs://') ? player.imageUrl : null,
  );
  const [fallbackSrc, setFallbackSrc] = useState(null);
  const displayedSrc = fallbackSrc || imageSrc;

  useEffect(() => {
    let cancelled = false;
    if (player.imageUrl) {
      setImageSrc(player.imageUrl);
      return undefined;
    }
    if (!player.assetId) {
      setImageSrc(null);
      return undefined;
    }

    const controller = new AbortController();
    resolvePlayerImage({ assetId: player.assetId, imageUrl: player.imageUrl }, controller.signal).then((resolved) => {
      if (!cancelled) {
        setImageSrc(resolved || null);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [player.assetId, player.imageUrl, player.id]);

  useEffect(() => {
    setFallbackSrc(null);
  }, [imageSrc]);

  const primaryPos = player.positions && player.positions.length > 0 ? player.positions[0] : player.pos;
  const badgeClass = primaryPos === 'GK'
    ? 'bg-[#b8860b] text-white'
    : primaryPos === 'DF'
      ? 'bg-[#1e5fa8] text-white'
      : primaryPos === 'MF'
        ? 'bg-[#1a7a3a] text-white'
        : 'bg-[#cc3333] text-white';

  return (
    <div className="relative h-[46px] w-[46px] shrink-0">
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt={player.name}
          className="h-full w-full rounded-[8px] border border-[#253040] bg-[#161c28] object-cover"
          loading="lazy"
          crossOrigin={crossOriginForImageUrl(displayedSrc)}
          onError={() => {
            const genericFallback = getGenericIpfsFallback(imageSrc);
            if (genericFallback && genericFallback !== imageSrc && !fallbackSrc) {
              setFallbackSrc(genericFallback);
            } else {
              setImageSrc(null);
            }
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-[8px] border border-[#253040] bg-[#161c28] text-[10px] font-bold text-[#9aa5bb]">
          NFT
        </div>
      )}
      <div
        className={`absolute -bottom-1 -right-1 rounded-[3px] px-1 py-0.5 font-['Barlow_Condensed'] text-[9px] font-bold leading-none ${badgeClass}`}
        style={{ border: '1.5px solid #111620' }}
      >
        {(player.positions && player.positions.length > 0 ? player.positions : [player.pos]).join('/')}
      </div>
    </div>
  );
}

function StatCell({ label, baseValue, boostedValue, isLast }) {
  const base = Number(baseValue ?? 0);
  const boosted = Number(boostedValue ?? base);
  const delta = boosted - base;
  const isUp = delta > 0;
  const isDown = delta < 0;
  const separator = delta === 0 ? '—' : '→';
  const boostedClass = isUp ? 'text-[#00e676]' : isDown ? 'text-[#ff4444]' : 'text-[#6b7a94]';

  return (
    <div className={`relative min-w-0 px-3 py-2 ${isLast ? '' : 'border-r border-[#1e2a3a]'}`}>
      {isUp && <div className="absolute right-2 top-[7px] h-[5px] w-[5px] rounded-full bg-[#00e676] shadow-[0_0_5px_#00e676]" />}
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7a94]">{label}</div>
      <div className="flex min-w-0 items-baseline gap-1">
        <span className="font-['Barlow_Condensed'] text-[20px] font-bold leading-none text-[#e8edf5]">{formatStatValue(base)}</span>
        <span className="text-[10px] text-[#253040]">{separator}</span>
        <span className={`min-w-0 truncate font-['Barlow_Condensed'] text-[14px] font-bold leading-none ${boostedClass}`}>{formatStatValue(boosted)}</span>
      </div>
    </div>
  );
}

function PlayerRow({ player, onInjuryOpen, onRoleChange, onSwap, isBench }) {
  const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1.0;
  const scores = {
    CTL: getControlScore(player.stats, player.pos, injuryMod),
    ATT: getAttackScore(player.stats, player.pos, injuryMod),
    DEF: getDefenseScore(player.stats, player.pos, injuryMod),
  };

  const source = player.source || 'manual';
  const sourceBadgeClass = source === 'wallet'
    ? 'bg-[rgba(41,121,255,0.12)] text-[#5b9cff] border-[rgba(41,121,255,0.3)]'
    : source === 'team-url'
      ? 'bg-[rgba(0,229,204,0.1)] text-[#00e5cc] border-[rgba(0,229,204,0.3)]'
      : 'bg-[#1a2133] text-[#9aa5bb] border-[#253040]';
  const sourceLabel = source === 'wallet'
    ? 'Wallet'
    : source === 'team-url'
      ? 'Team URL'
      : source === 'upload'
        ? 'Upload'
        : 'Manual';

  const statCells = player.pos === 'GK'
    ? [
      { key: 'ctl', label: 'Control', base: player.stats.CTL, boosted: scores.CTL },
      { key: 'gkp', label: 'GK Power', base: player.stats.GKP, boosted: scores.DEF },
    ]
    : [
      { key: 'ctl', label: 'Control', base: player.stats.CTL, boosted: scores.CTL },
      { key: 'att', label: 'Attack', base: player.stats.ATT, boosted: scores.ATT },
      { key: 'def', label: 'Defense', base: player.stats.DEF, boosted: scores.DEF },
    ];

  const canSwap = typeof onSwap === 'function' && Boolean(isBench);

  return (
    <div className="mb-2.5 overflow-hidden rounded-[12px] border border-[#1e2a3a] bg-[#111620] transition-colors hover:border-[#253040]">
      <div
        className={`flex items-center gap-3 px-[14px] pb-[10px] pt-3 ${canSwap ? 'cursor-pointer' : ''}`}
        onClick={canSwap ? onSwap : undefined}
      >
        <AssetAvatar player={player} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold text-[#e8edf5]">{player.name}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#9aa5bb]">
              <Zap size={10} /> {player.stats.SPD}
            </span>
            <span className={`rounded-[3px] border px-[7px] py-0.5 text-[9px] font-bold ${sourceBadgeClass}`}>{sourceLabel}</span>
            {player.injury && INJURIES[player.injury] && (
              <span className="rounded-[3px] border border-[rgba(255,68,68,0.35)] bg-[rgba(255,68,68,0.12)] px-2 py-0.5 text-[10px] font-bold text-[#ff4444]">
                {INJURIES[player.injury].label}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7a94]">OVR</div>
          <div className="font-['Barlow_Condensed'] text-[36px] font-black leading-none text-[#e8edf5]">{player.ovr}</div>
        </div>
      </div>

      <div className={`grid border-t border-[#1e2a3a] ${player.pos === 'GK' ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {statCells.map((cell, index) => (
          <StatCell
            key={cell.key}
            label={cell.label}
            baseValue={cell.base}
            boostedValue={cell.boosted}
            isLast={index === statCells.length - 1}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1e2a3a] px-[14px] py-2">
        {typeof onRoleChange === 'function' && (
          <select
            value={player.role || ''}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onRoleChange(event.target.value)}
            className="rounded-[5px] border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-[11px] font-semibold text-[#9aa5bb] outline-none hover:border-[#00e676] focus:border-[#00e676]"
          >
            {Object.values(PLAYER_ROLES).map((role) => (
              <option key={role.value || 'none'} value={role.value}>{role.label}</option>
            ))}
          </select>
        )}
        <button
          onClick={(event) => {
            event.stopPropagation();
            if (onInjuryOpen) onInjuryOpen();
          }}
          className={`inline-flex items-center gap-1 rounded-[5px] border px-3 py-1.5 text-[11px] font-semibold transition-colors ${player.injury
            ? 'border-[rgba(255,171,0,0.4)] bg-[rgba(255,171,0,0.08)] text-[#ffab00]'
            : 'border-[#1e2a3a] text-[#6b7a94] hover:border-[#ffab00] hover:text-[#ffab00]'
            }`}
        >
          🩹 {player.injury ? INJURIES[player.injury].label : 'Injury'}
        </button>
      </div>
    </div>
  );
}
