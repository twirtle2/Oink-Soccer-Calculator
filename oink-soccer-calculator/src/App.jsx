import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Bandage, X, TrendingUp, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import {
  fetchHeldAssetBalancesForAddresses,
  fetchHeldAssetIdsForAddresses,
} from './lib/indexer';
import { applyLiveLineupInjuries, buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import {
  fetchCurrentSeason,
  fetchGameCounter,
  fetchLeagueSeasonFixtures,
  fetchLeagueTableTeams,
  fetchLeagueTeamsIndex,
  fetchSeasonTournamentFixtures,
  fetchTeamSeasonFixtures,
  fetchTeamLineup,
  fetchTeamBoostState,
  importOpponentFromTeamInput,
  resolveOwnedTeamLeagues,
} from './lib/lostPigsTeamImport';
import {
  createEmptyTeamBoostState,
  createManualFallbackBoostState,
  getBoostMultipliersFromState,
} from './lib/boosts';
import { resolvePlayerImage } from './lib/assetImages';
import {
  BOOSTS,
  CHANCE_TYPES,
  DEFENSE_BIAS_MULTIPLIER,
  DR_DECAY,
  DR_MIN,
  FORMATIONS,
  FORMATION_CHANCE_RANGES,
  FORMATION_PROFILES,
  OUT_OF_POSITION_SCALE,
  PLAYER_ROLES,
  POSITION_WEIGHTS,
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

// --- Event Count Logic (Home/Away Bias + v2 Tempo) ---
const getAverageEvents = (homeFormKey, awayFormKey, homeAdvantage, myTacticsInput = DEFAULT_TACTICS, oppTacticsInput = DEFAULT_TACTICS) => {
  const homeStyle = FORMATIONS[homeFormKey]?.style || 'BAL';
  const awayStyle = FORMATIONS[awayFormKey]?.style || 'BAL';
  const myTactics = normalizeTactics(myTacticsInput);
  const oppTactics = normalizeTactics(oppTacticsInput);

  // In the core game, the truth table is fixed as HOME:formation|AWAY:formation.
  // We need to decide which team is 'Home' and which is 'Away' based on the user's toggle.
  let key;
  if (homeAdvantage === 'home') {
    // My team is Home
    key = `HOME:${homeStyle}|AWAY:${awayStyle}`;
  } else {
    // Opponent team is Home
    key = `HOME:${awayStyle}|AWAY:${homeStyle}`;
  }

  const range = FORMATION_CHANCE_RANGES[key] || { min: 3, max: 10 };
  const tempoFactor = (
    (TACTICS.tempo[myTactics.tempo]?.chanceFactor || 1)
    + (TACTICS.tempo[oppTactics.tempo]?.chanceFactor || 1)
  ) / 2;
  return ((range.min + range.max) / 2) * tempoFactor;
};

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

const getControlScore = (stats, pos, injuryMod = 1.0, boostMults = {}, tacticsInput = DEFAULT_TACTICS) => {
  const boosted = getBoostedStats(stats, boostMults);
  const tactics = normalizeTactics(tacticsInput);
  let raw;
  if (tactics.press === 'high') {
    raw = weightedRounded((boosted.CTL * 3) + (boosted.WRT * 2), 5);
  } else if (tactics.press === 'low') {
    raw = weightedRounded((boosted.CTL * 5) + boosted.WRT, 6);
  } else {
    raw = weightedRounded((boosted.CTL * 4) + boosted.WRT, 5);
  }
  return applySkillCurve(raw) * injuryMod;
};

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

const captainBoost = (players) => {
  const captain = players.find((player) => player.role === PLAYER_ROLES.captain.value);
  if (!captain) return 1;
  return 1 + ((captainQuality(captain) - 60) / 100) * 0.06;
};

const captainSelfBoost = (player) => {
  if (player.role !== PLAYER_ROLES.captain.value) return 1;
  return 1 + ((captainQuality(player) - 60) / 100) * 0.06;
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

const rolePositionAverage = (assignedPlayers, weights, scoreFn, roleWeights = {}) => {
  const buckets = {
    GK: { sum: 0, weight: 0 },
    DF: { sum: 0, weight: 0 },
    MF: { sum: 0, weight: 0 },
    FW: { sum: 0, weight: 0 },
  };

  for (const player of assignedPlayers) {
    const pos = player.selectedPosition || player.pos;
    const bucket = buckets[pos];
    if (!bucket) continue;
    const roleWeight = roleWeights[player.role] || 1;
    bucket.sum += scoreFn(player) * roleWeight;
    bucket.weight += roleWeight;
  }

  let total = 0;
  let populatedWeight = 0;
  for (const [pos, bucket] of Object.entries(buckets)) {
    if (bucket.weight <= 0) continue;
    total += (bucket.sum / bucket.weight) * (weights[pos] || 0);
    populatedWeight += weights[pos] || 0;
  }

  return populatedWeight > 0 ? total / populatedWeight : 0;
};

const cornerDeliveryFactor = (assignedPlayers, tacticsInput) => {
  const tactics = normalizeTactics(tacticsInput);
  if (!tactics.setPieceTaker) return 1;
  const taker = assignedPlayers.find((player) => String(player.id) === String(tactics.setPieceTaker));
  if (!taker) return 1;
  const technique = getStat(taker.stats, 'TEC', 'CTL');
  return Math.max(0.80, Math.min(1.20, 1 + ((technique - 60) / 100) * 0.40));
};

const expectedChanceAttack = (assignedPlayers, boostMults, tacticsInput) => {
  if (assignedPlayers.length === 0) return 0;
  const tactics = normalizeTactics(tacticsInput);
  let totalWeightedAttack = 0;
  let totalChanceWeight = 0;

  for (const [chanceType, profile] of Object.entries(CHANCE_TYPES)) {
    let attackerScore = 0;
    let attackerWeight = 0;
    const directSetPiece = tactics.setPieceTaker && ['FreeKick', 'Penalty'].includes(chanceType);
    const excludedCornerTaker = tactics.setPieceTaker && chanceType === 'Corner';

    for (const player of assignedPlayers) {
      if (excludedCornerTaker && String(player.id) === String(tactics.setPieceTaker)) continue;
      if (directSetPiece && String(player.id) !== String(tactics.setPieceTaker)) continue;

      const posWeight = profile.positionWeights[player.selectedPosition || player.pos] || 0;
      if (posWeight <= 0) continue;

      const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1;
      const positionMod = player.outOfPosition ? OUT_OF_POSITION_SCALE : 1;
      const selfMod = captainSelfBoost(player);
      const score = getAttackScoreForChance(player.stats, chanceType, injuryMod * positionMod * selfMod, boostMults);
      const roleWeight = player.role === PLAYER_ROLES.targetMan.value && ['Corner', 'Cross'].includes(chanceType) ? 2 : 1;
      const weight = posWeight * Math.max(1, score) * roleWeight;
      attackerScore += score * weight;
      attackerWeight += weight;
    }

    if (attackerWeight <= 0) continue;
    const delivery = chanceType === 'Corner' ? cornerDeliveryFactor(assignedPlayers, tactics) : 1;
    totalWeightedAttack += (attackerScore / attackerWeight) * profile.attackBoost * delivery * profile.baseWeight;
    totalChanceWeight += profile.baseWeight;
  }

  return totalChanceWeight > 0 ? totalWeightedAttack / totalChanceWeight : 0;
};

const calculateTeamScores = (players, formationKey, boostContext, tacticsInput = DEFAULT_TACTICS) => {
  const form = FORMATIONS[formationKey];
  const profile = FORMATION_PROFILES[formationKey] || {
    possession: 1,
    chanceCreation: 1,
    chanceQuality: 1,
    defSolidity: 1,
  };
  const tactics = normalizeTactics(tacticsInput);
  const boostMults = getBoostMultipliersFromState(boostContext);

  const stats = {
    Control: 0, Defense: 0, Attack: 0,
    AvgControl: 0, AvgDefense: 0, AvgAttack: 0,
    Count: players.length
  };

  if (players.length === 0) return stats;

  const assignedPlayers = assignLineupPositions(players, form.structure);
  const teamCaptainBoost = captainBoost(assignedPlayers);

  const getPlayerMod = (player) => {
    const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1;
    const positionMod = player.outOfPosition ? OUT_OF_POSITION_SCALE : 1;
    return injuryMod * positionMod * captainSelfBoost(player);
  };

  const rawControl = rolePositionAverage(
    assignedPlayers,
    POSITION_WEIGHTS.control,
    (player) => getControlScore(player.stats, player.selectedPosition, getPlayerMod(player), boostMults, tactics),
    { [PLAYER_ROLES.playmaker.value]: 2 },
  );

  const rawDefense = rolePositionAverage(
    assignedPlayers,
    POSITION_WEIGHTS.defense,
    (player) => getDefenseScore(player.stats, player.selectedPosition, getPlayerMod(player), boostMults, tactics),
    { [PLAYER_ROLES.ballWinner.value]: 2 },
  );

  stats.Control = rawControl
    * profile.possession
    * teamCaptainBoost;

  stats.Defense = rawDefense
    * profile.defSolidity
    * (TACTICS.lineHeight[tactics.lineHeight]?.defenseFactor || 1)
    * teamCaptainBoost
    * DEFENSE_BIAS_MULTIPLIER;

  stats.Attack = expectedChanceAttack(assignedPlayers, boostMults, tactics)
    * profile.chanceCreation
    * profile.chanceQuality
    * (TACTICS.tempo[tactics.tempo]?.qualityFactor || 1)
    * (TACTICS.press[tactics.press]?.fatigueFactor || 1);

  stats.Control = parseFloat(stats.Control.toFixed(1));
  stats.Defense = parseFloat(stats.Defense.toFixed(1));
  stats.Attack = parseFloat(stats.Attack.toFixed(1));

  return stats;
};

const calcGoalProb = (att, def) => {
  const total = Math.max(1, att) + Math.max(1, def);
  return Math.max(0.01, Math.min(0.9, Math.max(1, att) / total));
};

const projectMatch = ({
  myStats,
  myForm,
  myTactics,
  oppStats,
  oppForm,
  oppTactics,
  homeAdvantage,
}) => {
  if (myStats.Count === 0 || oppStats.Count === 0) {
    return { win: 50, myPossession: 50, myxG: 0, oppxG: 0 };
  }

  const normalizedMyTactics = normalizeTactics(myTactics);
  const normalizedOppTactics = normalizeTactics(oppTactics);
  const adjustedMyControl = myStats.Control
    * (TACTICS.press[normalizedOppTactics.press]?.controlFactor || 1)
    * (TACTICS.lineHeight[normalizedOppTactics.lineHeight]?.controlFactor || 1);
  const adjustedOppControl = oppStats.Control
    * (TACTICS.press[normalizedMyTactics.press]?.controlFactor || 1)
    * (TACTICS.lineHeight[normalizedMyTactics.lineHeight]?.controlFactor || 1);
  const totalControl = adjustedMyControl + adjustedOppControl;
  const myPossession = totalControl === 0 ? 0.5 : (adjustedMyControl / totalControl);

  const myGoalProb = calcGoalProb(myStats.Attack, oppStats.Defense);
  const oppGoalProb = calcGoalProb(oppStats.Attack, myStats.Defense);

  const avgEvents = getAverageEvents(myForm, oppForm, homeAdvantage, normalizedMyTactics, normalizedOppTactics);
  const myEvents = avgEvents * myPossession;
  const oppEvents = avgEvents * (1 - myPossession);
  const myxG = myEvents * myGoalProb;
  const oppxG = oppEvents * oppGoalProb;
  const totalxG = myxG + oppxG;
  const win = totalxG === 0 ? 50 : (myxG / totalxG) * 100;

  return {
    win,
    myPossession: myPossession * 100,
    myxG,
    oppxG,
  };
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

const optimizeRolesForLineup = ({ lineup, formation, tactics, boostContext, oppStats, oppForm, oppTactics, homeAdvantage }) => {
  const assignedBaseLineup = assignLineupPositions(lineup, FORMATIONS[formation].structure);
  const roleCandidates = getRoleCandidateIds(assignedBaseLineup, tactics);
  const roleById = {};
  const usedIds = new Set();
  const roleOptions = [
    ['captain', PLAYER_ROLES.captain.value, roleCandidates.captain],
    ['targetMan', PLAYER_ROLES.targetMan.value, roleCandidates.targetMan],
    ['playmaker', PLAYER_ROLES.playmaker.value, roleCandidates.playmaker],
    ['ballWinner', PLAYER_ROLES.ballWinner.value, roleCandidates.ballWinner],
  ];

  for (const [, roleValue, candidates] of roleOptions) {
    for (const candidateId of candidates) {
      const id = String(candidateId);
      if (usedIds.has(id)) continue;
      const player = assignedBaseLineup.find((item) => String(item.id) === id);
      if (roleValue === PLAYER_ROLES.captain.value && captainQuality(player) < 60) {
        continue;
      }
      roleById[id] = roleValue;
      usedIds.add(id);
      break;
    }
  }

  const roleLineup = applyRolesToLineup(assignedBaseLineup, roleById);
  const stats = calculateTeamScores(roleLineup, formation, boostContext, tactics);
  const projection = projectMatch({
    myStats: stats,
    myForm: formation,
    myTactics: tactics,
    oppStats,
    oppForm,
    oppTactics,
    homeAdvantage,
  });

  return { lineup: roleLineup, roleById, stats, projection };
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

const getSuggestionCopyText = (suggestion) => {
  if (!suggestion?.formation) return '';
  const details = getSuggestionDetails(suggestion);
  const lines = [
    `Formation: ${details.formation}`,
    `Press: ${TACTICS.press[suggestion.tactics.press]?.label || suggestion.tactics.press}`,
    `Tempo: ${TACTICS.tempo[suggestion.tactics.tempo]?.label || suggestion.tactics.tempo}`,
    `Line: ${TACTICS.lineHeight[suggestion.tactics.lineHeight]?.label || suggestion.tactics.lineHeight}`,
    `Set pieces: ${details.setPiecePlayer?.name || 'Auto'}`,
  ];

  if (details.roleLabels.length > 0) {
    lines.push('Roles:');
    lines.push(...details.roleLabels.map((role) => `- ${role}`));
  }

  lines.push('Lineup:');
  details.rows.forEach((row) => {
    lines.push(`${row.label}: ${row.players.map((player) => player.name).join(', ')}`);
  });

  lines.push(`Projected: ${formatNumber(suggestion.win)}% win, xG ${formatNumber(suggestion.myxG)}:${formatNumber(suggestion.oppxG)}`);
  return lines.join('\n');
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ITEM_USE_COOLDOWN_DAYS = 2;

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

const getFixtureActiveBoost = (fixture, activeBoostWindows) => {
  if (!fixture || activeBoostWindows.length === 0) return null;
  const fixtureTime = getFixtureTimeValue(fixture);
  return activeBoostWindows.find((window) => (
    fixtureTime >= window.startTime
    && fixtureTime <= window.endTime
  )) || null;
};

const getFixtureKeySet = (fixture) => new Set(
  [fixture?.game_key, fixture?.source_game_key].filter(Boolean).map(String),
);

export default function OinkSoccerCalc() {
  const { wallets } = useWallet();
  const persistedState = useMemo(() => loadCalculatorState(), []);
  const autoSyncedAddressKeyRef = useRef('');

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
  const [detectedMyTeamIds, setDetectedMyTeamIds] = useState([]);
  const [importedOpponentTeamId, setImportedOpponentTeamId] = useState(null);
  const [catalogSeason, setCatalogSeason] = useState(null);
  const [walletSyncing, setWalletSyncing] = useState(false);
  const [heldItems, setHeldItems] = useState(EMPTY_HELD_ITEMS);

  const [mySquad, setMySquad] = useState(persistedState.mySquad || initialMyTeam); // Full roster
  const [myTeam, setMyTeam] = useState(persistedState.myTeam || initialMyTeam.slice(0, 5)); // Active 5
  const [opponentTeam, setOpponentTeam] = useState(persistedState.opponentTeam || initialOpponent);
  const [opponentLineupMeta, setOpponentLineupMeta] = useState({ isDefaultLineup: false });
  const [myForm, setMyForm] = useState(persistedState.myForm || 'Pyramid');
  const [oppForm, setOppForm] = useState(persistedState.oppForm || 'Pyramid');
  const [myTactics, setMyTactics] = useState(normalizeTactics(persistedState.myTactics));
  const [oppTactics] = useState(normalizeTactics(persistedState.oppTactics));

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

  const [suggestions, setSuggestions] = useState({});
  const [analyzing, setAnalyzing] = useState(false);
  const [autoSuggestions, setAutoSuggestions] = useState({});
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [, setCopiedPlan] = useState(false);
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
      ? myBoostState
      : createManualFallbackBoostState(myBoost, myBoostApps, myBoostState.fetchError)
  ), [hasLiveMyTeamBoosts, myBoost, myBoostApps, myBoostState]);

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
      ? oppBoostState
      : createEmptyTeamBoostState(oppBoostState.fetchError)
  ), [oppBoostState]);

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
    const rounds = Math.max(1, Math.min(60, gameCounter?.games_per_season || 44));
    const fixtureTeamId = detectedMyTeamIds.find((teamId) => getLeagueIdForTeamId(teamId) === selectedLeagueId)
      || detectedMyTeamIds[0]
      || null;
    setFixturesLoading(true);

    void Promise.all([
      fetchLeagueSeasonFixtures({
        leagueId: selectedLeagueId,
        season: fixtureSeason,
        rounds,
      }),
      fetchSeasonTournamentFixtures({
        season: fixtureSeason,
        leagueRounds: rounds,
      }).catch(() => []),
      fixtureTeamId
        ? fetchTeamSeasonFixtures({
          teamId: fixtureTeamId,
          leagueId: selectedLeagueId,
          season: fixtureSeason,
        }).catch(() => [])
        : Promise.resolve([]),
    ])
      .then(([leaguePayload, cupPayload, teamPayload]) => {
        if (cancelled) return;
        const payload = sortFixturesByRoundAndTime(
          teamPayload.length > 0
            ? teamPayload
            : [...leaguePayload, ...cupPayload],
        );
        setFixtures(payload);
        setSeasonFixtures(leaguePayload);
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
  }, [detectedMyTeamIds, fixtureSeason, gameCounter?.games_per_season, getLeagueIdForTeamId, selectedLeagueId]);

  useEffect(() => {
    if (activeTab !== 'season' || !selectedLeagueId || !fixtureSeason) {
      return undefined;
    }

    let cancelled = false;
    const rounds = Math.max(1, Math.min(60, gameCounter?.games_per_season || 44));
    setSeasonPredictionLoading(true);
    setSeasonPredictionError('');

    const loadSeasonPredictionInputs = async () => {
      const nextFixtures = await fetchLeagueSeasonFixtures({
        leagueId: selectedLeagueId,
        season: fixtureSeason,
        rounds,
      });

      if (cancelled) return;
      setSeasonFixtures(nextFixtures);

      const teamIds = Array.from(new Set(
        nextFixtures.flatMap((fixture) => [fixture.home_team_id, fixture.away_team_id]).filter(Boolean),
      ));
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
    };

    void loadSeasonPredictionInputs()
      .catch((error) => {
        if (cancelled) return;
        setSeasonFixtures([]);
        setSeasonTeams({});
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
  }, [activeTab, fixtureSeason, gameCounter?.games_per_season, selectedLeagueId]);

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

  const myStats = useMemo(() => calculateTeamScores(myTeam, myForm, mySimulationBoostContext, myTactics), [myTeam, myForm, mySimulationBoostContext, myTactics]);
  const oppStats = useMemo(() => calculateTeamScores(opponentTeam, oppForm, oppBoostContext, oppTactics), [opponentTeam, oppForm, oppBoostContext, oppTactics]);

  const simulation = useMemo(() => {
    const projection = projectMatch({
      myStats,
      myForm,
      myTactics,
      oppStats,
      oppForm,
      oppTactics,
      homeAdvantage,
    });

    return {
      win: projection.win.toFixed(1),
      myPossession: projection.myPossession.toFixed(0),
      myxG: projection.myxG.toFixed(2),
      oppxG: projection.oppxG.toFixed(2),
    };
  }, [myStats, oppStats, homeAdvantage, myForm, oppForm, myTactics, oppTactics]);

  const refreshOwnedTeamInjuries = useCallback(async ({
    squad = mySquad,
    team = myTeam,
    applyState = true,
    save = true,
  } = {}) => {
    if (detectedMyTeamIds.length === 0 || squad.length === 0) {
      return { nextSquad: squad, nextTeam: team, refreshedCount: 0 };
    }

    const liveLineups = await Promise.all(
      detectedMyTeamIds.map(async (teamId) => {
        try {
          const lineup = await fetchTeamLineup(teamId);
          return lineup.players || [];
        } catch (_) {
          return [];
        }
      }),
    );

    const livePlayers = liveLineups.flat();
    if (livePlayers.length === 0) {
      return { nextSquad: squad, nextTeam: team, refreshedCount: 0 };
    }

    const nextSquad = applyLiveLineupInjuries(squad, livePlayers);
    const nextTeam = applyLiveLineupInjuries(team, livePlayers);

    if (applyState) {
      if (nextSquad !== squad) setMySquad(nextSquad);
      if (nextTeam !== team) setMyTeam(nextTeam);
    }
    if (save && (nextSquad !== squad || nextTeam !== team)) {
      saveToDb({ mySquad: nextSquad, myTeam: nextTeam });
    }

    return { nextSquad, nextTeam, refreshedCount: livePlayers.length };
  }, [detectedMyTeamIds, mySquad, myTeam, saveToDb]);

  const handleSyncWalletAssets = useCallback(async (addressesOverride = connectedAddresses) => {
    const addressesToSync = Array.from(new Set((addressesOverride || []).filter(Boolean)));
    if (addressesToSync.length === 0 || walletSyncing) {
      return;
    }

    setWalletSyncing(true);
    const nextMeta = {
      ...walletSyncMeta,
      lastError: null,
    };
    setWalletSyncMeta(nextMeta);

    try {
      const [catalogPayload, heldAssetBalances] = await Promise.all([
        loadPlayableCatalog(),
        fetchHeldAssetBalancesForAddresses(addressesToSync),
      ]);

      const catalogByAssetId = catalogPayload?.assets || {};
      const heldAssetIds = new Set(heldAssetBalances.keys());
      const nextHeldItems = buildHeldItemCounts(heldAssetBalances);
      const { walletPlayers, matchedCount, unmatchedCount } = buildWalletPlayers(heldAssetIds, catalogByAssetId);
      const merged = mergeWalletPlayers({ mySquad, myTeam, walletPlayers });
      const { nextSquad, nextTeam } = await refreshOwnedTeamInjuries({
        squad: merged.nextSquad,
        team: merged.nextTeam,
        applyState: false,
        save: false,
      });

      const updatedMeta = {
        lastSyncedAt: new Date().toISOString(),
        matchedCount,
        unmatchedCount,
        lastError: null,
      };

      setMySquad(nextSquad);
      setMyTeam(nextTeam);
      setHeldItems(nextHeldItems);
      setWalletSyncMeta(updatedMeta);
      saveToDb({ mySquad: nextSquad, myTeam: nextTeam, walletSyncMeta: updatedMeta });
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

      setImportedOpponentTeamId(imported.teamId || null);
      setOpponentLineupMeta({ isDefaultLineup: Boolean(imported.isDefaultLineup) });
      setOppForm(nextFormation);
      setOpponentTeam(imported.players);
      saveToDb({ opponentTeam: imported.players, oppForm: nextFormation });

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
      setOpponentTeam([]);
      saveToDb({ opponentTeam: [] });
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

  const buildSettingsSuggestions = useCallback((currentWin = parseFloat(simulation.win), matchupOverrides = {}) => {
    const opponentStatsForMatchup = matchupOverrides.oppStats || oppStats;
    const opponentFormationForMatchup = matchupOverrides.oppForm || oppForm;
    const opponentTacticsForMatchup = matchupOverrides.oppTactics || oppTactics;
    const homeAdvantageForMatchup = matchupOverrides.homeAdvantage || homeAdvantage;
    const bestByFormation = {};
    const tacticCombos = ['low', 'medium', 'high'].flatMap((press) =>
      ['slow', 'normal', 'fast'].flatMap((tempo) =>
        ['deep', 'normal', 'high'].map((lineHeight) => ({ press, tempo, lineHeight, setPieceTaker: '' })),
      ),
    );
    const candidateLimitByPosition = 8;
    const maxLineupsPerFormation = 35;
    let evaluatedCount = 0;

    const byPos = { GK: [], DF: [], MF: [], FW: [] };
    mySquad.forEach(p => {
      const validPos = p.positions && p.positions.length > 0 ? p.positions : [p.pos];
      validPos.forEach(pos => {
        if (byPos[pos]) byPos[pos].push(p);
      });
    });

    // Iterate all formations
    for (const formKey of Object.keys(FORMATIONS)) {
      const structure = FORMATIONS[formKey].structure;

      // Check if we have enough players for this formation
      if (byPos.GK.length < structure.GK ||
        byPos.DF.length < structure.DF ||
        byPos.MF.length < structure.MF ||
        byPos.FW.length < structure.FW) {
        continue;
      }

      let bestForThisForm = { win: -1, lineup: [], tactics: DEFAULT_TACTICS };
      const lineupCandidates = [];
      const seenLineups = new Set();
      const positionPools = {
        GK: [...byPos.GK].sort((a, b) => roughPlayerValue(b) - roughPlayerValue(a)).slice(0, candidateLimitByPosition),
        DF: [...byPos.DF].sort((a, b) => roughPlayerValue(b) - roughPlayerValue(a)).slice(0, candidateLimitByPosition),
        MF: [...byPos.MF].sort((a, b) => roughPlayerValue(b) - roughPlayerValue(a)).slice(0, candidateLimitByPosition),
        FW: [...byPos.FW].sort((a, b) => roughPlayerValue(b) - roughPlayerValue(a)).slice(0, candidateLimitByPosition),
      };

      // Generate combinations for each position
      const gkCombos = getCombinations(positionPools.GK, structure.GK);
      const dfCombos = getCombinations(positionPools.DF, structure.DF);
      const mfCombos = getCombinations(positionPools.MF, structure.MF);
      const fwCombos = getCombinations(positionPools.FW, structure.FW);

      // Cartesian product of all position combos
      for (const gks of gkCombos) {
        for (const dfs of dfCombos) {
          for (const mfs of mfCombos) {
            for (const fws of fwCombos) {
              const lineup = [...gks, ...dfs, ...mfs, ...fws];

              // Ensure a single player is not fielding multiple positions
              if (new Set(lineup.map(p => p.id)).size !== lineup.length) {
                continue;
              }
              const key = lineup.map((p) => p.id).sort().join('|');
              if (seenLineups.has(key)) {
                continue;
              }
              seenLineups.add(key);
              lineupCandidates.push({
                lineup,
                roughScore: lineup.reduce((sum, player) => sum + roughPlayerValue(player), 0),
              });
            }
          }
        }
      }

      const shortlist = lineupCandidates
        .sort((a, b) => b.roughScore - a.roughScore)
        .slice(0, maxLineupsPerFormation);

      for (const candidate of shortlist) {
        const setPieceCandidates = getSetPieceCandidates(candidate.lineup);
        for (const baseTactics of tacticCombos) {
          for (const setPieceTaker of setPieceCandidates) {
            const tactics = { ...baseTactics, setPieceTaker };
            const roleResult = optimizeRolesForLineup({
              lineup: candidate.lineup,
              formation: formKey,
              tactics,
              boostContext: mySimulationBoostContext,
              oppStats: opponentStatsForMatchup,
              oppForm: opponentFormationForMatchup,
              oppTactics: opponentTacticsForMatchup,
              homeAdvantage: homeAdvantageForMatchup,
            });
            evaluatedCount += 1;
            if (roleResult.projection.win > bestForThisForm.win) {
              bestForThisForm = {
                formation: formKey,
                lineup: roleResult.lineup,
                tactics,
                stats: roleResult.stats,
                win: roleResult.projection.win,
                myxG: roleResult.projection.myxG,
                oppxG: roleResult.projection.oppxG,
                possession: roleResult.projection.myPossession,
                diff: roleResult.projection.win - currentWin,
              };
            }
          }
        }
      }

      if (bestForThisForm.win > -1) {
        bestByFormation[formKey] = bestForThisForm;
      }
    }

    return { ...bestByFormation, __meta: { evaluatedCount } };
  }, [
    getCombinations,
    homeAdvantage,
    mySimulationBoostContext,
    mySquad,
    oppForm,
    oppStats,
    oppTactics,
    simulation.win,
  ]);

  const analyzeLineups = async () => {
    setAnalyzing(true);
    setSuggestions({});

    // Allow UI to update before heavy calculation
    await new Promise(resolve => setTimeout(resolve, 100));

    setSuggestions(buildSettingsSuggestions(parseFloat(simulation.win)));
    setAnalyzing(false);
  };

  useEffect(() => {
    if (mySquad.length < 5 || opponentTeam.length < 5) {
      setAutoSuggestions({});
      setAutoAnalyzing(false);
      return undefined;
    }

    setAutoAnalyzing(true);
    const timeoutId = window.setTimeout(() => {
      setAutoSuggestions(buildSettingsSuggestions(parseFloat(simulation.win)));
      setAutoAnalyzing(false);
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [buildSettingsSuggestions, mySquad.length, opponentTeam.length, simulation.win]);

  const applySuggestion = (config) => {
    if (!config) return;
    const roleById = new Map(config.lineup.map((player) => [player.id, player.role || '']));
    const nextSquad = mySquad.map((player) => (
      roleById.has(player.id) ? { ...player, role: roleById.get(player.id) } : player
    ));
    setMySquad(nextSquad);
    setMyTeam(config.lineup);
    setMyForm(config.formation);
    setMyTactics(normalizeTactics(config.tactics));
    saveToDb({
      mySquad: nextSquad,
      myTeam: config.lineup,
      myForm: config.formation,
      myTactics: normalizeTactics(config.tactics),
    });
    setSuggestions({});
  };

  const tabItems = useMemo(() => ([
    { key: 'upcoming', icon: '📅', label: 'Upcoming' },
    { key: 'matchup', icon: '⚽', label: 'Setup' },
    { key: 'season', icon: '📈', label: 'Season' },
  ]), []);

  const suggestionList = useMemo(() => (
    Object.values(suggestions)
      .filter((suggestion) => suggestion?.formation)
      .sort((a, b) => b.win - a.win)
  ), [suggestions]);

  const activeSuggestions = suggestionList.length > 0 ? suggestions : autoSuggestions;

  const activeSuggestionList = useMemo(() => (
    Object.values(activeSuggestions)
      .filter((suggestion) => suggestion?.formation)
      .sort((a, b) => b.win - a.win)
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

  const fixtureWinChances = useMemo(() => {
    if (myTeam.length < 5 || upcomingFixtures.length === 0 || detectedMyTeamIds.length === 0) {
      return {};
    }

    const myTeams = new Set(detectedMyTeamIds);
    const chances = {};
    const currentStats = calculateTeamScores(myTeam, myForm, mySimulationBoostContext, myTactics);

    upcomingFixtures.forEach((fixture) => {
      if (fixture.cup_bye) return;
      const isHome = myTeams.has(fixture.home_team_id);
      const isAway = myTeams.has(fixture.away_team_id);
      if (!isHome && !isAway) return;

      const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
      const opponentModel = seasonTeams[opponentId];
      if (!opponentModel?.players?.length) return;

      const opponentFormation = opponentModel.formationKey && FORMATIONS[opponentModel.formationKey]
        ? opponentModel.formationKey
        : 'Pyramid';
      const opponentStats = calculateTeamScores(opponentModel.players, opponentFormation, TEAM_BOOST_STATE_EMPTY, DEFAULT_TACTICS);
      const projection = projectMatch({
        myStats: currentStats,
        myForm,
        myTactics,
        oppStats: opponentStats,
        oppForm: opponentFormation,
        oppTactics: DEFAULT_TACTICS,
        homeAdvantage: isHome ? 'home' : 'away',
      });
      chances[fixture.game_key] = { win: projection.win, myxG: projection.myxG, oppxG: projection.oppxG, source: 'current' };
    });

    if (topSuggestion) {
      const selectedKeys = new Set(selectedFixtureKey ? [String(selectedFixtureKey)] : []);
      const selectedFixtureKeys = getFixtureKeySet(selectedFixture);
      selectedFixtureKeys.forEach((key) => selectedKeys.add(key));

      const selectedOpponentId = selectedFixture
        ? myTeams.has(selectedFixture.home_team_id)
          ? selectedFixture.away_team_id
          : selectedFixture.home_team_id
        : importedOpponentTeamId;
      const selectedHomeAdvantage = selectedFixture
        ? myTeams.has(selectedFixture.away_team_id) ? 'away' : 'home'
        : homeAdvantage;

      upcomingFixtures.forEach((fixture) => {
        if (fixture.cup_bye) return;
        const fixtureKeys = getFixtureKeySet(fixture);
        const keyMatches = Array.from(fixtureKeys).some((key) => selectedKeys.has(key));
        const isHome = myTeams.has(fixture.home_team_id);
        const isAway = myTeams.has(fixture.away_team_id);
        const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
        const fixtureHomeAdvantage = isAway ? 'away' : 'home';
        const matchupMatches = selectedOpponentId
          && opponentId === selectedOpponentId
          && fixtureHomeAdvantage === selectedHomeAdvantage;

        if (!fixture.game_key || (!keyMatches && !matchupMatches)) return;
        chances[fixture.game_key] = {
          win: topSuggestion.win,
          myxG: topSuggestion.myxG,
          oppxG: topSuggestion.oppxG,
          source: 'best',
        };
      });
    }

    return chances;
  }, [
    detectedMyTeamIds,
    homeAdvantage,
    importedOpponentTeamId,
    myForm,
    mySimulationBoostContext,
    myTactics,
    myTeam,
    selectedFixture,
    selectedFixtureKey,
    seasonTeams,
    topSuggestion,
    upcomingFixtures,
  ]);

  const headlineProjection = topSuggestion
    ? {
      label: 'Best Setup Projection',
      win: formatNumber(topSuggestion.win),
      myxG: formatNumber(topSuggestion.myxG, 2),
      oppxG: formatNumber(topSuggestion.oppxG, 2),
    }
    : {
      label: 'Current Setup Projection',
      win: simulation.win,
      myxG: simulation.myxG,
      oppxG: simulation.oppxG,
    };

  const winPct = Number.parseFloat(headlineProjection.win) || 0;
  const scoreGap = Number(headlineProjection.myxG) - Number(headlineProjection.oppxG);
  const drawPct = Math.max(12, Math.min(34, 24 - Math.abs(scoreGap) * 7));
  const remaining = Math.max(0, 100 - drawPct);
  const winShare = Math.max(0, Math.min(1, winPct / 100));
  const forecastWin = Number((remaining * winShare).toFixed(1));
  const forecastLoss = Number((100 - drawPct - forecastWin).toFixed(1));
  const forecastDraw = Number((100 - forecastWin - forecastLoss).toFixed(1));

  const opponentPitchSuggestion = useMemo(() => {
    if (opponentTeam.length === 0 || !FORMATIONS[oppForm]) return null;
    return {
      formation: oppForm,
      lineup: assignLineupPositions(opponentTeam, FORMATIONS[oppForm].structure),
      tactics: normalizeTactics(oppTactics),
      isDefaultLineup: opponentLineupMeta.isDefaultLineup,
    };
  }, [oppForm, oppTactics, opponentLineupMeta.isDefaultLineup, opponentTeam]);

  const seasonForecast = useMemo(() => {
    const myTeamIds = new Set(detectedMyTeamIds);
    const mySeasonStats = myTeam.length >= 5
      ? calculateTeamScores(myTeam, myForm, TEAM_BOOST_STATE_EMPTY, myTactics)
      : null;
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

    const getModel = (teamId) => {
      if (myTeamIds.has(teamId) && mySeasonStats) {
        return {
          formation: myForm,
          tactics: myTactics,
          stats: mySeasonStats,
        };
      }

      const model = seasonTeams[teamId];
      if (!model?.players?.length) return null;
      const formation = model.formationKey && FORMATIONS[model.formationKey] ? model.formationKey : 'Pyramid';
      const tactics = DEFAULT_TACTICS;
      return {
        ...model,
        formation,
        tactics,
        stats: calculateTeamScores(model.players, formation, TEAM_BOOST_STATE_EMPTY, tactics),
      };
    };

    const projectedFixtures = [];

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

      const homeModel = getModel(fixture.home_team_id);
      const awayModel = getModel(fixture.away_team_id);
      if (!homeModel || !awayModel) {
        home.unavailable += 1;
        away.unavailable += 1;
        return;
      }

      const projection = projectMatch({
        myStats: homeModel.stats,
        myForm: homeModel.formation,
        myTactics: homeModel.tactics,
        oppStats: awayModel.stats,
        oppForm: awayModel.formation,
        oppTactics: awayModel.tactics,
        homeAdvantage: 'home',
      });
      const homeGoals = projection.myxG;
      const awayGoals = projection.oppxG;
      const goalGap = homeGoals - awayGoals;
      const isDraw = Math.abs(goalGap) < 0.18;

      home.projected += 1;
      away.projected += 1;
      home.gf += homeGoals;
      home.ga += awayGoals;
      away.gf += awayGoals;
      away.ga += homeGoals;

      if (isDraw) {
        home.drawn += 1;
        away.drawn += 1;
        home.points += 1;
        away.points += 1;
      } else if (goalGap > 0) {
        home.won += 1;
        away.lost += 1;
        home.points += 3;
      } else {
        away.won += 1;
        home.lost += 1;
        away.points += 3;
      }

      projectedFixtures.push({
        fixture,
        homeWin: projection.win,
        homeXg: projection.myxG,
        awayXg: projection.oppxG,
        predicted: isDraw ? 'Draw' : goalGap > 0 ? fixture.home_team_name : fixture.away_team_name,
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
    };
  }, [detectedMyTeamIds, leagueTeams, myForm, myTactics, myTeam, seasonFixtures, seasonTeams]);

  const itemSuggestions = useMemo(() => {
    const planningFixtures = teamSeasonFixtures.length > 0 ? teamSeasonFixtures : seasonFixtures;
    if (myTeam.length < 5 || detectedMyTeamIds.length === 0 || planningFixtures.length === 0) return [];
    const heldPerformanceItems = getHeldPerformanceItems(heldItems);
    if (heldPerformanceItems.length === 0) return [];

    const myTeamIds = new Set(detectedMyTeamIds);
    const remainingMyFixtures = sortFixturesByRoundAndTime(
      planningFixtures.filter((fixture) => (
        !fixture.game_result
        && !fixture.cup_bye
        && !hasFixtureStarted(fixture, currentTime)
        && (myTeamIds.has(fixture.home_team_id) || myTeamIds.has(fixture.away_team_id))
      )),
    );

    const baseStats = calculateTeamScores(myTeam, myForm, TEAM_BOOST_STATE_EMPTY, myTactics);
    const liveEffectiveness = myBoostState?.source === 'live' ? Number(myBoostState.effectivenessPct) : Number.NaN;
    const baseEffectivenessPct = Number.isFinite(liveEffectiveness) ? liveEffectiveness : 100;
    const boostCounts = Object.fromEntries(heldPerformanceItems.map((item) => [item.boostKey, item.count]));
    const selectedWindows = [];
    const currentTeamMetaById = new Map(leagueTeams.map((team) => [team.teamId, team]));
    const myCurrentPoints = detectedMyTeamIds.reduce((best, teamId) => {
      const points = Number(currentTeamMetaById.get(teamId)?.currentPoints);
      return Number.isFinite(points) ? Math.max(best, points) : best;
    }, 0);
    const getProjectedPoints = (projection) => {
      const goalGap = projection.myxG - projection.oppxG;
      if (Math.abs(goalGap) < 0.18) return { my: 1, opponent: 1 };
      return goalGap > 0 ? { my: 3, opponent: 0 } : { my: 0, opponent: 3 };
    };
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

      const opponentFormation = opponentModel.formationKey && FORMATIONS[opponentModel.formationKey]
        ? opponentModel.formationKey
        : 'Pyramid';
      const opponentStats = calculateTeamScores(opponentModel.players, opponentFormation, TEAM_BOOST_STATE_EMPTY, DEFAULT_TACTICS);
      return {
        opponentId,
        isHome,
        opponentName: isHome ? fixture.away_team_name : fixture.home_team_name,
        opponentFormation,
        opponentStats,
      };
    };

    const projectFixture = (fixture, stats) => {
      const opponent = getOpponentModel(fixture);
      if (!opponent) return null;
      return {
        opponent,
        projection: projectMatch({
          myStats: stats,
          myForm,
          myTactics,
          oppStats: opponent.opponentStats,
          oppForm: opponent.opponentFormation,
          oppTactics: DEFAULT_TACTICS,
          homeAdvantage: opponent.isHome ? 'home' : 'away',
        }),
      };
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

      const effectivenessPct = getBoostEffectivenessForPlannedUse(baseEffectivenessPct, plannedUseIndex);
      const boostState = createPlannedItemBoostState({
        boostKey: item.boostKey,
        effectivenessPct,
      });
      const boostedStats = calculateTeamScores(myTeam, myForm, boostState, myTactics);
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

      windowFixtures.forEach((candidate, windowIndex) => {
        const base = projectFixture(candidate.fixture, baseStats);
        const boosted = projectFixture(candidate.fixture, boostedStats);
        if (!base || !boosted) return;
        const delta = boosted.projection.win - base.projection.win;
        const basePoints = getProjectedPoints(base.projection);
        const boostedPoints = getProjectedPoints(boosted.projection);
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
      const effectivenessPct = getBoostEffectivenessForPlannedUse(baseEffectivenessPct, plannedUseIndex);
      const boostState = createPlannedItemBoostState({
        boostKey: item.boostKey,
        effectivenessPct,
      });
      const boostedStats = calculateTeamScores(myTeam, myForm, boostState, myTactics);
      const durationDays = Array.from(
        { length: Math.max(0, (item.maxDays || 0) - (item.minDays || 0)) + 1 },
        (_, index) => (item.minDays || 0) + index,
      );
      const baseFirst = projectFixture(item.fixture, baseStats);
      const boostedFirst = projectFixture(item.fixture, boostedStats);
      let seasonDelta = 0;
      let standingsLeverage = 0;
      let rivalCoverage = 0;
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
        const basePoints = getProjectedPoints(base.projection);
        const boostedPoints = getProjectedPoints(boosted.projection);
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

      const getTeamModel = (teamId) => {
        if (myTeamIds.has(teamId)) {
          return {
            formation: myForm,
            tactics: myTactics,
            stats: baseStats,
            isMine: true,
          };
        }

        const model = seasonTeams[teamId];
        if (!model?.players?.length) return null;
        const formation = model.formationKey && FORMATIONS[model.formationKey] ? model.formationKey : 'Pyramid';
        const tactics = DEFAULT_TACTICS;
        return {
          formation,
          tactics,
          stats: calculateTeamScores(model.players, formation, TEAM_BOOST_STATE_EMPTY, tactics),
          isMine: false,
        };
      };

      const getPlannedWindow = (fixture) => {
        const fixtureTime = getFixtureTimeValue(fixture);
        return plan.find((item) => (
          fixtureTime >= item.startTime
          && (fixtureTime <= item.endTime || fixture.game_key === item.fixture.game_key)
          && (myTeamIds.has(fixture.home_team_id) || myTeamIds.has(fixture.away_team_id))
        ));
      };

      seasonFixtures.forEach((fixture) => {
        const home = ensureRow(fixture.home_team_id, fixture.home_team_name);
        const away = ensureRow(fixture.away_team_id, fixture.away_team_name);
        if (!home || !away) return;

        let homeGoals;
        let awayGoals;

        if (fixture.game_result) {
          homeGoals = Number(fixture.game_result.home_team_score || 0);
          awayGoals = Number(fixture.game_result.away_team_score || 0);
        } else {
          const homeModel = getTeamModel(fixture.home_team_id);
          const awayModel = getTeamModel(fixture.away_team_id);
          if (!homeModel || !awayModel) return;

          const plannedWindow = getPlannedWindow(fixture);
          if (homeModel.isMine) {
            const projection = projectMatch({
              myStats: plannedWindow?.boostedStats || homeModel.stats,
              myForm: homeModel.formation,
              myTactics: homeModel.tactics,
              oppStats: awayModel.stats,
              oppForm: awayModel.formation,
              oppTactics: awayModel.tactics,
              homeAdvantage: 'home',
            });
            homeGoals = projection.myxG;
            awayGoals = projection.oppxG;
          } else if (awayModel.isMine) {
            const projection = projectMatch({
              myStats: plannedWindow?.boostedStats || awayModel.stats,
              myForm: awayModel.formation,
              myTactics: awayModel.tactics,
              oppStats: homeModel.stats,
              oppForm: homeModel.formation,
              oppTactics: homeModel.tactics,
              homeAdvantage: 'away',
            });
            homeGoals = projection.oppxG;
            awayGoals = projection.myxG;
          } else {
            const projection = projectMatch({
              myStats: homeModel.stats,
              myForm: homeModel.formation,
              myTactics: homeModel.tactics,
              oppStats: awayModel.stats,
              oppForm: awayModel.formation,
              oppTactics: awayModel.tactics,
              homeAdvantage: 'home',
            });
            homeGoals = projection.myxG;
            awayGoals = projection.oppxG;
          }
        }

        home.gf += homeGoals;
        home.ga += awayGoals;
        away.gf += awayGoals;
        away.ga += homeGoals;

        const goalGap = homeGoals - awayGoals;
        if (Math.abs(goalGap) < 0.18) {
          home.drawn += 1;
          away.drawn += 1;
          home.points += 1;
          away.points += 1;
        } else if (goalGap > 0) {
          home.won += 1;
          away.lost += 1;
          home.points += 3;
        } else {
          away.won += 1;
          home.lost += 1;
          away.points += 3;
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
      const promotionCutoff = Math.min(3, sortedRows.length);
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
      const beforeBuffer = Number(before.promotionBuffer);
      const afterBuffer = Number(after.promotionBuffer);
      if (Number.isFinite(beforeBuffer) && Number.isFinite(afterBuffer)) {
        if (before.position <= 3 && beforeBuffer < 3 && afterBuffer > beforeBuffer) return true;
        if (before.position > 3 && afterBuffer > beforeBuffer) return true;
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
        const isStillBelowPromotion = Number(fullSummary.position) > 3;
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
  }, [currentTime, detectedMyTeamIds, heldItems, itemCooldownEndTime, leagueTeams, myBoostState, myForm, myTactics, myTeam, seasonFixtures, seasonTeams, teamSeasonFixtures]);

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

  const copySuggestion = useCallback(async (suggestion) => {
    if (!suggestion?.formation) return;
    const text = getSuggestionCopyText(suggestion);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPlan(true);
      window.setTimeout(() => setCopiedPlan(false), 1800);
    } catch (_) {
      setUploadStatus({ tone: 'error', message: 'Copy failed. Select the setup text and copy it manually.' });
    }
  }, []);

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

  return (
    <div className="min-h-screen bg-[#0a0d12] text-[#e8edf5] font-sans pb-8">
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

      <nav className="sticky top-14 z-[99] border-b border-[#1e2a3a] bg-[#111620]">
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

      <section className="border-b border-[#1e2a3a] bg-[linear-gradient(135deg,#161c28,rgba(0,230,118,0.05))]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-6 px-4 py-3 md:px-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#6b7a94]">{headlineProjection.label}</div>
            <div className="font-['Barlow_Condensed'] text-[42px] font-black leading-none text-[#00e676]">{headlineProjection.win}%</div>
            <div className="text-[11px] text-[#6b7a94]">Based on {(Number(headlineProjection.myxG) + Number(headlineProjection.oppxG)).toFixed(2)} simulated goals</div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#00e676]">{headlineProjection.myxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">You</div>
            </div>
            <div className="pb-1 font-['Barlow_Condensed'] text-2xl text-[#6b7a94]">:</div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#ffab00]">{headlineProjection.oppxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Opp</div>
            </div>
          </div>

          <div className="hidden items-end gap-5 sm:flex">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#00e676]">{forecastWin.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Win</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#9aa5bb]">{forecastDraw.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Draw</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#ff4444]">{forecastLoss.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Loss</div>
            </div>
          </div>
        </div>
      </section>

      <main className={`mx-auto px-4 py-5 md:px-6 md:py-6 ${activeTab === 'matchup' ? 'max-w-[1500px]' : 'max-w-[900px]'}`}>
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

        {activeTab === 'matchup' && (
          <section id="tab-matchup" className="space-y-4">
              <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
                <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Selected Matchup</div>
                {selectedFixture ? (
                  <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
                    <div className={`min-w-0 truncate text-right ${homeAdvantage === 'home' ? 'text-[#00e676]' : 'text-[#e8edf5]'}`}>{selectedFixture.home_team_name}</div>
                    <div className="rounded bg-[#ffab00] px-2 py-1 text-xs font-bold text-black">
                      {selectedFixture.game_result
                        ? `${selectedFixture.game_result.home_team_score}-${selectedFixture.game_result.away_team_score}`
                        : 'vs'}
                    </div>
                    <div className={`min-w-0 truncate ${homeAdvantage === 'away' ? 'text-[#00e676]' : 'text-[#e8edf5]'}`}>{selectedFixture.away_team_name}</div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-[#9aa5bb]">Choose a fixture from Upcoming to calculate the best setup.</div>
                )}
              </div>

              {selectedFixture ? (
                <>
                  <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
                    <BestSetupCard
                      suggestion={topSuggestion}
                      analyzing={autoAnalyzing || importingTeamUrl}
                      canAnalyze={mySquad.length >= 5 && opponentTeam.length >= 5}
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
                    Base table uses actual results already played, then projects remaining fixtures without future item usage. Reopen Season after played matches or skipped item uses to recalculate from the new state.
                  </div>
                </div>
                <div className="rounded-md border border-[#253040] bg-[#111620] px-3 py-2 text-xs text-[#9aa5bb]">
                  {seasonPredictionLoading
                    ? 'Loading season...'
                    : `${seasonForecast.projectedFixtures.length} projected fixtures`}
                </div>
              </div>

              {seasonPredictionError && (
                <div className="mt-3 rounded-md border border-[#ff4444]/50 bg-[#ff4444]/10 px-3 py-2 text-xs text-[#ff9e9e]">
                  {seasonPredictionError}
                </div>
              )}

              <SeasonPredictionTable rows={seasonForecast.rows} loading={seasonPredictionLoading} myTeamIds={detectedMyTeamIds} />
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#ffab00]">Item Timing</div>
              <div className="mt-1 text-xs text-[#6b7a94]">
                Planned using held items, active windows, cooldowns, direct-rival leverage, and diminishing effectiveness. Uses are kept when they improve final place or protect a fragile promotion buffer.
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
                    <div>{formatNumber(itemPlanSummary.basePoints, 0)} pts</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">With Items</div>
                    <div className="mt-1 font-['Barlow_Condensed'] text-[22px] font-black text-[#00e676]">
                      {formatOrdinal(itemPlanSummary.projectedPosition)}
                    </div>
                    <div>{formatNumber(itemPlanSummary.projectedPoints, 0)} pts</div>
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
                        : 'Promotion buffer'}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-2">
                {seasonPredictionLoading && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">Checking item windows...</div>
                )}
                {!seasonPredictionLoading && itemSuggestions.length === 0 && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                    No efficient held performance item window found. Medical Kits are ignored unless injuries need healing.
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
                          +{formatNumber(item.seasonDelta)}%
                        </div>
                        <div className="mt-1 text-xs text-[#7f8aa3]">
                          {item.planBasePosition && item.planProjectedPosition
                            ? `Plan ${formatOrdinal(item.planBasePosition)} → ${formatOrdinal(item.planProjectedPosition)}`
                            : 'Plan impact pending'}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-[#9aa5bb]">
                      First match: {formatNumber(item.baseWin)}% to {formatNumber(item.boostedWin)}%. Expected coverage {formatNumber(item.windowCount)} fixture-equivalent{Number(item.windowCount) === 1 ? '' : 's'} ({item.guaranteedWindowCount}-{item.maxWindowCount} possible over {item.minDays}-{item.maxDays} days) at {formatNumber(item.effectivenessPct)}% effectiveness.
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

        {activeTab === 'simulation' && (
          <section id="tab-result" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="mb-1 text-sm font-bold">⚡ Smart Coach</div>
              <div className="mb-3 text-xs text-[#6b7a94]">Formation, tactics, roles, and set-piece settings for this matchup</div>
              <div className="space-y-2">
                {activeSuggestionList.slice(0, 3).map((sugg) => {
                  const details = getSuggestionDetails(sugg);
                  return (
                  <div
                    key={sugg.formation}
                    className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]"
                  >
                    <div>
                      <strong className="text-[#00e676]">{FORMATIONS[sugg.formation].name}</strong>
                      {' '}• {formatNumber(sugg.win)}% ({sugg.diff >= 0 ? '+' : ''}{formatNumber(sugg.diff)})
                      {' '}• xG {formatNumber(sugg.myxG)} : {formatNumber(sugg.oppxG)}
                    </div>
                    <div className="mt-1 text-[#d0d7e5]">
                      Press {TACTICS.press[sugg.tactics.press]?.label}, Tempo {TACTICS.tempo[sugg.tactics.tempo]?.label}, Line {TACTICS.lineHeight[sugg.tactics.lineHeight]?.label}, Set pieces {details.setPiecePlayer?.name || 'Auto'}
                    </div>
                    {details.roleLabels.length > 0 && (
                      <div className="mt-1 text-[#7f8aa3]">{details.roleLabels.join(' · ')}</div>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void copySuggestion(sugg)}
                        className="rounded border border-[#00e676]/35 bg-[#00e676] px-2 py-1.5 text-[11px] font-bold text-[#07110c]"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => applySuggestion(sugg)}
                        className="rounded border border-[#253040] bg-[#161c28] px-2 py-1.5 text-[11px] font-semibold text-[#e8edf5]"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                  );
                })}
                {activeSuggestionList.length === 0 && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                    {autoAnalyzing ? 'Calculating best settings...' : 'Load your squad and opponent to generate matchup-specific recommendations.'}
                  </div>
                )}
              </div>
              {activeSuggestions.__meta?.evaluatedCount ? (
                <div className="mt-2 text-[11px] text-[#6b7a94]">
                  Checked {activeSuggestions.__meta.evaluatedCount.toLocaleString()} lineup/tactics configurations.
                </div>
              ) : null}
              <button
                onClick={analyzeLineups}
                disabled={analyzing || mySquad.length < 5 || opponentTeam.length < 5}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-xs font-semibold text-[#e8edf5] hover:border-[#00e676]/70 hover:text-[#00e676] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Analyze Best Settings →
              </button>
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <div className="mb-2 text-sm font-semibold">Outcome Forecast</div>
              <div className="space-y-2">
                <OutcomeBar label="Win" value={forecastWin} color="#00e676" textClass="text-[#00e676]" />
                <OutcomeBar label="Draw" value={forecastDraw} color="#6b7a94" textClass="text-[#9aa5bb]" />
                <OutcomeBar label="Loss" value={forecastLoss} color="#ff4444" textClass="text-[#ff4444]" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#111620] p-3 text-center border border-[#1e2a3a]">
                <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">My Expected Goals</div>
                <div className="font-['Barlow_Condensed'] text-[28px] font-black text-[#00e676]">{simulation.myxG}</div>
                <div className="text-[11px] text-[#6b7a94]">You</div>
              </div>
              <div className="rounded-lg bg-[#111620] p-3 text-center border border-[#1e2a3a]">
                <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">Opponent xG</div>
                <div className="font-['Barlow_Condensed'] text-[28px] font-black text-[#ffab00]">{simulation.oppxG}</div>
                <div className="text-[11px] text-[#6b7a94]">Opponent</div>
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
          const isInactive = isBye || isResultPending;
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
                    {formatNumber(chance.win)}%
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
    <section className="overflow-hidden rounded-[10px] border border-[#1e2a3a] bg-[#111620]">
      <div className="border-b border-[#1e2a3a] p-4">
        <div className={`text-[11px] font-bold uppercase tracking-[0.14em] ${tone === 'opp' ? 'text-[#ffab00]' : 'text-[#00e676]'}`}>{title}</div>
        <div className="mt-1 font-['Barlow_Condensed'] text-[24px] font-black leading-none text-[#e8edf5]">
          {subtitle || details.formation}
        </div>
        {suggestion.isDefaultLineup ? (
          <div className="mt-2 text-xs text-[#9aa5bb]">Default 55 OVR players used for projection.</div>
        ) : null}
        <TacticsSummaryChips
          tactics={suggestion.tactics}
          setPiecePlayer={details.setPiecePlayer}
          className="mt-3"
        />
      </div>
      <FormationPitch suggestion={suggestion} details={details} onInjuryOpen={onInjuryOpen} />
    </section>
  );
}

function TacticsSummaryChips({ tactics, setPiecePlayer, className = '' }) {
  const normalizedTactics = normalizeTactics(tactics);

  return (
    <div className={`flex flex-wrap gap-2 text-xs text-[#d0d7e5] ${className}`}>
      <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Press {TACTICS.press[normalizedTactics.press]?.label}</span>
      <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Tempo {TACTICS.tempo[normalizedTactics.tempo]?.label}</span>
      <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Line {TACTICS.lineHeight[normalizedTactics.lineHeight]?.label}</span>
      <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Set pieces {setPiecePlayer?.name || 'Auto'}</span>
    </div>
  );
}

function SeasonPredictionTable({ rows, loading, myTeamIds }) {
  const myTeams = new Set(myTeamIds);

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-[#1e2a3a] bg-[#111620]">
      <div className="grid grid-cols-[34px_1fr_44px_44px_64px] gap-2 border-b border-[#1e2a3a] px-2 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">
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
      {!loading && rows.slice(0, 24).map((row, index) => (
        <div
          key={row.teamId}
          className={`grid grid-cols-[34px_1fr_44px_44px_64px] gap-2 border-b border-[#1e2a3a] px-2 py-2 text-xs last:border-b-0 ${myTeams.has(row.teamId) ? 'bg-[#0f2a1b] text-[#d7ffe9]' : 'text-[#d0d7e5]'}`}
        >
          <div className="font-bold text-[#6b7a94]">{index + 1}</div>
          <div className="min-w-0 truncate font-semibold">{row.teamName}</div>
          <div className="text-right font-bold text-[#00e676]">{formatNumber(row.points, 0)}</div>
          <div className="text-right">{formatNumber(row.gd, 1)}</div>
          <div className="text-right">{row.won}-{row.drawn}-{row.lost}</div>
        </div>
      ))}
    </div>
  );
}

function BestSetupCard({ suggestion, analyzing, canAnalyze, onInjuryOpen }) {
  if (!canAnalyze) {
    return (
      <section className="mb-4 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Best Setup</div>
        <div className="mt-1 text-sm font-semibold text-[#e8edf5]">Load your squad and next opponent</div>
        <div className="mt-1 text-xs text-[#6b7a94]">Once both teams are available, the calculator will pick the setup automatically.</div>
      </section>
    );
  }

  if (analyzing && !suggestion) {
    return (
      <section className="mb-4 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#e8edf5]">
          <Loader2 size={14} className="animate-spin text-[#00e676]" />
          Calculating best setup...
        </div>
      </section>
    );
  }

  if (!suggestion) {
    return null;
  }

  const details = getSuggestionDetails(suggestion);

  return (
    <section className="overflow-hidden rounded-[10px] border border-[rgba(0,230,118,0.28)] bg-[#111620]">
      <div className="border-b border-[#1e2a3a] p-4">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Best Setup</div>
          <div className="mt-1 font-['Barlow_Condensed'] text-[26px] font-black leading-none text-[#e8edf5]">
            {details.formation}
          </div>
          <TacticsSummaryChips
            tactics={suggestion.tactics}
            setPiecePlayer={details.setPiecePlayer}
            className="mt-2"
          />
        </div>
      </div>
      <FormationPitch suggestion={suggestion} details={details} onInjuryOpen={onInjuryOpen} />
    </section>
  );
}

function FormationPitch({ suggestion, details, onInjuryOpen }) {
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
    <div className="p-3">
      <div className="relative overflow-hidden rounded-[8px] border border-[#1e2a3a]" style={pitchStyle}>
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/20" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20" />
        <div className="pointer-events-none absolute inset-x-[18%] bottom-0 h-[19%] border border-b-0 border-white/20" />
        <div className="pointer-events-none absolute inset-x-[18%] top-0 h-[19%] border border-t-0 border-white/20" />

        <div className="relative z-10 flex min-h-[430px] flex-col justify-between gap-4 px-3 py-4 sm:min-h-[520px] sm:px-5">
          {rows.map((row) => (
            <div key={row.pos} className="min-w-0">
              <div className="mb-1 text-center font-['Barlow_Condensed'] text-[13px] font-black uppercase tracking-[0.18em] text-[#0d2414]/65">
                {row.label}
              </div>
              <div
                className="grid justify-center gap-2.5 sm:gap-4"
                style={{ gridTemplateColumns: `repeat(${row.players.length}, minmax(0, 150px))` }}
              >
                {row.players.map((player) => (
                  <FormationPlayerCard
                    key={`${row.pos}-${player.id}`}
                    player={player}
                    setPieceTaker={suggestion.tactics?.setPieceTaker}
                    onInjuryOpen={onInjuryOpen}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FormationPlayerCard({ player, setPieceTaker, onInjuryOpen }) {
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

  return (
    <div className="min-w-0 overflow-hidden rounded-[8px] border border-[#142315] bg-[#d8c22f] shadow-[4px_5px_0_rgba(7,17,12,0.35)]">
      <div className="flex min-h-[42px] items-start justify-between gap-1 bg-[#d9bd2b] px-2 py-1">
        <div className="min-w-0 whitespace-normal break-words font-['Barlow_Condensed'] text-[13px] font-black uppercase leading-[0.95] tracking-[0.04em] text-[#2a2713]">
          {player.name}
        </div>
        <div className={`shrink-0 rounded-[4px] bg-gradient-to-b px-1.5 py-0.5 font-['Barlow_Condensed'] text-[12px] font-black ${positionTone}`}>
          {selectedPosition}
        </div>
      </div>
      <div className="relative bg-[#f0e6a1]">
        <PlayerCardPortrait player={player} />
        {injury && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (onInjuryOpen) onInjuryOpen(player);
            }}
            className="absolute left-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-[5px] border border-white/70 bg-[#d73535] px-1.5 font-['Barlow_Condensed'] text-[18px] font-black leading-none text-white shadow-[2px_2px_0_rgba(7,17,12,0.4)] transition hover:bg-[#ff4444] focus:outline-none focus:ring-2 focus:ring-white/80"
            title={injuryTitle}
            aria-label={injuryTitle}
          >
            +
          </button>
        )}
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-[rgba(17,22,32,0.72)] px-2 py-1 font-['Barlow_Condensed'] text-[14px] font-black text-white">
          <span>{isSetPieceTaker ? 'SP' : roleLabel}</span>
          <span>{player.outOfPosition ? `OOP ${playableLabel}` : playableLabel}</span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 bg-[#c9ad28] px-2 py-1 font-['Barlow_Condensed'] text-[17px] font-black uppercase tracking-[0.08em] text-[#4a4114]">
        <span>{selectedPosition}</span>
        <span className="text-[#6a5c1a]">|</span>
        <span>{player.ovr}</span>
      </div>
    </div>
  );
}

function PlayerCardPortrait({ player }) {
  const [imageSrc, setImageSrc] = useState(player.imageUrl || null);

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

  if (!imageSrc) {
    return (
      <div className="flex aspect-square w-full items-center justify-center bg-[#d9d1a5] font-['Barlow_Condensed'] text-[20px] font-black text-[#6c653f]">
        NFT
      </div>
    );
  }

  return (
    <img
      src={imageSrc}
      alt={player.name}
      className="aspect-square w-full object-cover"
      loading="lazy"
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
  const [imageSrc, setImageSrc] = useState(player.imageUrl || null);

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
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={player.name}
          className="h-full w-full rounded-[8px] border border-[#253040] bg-[#161c28] object-cover"
          loading="lazy"
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
