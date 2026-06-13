import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Bandage, X, TrendingUp, ChevronDown, ChevronUp, RefreshCw, ArrowDownWideNarrow, ArrowUpNarrowWide, Link2 } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import { fetchHeldAssetIdsForAddresses } from './lib/indexer';
import { buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import {
  fetchCurrentSeason,
  fetchLeagueTableTeams,
  fetchLeagueTeamsIndex,
  fetchTeamBoostState,
  findTeamsByName,
  importOpponentFromTeamInput,
  resolveOwnedTeamLeagues,
} from './lib/lostPigsTeamImport';
import {
  createEmptyTeamBoostState,
  createManualFallbackBoostState,
  formatBoostEffectRange,
  getBoostMultipliersFromState,
} from './lib/boosts';
import { resolvePlayerImage } from './lib/assetImages';
import {
  BOOSTS,
  CHANCE_TYPES,
  DEFENSE_BIAS_MULTIPLIER,
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

const formatBoostTypeLabel = (entry) => {
  const boost = entry?.boost || {};
  if (boost.boost_type === 'Position Boost' && boost.boost_position === 'Midfield') {
    return 'Control boost';
  }
  return boost.boost_type || 'Unknown boost';
};


export default function OinkSoccerCalc() {
  const { wallets } = useWallet();
  const persistedState = useMemo(() => loadCalculatorState(), []);
  const autoSyncedAddressKeyRef = useRef('');

  const [importingTeamUrl, setImportingTeamUrl] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [teamUrlInput, setTeamUrlInput] = useState('');
  const [leagueIndex, setLeagueIndex] = useState(null);
  const [leagueIndexLoading, setLeagueIndexLoading] = useState(false);
  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [selectedLeagueName, setSelectedLeagueName] = useState('');
  const [leagueTeams, setLeagueTeams] = useState([]);
  const [leagueTeamsLoading, setLeagueTeamsLoading] = useState(false);
  const [detectedMyTeamIds, setDetectedMyTeamIds] = useState([]);
  const [opponentSearchInput, setOpponentSearchInput] = useState('');
  const [selectedOpponentTeamId, setSelectedOpponentTeamId] = useState('');
  const [importedOpponentTeamId, setImportedOpponentTeamId] = useState(null);
  const [catalogSeason, setCatalogSeason] = useState(null);
  const [walletSyncing, setWalletSyncing] = useState(false);
  const [boostStatesLoading, setBoostStatesLoading] = useState(false);

  const [mySquad, setMySquad] = useState(persistedState.mySquad || initialMyTeam); // Full roster
  const [myTeam, setMyTeam] = useState(persistedState.myTeam || initialMyTeam.slice(0, 5)); // Active 5
  const [opponentTeam, setOpponentTeam] = useState(persistedState.opponentTeam || initialOpponent);
  const [myForm, setMyForm] = useState(persistedState.myForm || 'Pyramid');
  const [oppForm, setOppForm] = useState(persistedState.oppForm || 'Pyramid');
  const [myTactics, setMyTactics] = useState(normalizeTactics(persistedState.myTactics));
  const [oppTactics, setOppTactics] = useState(normalizeTactics(persistedState.oppTactics));

  const [myBoost, setMyBoost] = useState(persistedState.myBoost || 'None');
  const [myBoostApps] = useState(persistedState.myBoostApps || 1);
  const [myBoostState, setMyBoostState] = useState(createManualFallbackBoostState(persistedState.myBoost || 'None', persistedState.myBoostApps || 1));
  const [oppBoostState, setOppBoostState] = useState(TEAM_BOOST_STATE_EMPTY);
  const [homeAdvantage] = useState(persistedState.homeAdvantage || 'home'); // 'home' or 'away'
  const [walletSyncMeta, setWalletSyncMeta] = useState(
    persistedState.walletSyncMeta || {
      lastSyncedAt: null,
      matchedCount: 0,
      unmatchedCount: 0,
      lastError: null,
    },
  );

  const [activeTab, setActiveTab] = useState('squad');
  const [editingId, setEditingId] = useState(null);
  const [formTarget, setFormTarget] = useState('mySquad');
  const [showManualForm, setShowManualForm] = useState(false);

  // --- Sorting & Filtering State ---
  const [benchFilter, setBenchFilter] = useState('All');
  const [benchSort, setBenchSort] = useState('ovr_desc'); // 'ovr_desc' or 'ovr_asc'

  const [newPlayer, setNewPlayer] = useState({
    name: '', pos: 'FW',
    stats: { DEF: 50, CTL: 50, ATT: 50, SPD: 50, GKP: 0, WRT: 0, FIN: 0, HDG: 0, TEC: 0, CMP: 0, TCK: 0 },
    injury: null
  });

  const [suggestions, setSuggestions] = useState({});
  const [analyzing, setAnalyzing] = useState(false);
  const [autoSuggestions, setAutoSuggestions] = useState({});
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [copiedPlan, setCopiedPlan] = useState(false);
  const [injuryModalState, setInjuryModalState] = useState({
    open: false,
    playerId: null,
    teamType: null,
    selected: 'None',
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

  const leagueOptions = useMemo(() => {
    const byLeague = leagueIndex?.byLeague || {};
    const leagueNames = leagueIndex?.leagueNames || {};
    return Object.keys(byLeague)
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => ({ id, label: leagueNames[id] || `League ${id}` }));
  }, [leagueIndex]);

  const filteredOpponentOptions = useMemo(() => {
    const blocked = new Set(detectedMyTeamIds);
    const candidates = (leagueTeams || []).filter((team) => !blocked.has(team.teamId));
    return findTeamsByName(candidates, opponentSearchInput).slice(0, 25);
  }, [detectedMyTeamIds, leagueTeams, opponentSearchInput]);

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

  const myDisplayBoostState = myBoostState;

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
    if (!selectedLeagueId) {
      setLeagueTeams([]);
      setSelectedLeagueName('');
      return;
    }

    let cancelled = false;
    setLeagueTeamsLoading(true);

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
      .finally(() => {
        if (!cancelled) {
          setLeagueTeamsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLeagueId]);

  useEffect(() => {
    if (!selectedOpponentTeamId) return;
    if (filteredOpponentOptions.some((team) => team.teamId === selectedOpponentTeamId)) return;
    setSelectedOpponentTeamId('');
  }, [filteredOpponentOptions, selectedOpponentTeamId]);

  useEffect(() => {
    let cancelled = false;

    const loadBoostStates = async () => {
      const myFallback = createManualFallbackBoostState(myBoost, myBoostApps);
      const oppFallback = createEmptyTeamBoostState();

      const canFetchMyTeam = Boolean(myTeamIdForBoosts && myTeamLeagueIdForBoosts);
      const canFetchOppTeam = Boolean(opponentTeam.length > 0 && opponentTeamIdForBoosts && oppTeamLeagueIdForBoosts);

      if (!canFetchMyTeam && !canFetchOppTeam) {
        if (!cancelled) {
          setBoostStatesLoading(false);
          setMyBoostState(myFallback);
          setOppBoostState(oppFallback);
        }
        return;
      }

      setBoostStatesLoading(true);

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
      } finally {
        if (!cancelled) {
          setBoostStatesLoading(false);
        }
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
      homeAdvantage: overrides.homeAdvantage !== undefined ? overrides.homeAdvantage : homeAdvantage,
      walletSyncMeta: overrides.walletSyncMeta !== undefined ? overrides.walletSyncMeta : walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myTactics, oppTactics, myBoost, myBoostApps, homeAdvantage, walletSyncMeta]);

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
      homeAdvantage,
      walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myTactics, oppTactics, myBoost, myBoostApps, homeAdvantage, walletSyncMeta]);

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
      const [catalogPayload, heldAssetIds] = await Promise.all([
        loadPlayableCatalog(),
        fetchHeldAssetIdsForAddresses(addressesToSync),
      ]);

      const catalogByAssetId = catalogPayload?.assets || {};
      const { walletPlayers, matchedCount, unmatchedCount } = buildWalletPlayers(heldAssetIds, catalogByAssetId);
      const { nextSquad, nextTeam } = mergeWalletPlayers({ mySquad, myTeam, walletPlayers });

      const updatedMeta = {
        lastSyncedAt: new Date().toISOString(),
        matchedCount,
        unmatchedCount,
        lastError: null,
      };

      setMySquad(nextSquad);
      setMyTeam(nextTeam);
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
  }, [connectedAddresses, mySquad, myTeam, saveToDb, walletSyncMeta, walletSyncing]);

  useEffect(() => {
    if (!connectedAddressKey) {
      autoSyncedAddressKeyRef.current = '';
      return;
    }

    if (walletSyncing || autoSyncedAddressKeyRef.current === connectedAddressKey) {
      return;
    }

    autoSyncedAddressKeyRef.current = connectedAddressKey;
    void handleSyncWalletAssets(connectedAddresses);
  }, [connectedAddressKey, connectedAddresses, handleSyncWalletAssets, walletSyncing]);

  const importOpponentFromInput = useCallback(async (teamInput) => {
    if (importingTeamUrl) return;

    setImportingTeamUrl(true);
    setUploadStatus({ tone: 'info', message: 'Fetching opponent lineup from Lost Pigs API...' });

    try {
      const imported = await importOpponentFromTeamInput(teamInput);
      const nextFormation = imported.formationKey && FORMATIONS[imported.formationKey]
        ? imported.formationKey
        : oppForm;

      setImportedOpponentTeamId(imported.teamId || null);
      if (imported.teamId) {
        setSelectedOpponentTeamId(imported.teamId);
      }
      setOppForm(nextFormation);
      setOpponentTeam(imported.players);
      saveToDb({ opponentTeam: imported.players, oppForm: nextFormation });

      const formationText = imported.formationKey
        ? ` Formation: ${FORMATIONS[imported.formationKey].name}.`
        : '';

      setUploadStatus({
        tone: 'success',
        message: `Imported ${imported.players.length} opponent lineup players from ${imported.teamLabel}.${formationText}`,
      });
    } catch (err) {
      setUploadStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Team import failed.',
      });
    } finally {
      setImportingTeamUrl(false);
    }
  }, [importingTeamUrl, oppForm, saveToDb]);

  const handleImportTeamUrl = useCallback(async () => {
    if (!teamUrlInput.trim()) {
      setUploadStatus({ tone: 'error', message: 'Enter a Lost Pigs team URL or teamId first.' });
      return;
    }
    await importOpponentFromInput(teamUrlInput.trim());
  }, [importOpponentFromInput, teamUrlInput]);

  const handleImportSelectedOpponent = useCallback(async () => {
    const candidateTeamId = selectedOpponentTeamId || filteredOpponentOptions[0]?.teamId;
    if (!candidateTeamId) {
      setUploadStatus({ tone: 'error', message: 'Select an opponent team first.' });
      return;
    }
    await importOpponentFromInput(candidateTeamId);
  }, [filteredOpponentOptions, importOpponentFromInput, selectedOpponentTeamId]);

  const handleFormChange = (type, val) => {
    if (type === 'my') {
      setMyForm(val);
      saveToDb({ myForm: val });
    } else {
      setOppForm(val);
      saveToDb({ oppForm: val });
    }
  };

  const handleBoostChange = (boostType) => {
    setMyBoost(boostType);
    saveToDb({ myBoost: boostType });
  }

  const handleTacticChange = (teamType, key, value) => {
    if (teamType === 'my') {
      const next = normalizeTactics({ ...myTactics, [key]: value });
      setMyTactics(next);
      saveToDb({ myTactics: next });
      return;
    }
    const next = normalizeTactics({ ...oppTactics, [key]: value });
    setOppTactics(next);
    saveToDb({ oppTactics: next });
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

  const handleSwap = (benchPlayer) => {
    if (myTeam.find(p => p.id === benchPlayer.id)) {
      const newActive = myTeam.filter(p => p.id !== benchPlayer.id);
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
      return;
    }

    if (myTeam.length < 5) {
      const newActive = [...myTeam, benchPlayer];
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
      return;
    }

    const playerValidPos = benchPlayer.positions || [benchPlayer.pos];
    const samePosIndex = myTeam.findIndex(p => {
      const activeValidPos = p.positions || [p.pos];
      return activeValidPos.some(pos => playerValidPos.includes(pos));
    });
    if (samePosIndex !== -1) {
      const newActive = [...myTeam];
      newActive[samePosIndex] = benchPlayer;
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
    } else {
      const newActive = [...myTeam];
      newActive[4] = benchPlayer;
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
    }
  };

  // --- Bench Sort & Filter ---
  const toggleSort = () => {
    setBenchSort(prev => prev === 'ovr_desc' ? 'ovr_asc' : 'ovr_desc');
  };

  const benchPool = useMemo(() => {
    const activeIds = new Set(myTeam.map(p => p.id));
    return mySquad.filter(p => !activeIds.has(p.id));
  }, [mySquad, myTeam]);

  const benchPlayers = useMemo(() => {
    let players = [...benchPool];

    // Filter
    if (benchFilter !== 'All') {
      players = players.filter(p => p.pos === benchFilter);
    }

    // Sort
    players.sort((a, b) => {
      if (benchSort === 'ovr_desc') return b.ovr - a.ovr;
      if (benchSort === 'ovr_asc') return a.ovr - b.ovr;
      return 0;
    });

    return players;
  }, [benchPool, benchFilter, benchSort]);

  const getCombinations = useCallback((arr, k) => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];
    const [first, ...rest] = arr;
    const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = getCombinations(rest, k);
    return [...withFirst, ...withoutFirst];
  }, []);

  const buildSettingsSuggestions = useCallback((currentWin = parseFloat(simulation.win)) => {
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
              oppStats,
              oppForm,
              oppTactics,
              homeAdvantage,
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
    { key: 'squad', icon: '👥', label: 'Squad' },
    { key: 'opponent', icon: '⚔️', label: 'Opponent' },
    { key: 'conditions', icon: '⚡', label: 'Conditions' },
    { key: 'simulation', icon: '📊', label: 'Simulation' },
    { key: 'bench', icon: '🪑', label: 'Bench' },
  ]), []);

  const winPct = Number.parseFloat(simulation.win) || 0;
  const scoreGap = Number(simulation.myxG) - Number(simulation.oppxG);
  const drawPct = Math.max(12, Math.min(34, 24 - Math.abs(scoreGap) * 7));
  const remaining = Math.max(0, 100 - drawPct);
  const winShare = Math.max(0, Math.min(1, winPct / 100));
  const forecastWin = Number((remaining * winShare).toFixed(1));
  const forecastLoss = Number((100 - drawPct - forecastWin).toFixed(1));
  const forecastDraw = Number((100 - forecastWin - forecastLoss).toFixed(1));

  const controlDelta = Number((myStats.Control - oppStats.Control).toFixed(1));
  const defenseDelta = Number((myStats.Defense - oppStats.Defense).toFixed(1));
  const attackDelta = Number((myStats.Attack - oppStats.Attack).toFixed(1));

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

  const openInjuryModal = useCallback((player, teamType) => {
    setInjuryModalState({
      open: true,
      playerId: player.id,
      teamType,
      selected: player.injury || 'None',
    });
  }, []);

  const closeInjuryModal = useCallback(() => {
    setInjuryModalState({
      open: false,
      playerId: null,
      teamType: null,
      selected: 'None',
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

  const manualBoostFallbackActive = !hasLiveMyTeamBoosts;

  const annotation = useMemo(() => {
    const worstDelta = Math.min(controlDelta, defenseDelta, attackDelta);
    if (topSuggestion && topSuggestion.formation && topSuggestion.diff > 0) {
      return `Smart Coach sees an upgrade: ${FORMATIONS[topSuggestion.formation].name} projects ${topSuggestion.win.toFixed(1)}% win (${topSuggestion.diff.toFixed(1)} higher than current).`;
    }
    if (worstDelta >= 0) {
      return `You are ahead across key metrics. Keep ${FORMATIONS[myForm]?.name || myForm} and preserve pressure with ${myBoost === 'None' ? 'No Boost' : BOOSTS[myBoost]?.label}.`;
    }
    if (controlDelta === worstDelta) {
      return `Control gap detected: you are ${Math.abs(controlDelta).toFixed(1)} behind. Run Smart Coach to find the highest-win formation from your current bench.`;
    }
    if (defenseDelta === worstDelta) {
      return `Defense is trailing by ${Math.abs(defenseDelta).toFixed(1)}. Home location and lineup optimization can reduce opponent xG before kickoff.`;
    }
    return `Attack is trailing by ${Math.abs(attackDelta).toFixed(1)}. Run Smart Coach to identify the best attacking lineup from available players.`;
  }, [attackDelta, controlDelta, defenseDelta, myBoost, myForm, topSuggestion]);

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
                  {tab.key === 'bench' && (
                    <span className="rounded-full border border-[#253040] bg-[#1a2233] px-1.5 py-0.5 text-[10px] leading-none text-[#9aa5bb]">
                      {benchPool.length}
                    </span>
                  )}
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
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#6b7a94]">Win Probability</div>
            <div className="font-['Barlow_Condensed'] text-[42px] font-black leading-none text-[#00e676]">{simulation.win}%</div>
            <div className="text-[11px] text-[#6b7a94]">Based on {(Number(simulation.myxG) + Number(simulation.oppxG)).toFixed(2)} simulated goals</div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#00e676]">{simulation.myxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">You</div>
            </div>
            <div className="pb-1 font-['Barlow_Condensed'] text-2xl text-[#6b7a94]">:</div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#ffab00]">{simulation.oppxG}</div>
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

      <main className="mx-auto max-w-[900px] px-4 py-5 md:px-6 md:py-6">
        <BestSetupCard
          suggestion={topSuggestion}
          analyzing={autoAnalyzing}
          canAnalyze={mySquad.length >= 5 && opponentTeam.length >= 5}
          copied={copiedPlan}
          onApply={() => applySuggestion(topSuggestion)}
          onCopy={() => void copySuggestion(topSuggestion)}
        />

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

        {activeTab === 'opponent' && (
          <section id="tab-opponent" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="mb-1 text-sm font-bold">⟳ Import Opponent</div>
              <div className="mb-3 text-xs text-[#6b7a94]">Search opponents by team name in the same league as your club.</div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px,1fr,auto]">
                <select
                  value={selectedLeagueId}
                  onChange={(e) => {
                    setSelectedLeagueId(e.target.value);
                    setSelectedOpponentTeamId('');
                    setOpponentSearchInput('');
                  }}
                  disabled={importingTeamUrl || leagueIndexLoading}
                  className="rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                >
                  <option value="">{leagueIndexLoading ? 'Loading leagues...' : 'Select league'}</option>
                  {leagueOptions.map((league) => (
                    <option key={league.id} value={league.id}>{league.label}</option>
                  ))}
                </select>

                <input
                  type="text"
                  value={opponentSearchInput}
                  onChange={(e) => {
                    setOpponentSearchInput(e.target.value);
                    setSelectedOpponentTeamId('');
                  }}
                  placeholder={selectedLeagueId ? 'Search opponent by team name...' : 'Select a league first'}
                  className="min-w-0 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                  disabled={importingTeamUrl || !selectedLeagueId || leagueTeamsLoading}
                />

                <button
                  onClick={() => void handleImportSelectedOpponent()}
                  disabled={importingTeamUrl || !selectedLeagueId || leagueTeamsLoading || filteredOpponentOptions.length === 0}
                  className="rounded-md bg-[#2979ff] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700"
                >
                  {importingTeamUrl ? 'Loading...' : 'Import Selected'}
                </button>
              </div>

              <div className="mt-2 rounded-md border border-[#1e2a3a] bg-[#111620] p-2">
                <div className="mb-1 text-[11px] uppercase tracking-[0.1em] text-[#6b7a94]">
                  {selectedLeagueId
                    ? `Teams${selectedLeagueName ? ` • ${selectedLeagueName}` : ''}`
                    : 'Teams'}
                </div>

                {leagueTeamsLoading && (
                  <div className="text-xs text-[#9aa5bb]">Loading league teams...</div>
                )}

                {!leagueTeamsLoading && !selectedLeagueId && (
                  <div className="text-xs text-[#9aa5bb]">Choose a league to browse opponent teams.</div>
                )}

                {!leagueTeamsLoading && selectedLeagueId && filteredOpponentOptions.length === 0 && (
                  <div className="text-xs text-[#9aa5bb]">
                    {opponentSearchInput.trim() ? 'No teams match your search.' : 'No opponent teams available.'}
                  </div>
                )}

                {!leagueTeamsLoading && selectedLeagueId && filteredOpponentOptions.length > 0 && (
                  <div className="max-h-40 space-y-1 overflow-auto pr-1">
                    {filteredOpponentOptions.map((team) => (
                      <button
                        key={team.teamId}
                        onClick={() => setSelectedOpponentTeamId(team.teamId)}
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition ${selectedOpponentTeamId === team.teamId
                          ? 'border-[#2979ff] bg-[#0f1f39] text-[#9fc6ff]'
                          : 'border-[#1e2a3a] bg-[#141a26] text-[#d0d7e5] hover:border-[#2f3f59]'
                          }`}
                      >
                        <div className="font-semibold">{team.teamName}</div>
                        <div className="text-[10px] text-[#7f8aa3]">{team.teamId}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 border-t border-[#1e2a3a] pt-3">
                <div className="mb-2 text-xs font-semibold text-[#9aa5bb]">Manual fallback: URL or teamId</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={teamUrlInput}
                    onChange={(e) => setTeamUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleImportTeamUrl();
                      }
                    }}
                    placeholder="https://www.thelostpigs.com/oink-soccer/team?teamId=..."
                    className="min-w-0 flex-1 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                    disabled={importingTeamUrl}
                  />
                  <button
                    onClick={() => void handleImportTeamUrl()}
                    disabled={importingTeamUrl}
                    className="rounded-md bg-[#24344f] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700"
                  >
                    {importingTeamUrl ? 'Loading...' : 'Import URL'}
                  </button>
                </div>
              </div>

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

            {opponentTeam.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                teamType="opponent"
                onInjuryOpen={() => openInjuryModal(p, 'opponent')}
                onRoleChange={(role) => handleRoleChange(p, role, 'opponent')}
              />
            ))}
            {opponentTeam.length === 0 && (
              <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No opponent lineup imported yet.</div>
            )}
          </section>
        )}

        {activeTab === 'conditions' && (
          <section id="tab-conditions" className="space-y-4">
            <div className="grid grid-cols-1 gap-3 min-[780px]:grid-cols-2">
              <TacticsCard
                title="My Tactics"
                tone="my"
                tactics={myTactics}
                players={myTeam}
                onChange={(key, value) => handleTacticChange('my', key, value)}
              />
              <TacticsCard
                title="Opponent Tactics"
                tone="opp"
                tactics={oppTactics}
                players={opponentTeam}
                onChange={(key, value) => handleTacticChange('opp', key, value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 min-[500px]:grid-cols-2">
              {/* Location selection hidden as it only affects match tempo (xG volume) without changing win probability ratios in core game logic */}

              <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">⚡ Active Boost</div>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(BOOSTS).map((key) => (
                    <button
                      key={key}
                      disabled={!manualBoostFallbackActive}
                      onClick={() => handleBoostChange(key)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${myBoost === key
                        ? key === 'None'
                          ? 'border-[#253040] bg-[#161c28] text-[#e8edf5]'
                          : 'border-[#ffab00] bg-[#ffab00] text-black'
                        : 'border-[#1e2a3a] bg-[#111620] text-[#9aa5bb]'
                        } ${manualBoostFallbackActive ? '' : 'cursor-not-allowed opacity-50'}`}
                    >
                      {BOOSTS[key].label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-xs text-[#6b7a94]">
                  {manualBoostFallbackActive
                    ? 'Manual boosts are enabled for simulation because no live active boost is currently applied.'
                    : 'Live boost data is active. Manual boosts are disabled until fallback is needed.'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 min-[780px]:grid-cols-2">
              <BoostStateCard
                title="My Team Boost State"
                boostState={myDisplayBoostState}
                loading={boostStatesLoading}
              />
              <BoostStateCard
                title="Opponent Boost State"
                boostState={oppBoostContext}
                loading={boostStatesLoading}
              />
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <ComparisonStat title="Team Control" mine={myStats.Control} opp={oppStats.Control} />
              <div className="my-3" />
              <ComparisonStat title="Team Defense" mine={myStats.Defense} opp={oppStats.Defense} />
              <div className="my-3" />
              <ComparisonStat title="Eff. Attack" mine={myStats.Attack} opp={oppStats.Attack} />
            </div>

            <div className="rounded-lg border border-[rgba(0,230,118,0.18)] bg-[rgba(0,230,118,0.06)] px-4 py-3 text-sm text-[#9bd7bd]">
              ⚠️ <strong className="text-[#00e676]">Insight:</strong> {annotation}
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

        {activeTab === 'bench' && (
          <section id="tab-bench" className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {['All', 'GK', 'DF', 'MF', 'FW'].map((pos) => {
                const count = pos === 'All' ? benchPool.length : benchPool.filter((p) => p.pos === pos).length;
                return (
                  <button
                    key={pos}
                    onClick={() => setBenchFilter(pos)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${benchFilter === pos ? 'border-[#253040] bg-[#161c28] text-[#e8edf5]' : 'border-[#1e2a3a] bg-[#111620] text-[#9aa5bb]'}`}
                  >
                    {pos} ({count})
                  </button>
                );
              })}
              <button onClick={toggleSort} className="rounded-md border border-[#1e2a3a] bg-[#161c28] p-1.5 text-[#9aa5bb]">
                {benchSort === 'ovr_desc' ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />}
              </button>
            </div>

            {benchPlayers.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                teamType="mySquad"
                onInjuryOpen={() => openInjuryModal(p, 'mySquad')}
                onRoleChange={(role) => handleRoleChange(p, role, 'mySquad')}
                onSwap={() => handleSwap(p)}
                isBench
              />
            ))}
            {benchPlayers.length === 0 && (
              <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No bench players in this filter.</div>
            )}
          </section>
        )}
      </main>

      {injuryModalState.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-[320px] rounded-xl border border-[#253040] bg-[#161c28] p-6">
            <div className="text-[15px] font-bold">🩹 Injury Severity</div>
            <p className="mt-1 text-xs text-[#6b7a94]">Select how severely this player is injured if they play.</p>

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

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={closeInjuryModal} className="rounded-md border border-[#1e2a3a] bg-transparent px-3 py-1.5 text-xs font-semibold text-[#9aa5bb]">Cancel</button>
              <button onClick={confirmInjuryModal} className="rounded-md bg-[#ffab00] px-3 py-1.5 text-xs font-bold text-black">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// --- Components ---

function BestSetupCard({ suggestion, analyzing, canAnalyze, copied, onApply, onCopy }) {
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
    <section className="mb-4 overflow-hidden rounded-[10px] border border-[rgba(0,230,118,0.28)] bg-[#111620]">
      <div className="flex flex-col gap-3 border-b border-[#1e2a3a] p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">Best Setup</div>
          <div className="mt-1 font-['Barlow_Condensed'] text-[26px] font-black leading-none text-[#e8edf5]">
            {details.formation}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-[#d0d7e5]">
            <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Press {TACTICS.press[suggestion.tactics.press]?.label}</span>
            <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Tempo {TACTICS.tempo[suggestion.tactics.tempo]?.label}</span>
            <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Line {TACTICS.lineHeight[suggestion.tactics.lineHeight]?.label}</span>
            <span className="rounded border border-[#253040] bg-[#161c28] px-2 py-1">Set pieces {details.setPiecePlayer?.name || 'Auto'}</span>
          </div>
          {details.roleLabels.length > 0 && (
            <div className="mt-2 text-xs leading-5 text-[#9aa5bb]">{details.roleLabels.join(' · ')}</div>
          )}
          <div className="mt-2 text-xs text-[#6b7a94]">
            Projection: {formatNumber(suggestion.win)}% win, xG {formatNumber(suggestion.myxG)}:{formatNumber(suggestion.oppxG)}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:w-[180px] sm:grid-cols-1">
          <button
            type="button"
            onClick={onCopy}
            className="rounded-md border border-[#00e676]/40 bg-[#00e676] px-3 py-2 text-xs font-bold text-[#07110c]"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-md border border-[#253040] bg-[#161c28] px-3 py-2 text-xs font-semibold text-[#e8edf5]"
          >
            Apply
          </button>
        </div>
      </div>
      <FormationPitch suggestion={suggestion} details={details} />
    </section>
  );
}

function FormationPitch({ suggestion, details }) {
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

function FormationPlayerCard({ player, setPieceTaker }) {
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

function TacticsCard({ title, tone, tactics, players, onChange }) {
  const accent = tone === 'opp' ? '#ffab00' : '#00e676';
  const normalized = normalizeTactics(tactics);
  const selectClass = "w-full rounded-md border border-[#1e2a3a] bg-[#111620] px-2 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#00e676]";

  return (
    <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-[0.1em]" style={{ color: accent }}>{title}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Press</span>
          <select value={normalized.press} onChange={(event) => onChange('press', event.target.value)} className={selectClass}>
            {Object.entries(TACTICS.press).map(([key, value]) => (
              <option key={key} value={key}>{value.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Tempo</span>
          <select value={normalized.tempo} onChange={(event) => onChange('tempo', event.target.value)} className={selectClass}>
            {Object.entries(TACTICS.tempo).map(([key, value]) => (
              <option key={key} value={key}>{value.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Line</span>
          <select value={normalized.lineHeight} onChange={(event) => onChange('lineHeight', event.target.value)} className={selectClass}>
            {Object.entries(TACTICS.lineHeight).map(([key, value]) => (
              <option key={key} value={key}>{value.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Set Pieces</span>
          <select value={normalized.setPieceTaker} onChange={(event) => onChange('setPieceTaker', event.target.value)} className={selectClass}>
            <option value="">Auto</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>{player.name}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function ComparisonStat({ title, mine, opp }) {
  const delta = Number((mine - opp).toFixed(1));
  const deltaPositive = delta >= 0;

  return (
    <div>
      <div className="mb-1 flex items-end justify-between gap-3">
        <div className="inline-flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">{title}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${deltaPositive ? 'border-[#00e676]/40 bg-[#00e676]/10 text-[#00e676]' : 'border-[#ff4444]/40 bg-[#ff4444]/10 text-[#ff4444]'}`}>
            {deltaPositive ? '+' : ''}{delta} vs Opp
          </span>
        </div>
        <div className="flex items-end gap-1">
          <span className="font-['Barlow_Condensed'] text-2xl font-bold text-[#00e676]">{mine.toFixed(1)}</span>
          <span className="font-['Barlow_Condensed'] text-lg font-semibold text-[#9aa5bb]">/ {opp.toFixed(1)}</span>
        </div>
      </div>
      <div className="relative h-1.5 rounded bg-[#161c28]">
        <div className="absolute left-0 top-0 h-1.5 rounded bg-[#00e676]" style={{ width: `${Math.max(0, Math.min(100, mine))}%` }} />
        <div className="absolute top-[-2px] h-2.5 w-1 rounded bg-[#ffab00]" style={{ left: `${Math.max(0, Math.min(100, opp))}%` }} />
      </div>
    </div>
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

function BoostStateCard({ title, boostState, loading }) {
  const boosts = Array.isArray(boostState?.boosts) ? boostState.boosts : [];
  const sourceLabel = boostState?.source === 'live' ? 'Live' : 'Manual fallback';
  const sourceClass = boostState?.source === 'live'
    ? 'border-[rgba(0,230,118,0.35)] bg-[rgba(0,230,118,0.1)] text-[#00e676]'
    : 'border-[#253040] bg-[#161c28] text-[#9aa5bb]';

  return (
    <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-[0.1em] text-[#9aa5bb]">{title}</div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sourceClass}`}>
          {sourceLabel}
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-[#6b7a94]">Loading boost state...</div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">Days boosted</div>
              <div className="font-['Barlow_Condensed'] text-xl font-bold text-[#e8edf5]">
                {boostState?.daysBoosted ?? '—'}
              </div>
            </div>
            <div className="rounded border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">Effectiveness</div>
              <div className="font-['Barlow_Condensed'] text-xl font-bold text-[#e8edf5]">
                {boostState?.effectivenessPct == null ? '—' : `${Number(boostState.effectivenessPct).toFixed(1)}%`}
              </div>
            </div>
          </div>

          {boostState?.fetchError && (
            <div className="mb-3 rounded border border-[rgba(255,68,68,0.35)] bg-[rgba(255,68,68,0.08)] px-2 py-1.5 text-xs text-[#ff8b8b]">
              {boostState.fetchError}
            </div>
          )}

          <div className="space-y-2">
            {boosts.length === 0 && (
              <div className="rounded border border-dashed border-[#253040] px-2 py-2 text-xs text-[#6b7a94]">
                No active boosts.
              </div>
            )}
            {boosts.map((entry, index) => {
              const boost = entry?.boost || {};
              const expires = entry?.expires ? new Date(entry.expires) : null;
              const expiresText = expires && !Number.isNaN(expires.getTime())
                ? expires.toLocaleString()
                : 'N/A';
              return (
                <div key={`${boost.boost_type || 'boost'}-${index}`} className="rounded border border-[#1e2a3a] bg-[#161c28] px-2 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="font-semibold text-[#e8edf5]">{formatBoostTypeLabel(entry)}</div>
                    <div className="text-[#9aa5bb]">{formatBoostEffectRange(entry)}</div>
                  </div>
                  <div className="mt-1 text-[11px] text-[#6b7a94]">
                    Applications: {Number(boost.applications ?? 0)} · Expires: {expiresText}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
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
          onClick={onInjuryOpen}
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
