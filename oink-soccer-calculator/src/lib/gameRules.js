export const FORMATIONS = {
  Pyramid: {
    name: 'The Pyramid (2-1-1)',
    style: 'DEF',
    defMod: 1.02,
    ctlMod: 1.00,
    attMod: 1.03,
    structure: { GK: 1, DF: 2, MF: 1, FW: 1 },
  },
  Diamond: {
    name: 'The Diamond (1-2-1)',
    style: 'BAL',
    defMod: 1.00,
    ctlMod: 1.03,
    attMod: 1.00,
    structure: { GK: 1, DF: 1, MF: 2, FW: 1 },
  },
  Y: {
    name: 'The Y (1-1-2)',
    style: 'ATT',
    defMod: 0.97,
    ctlMod: 1.00,
    attMod: 1.0506,
    structure: { GK: 1, DF: 1, MF: 1, FW: 2 },
  },
  Box: {
    name: 'The Box (2-0-2)',
    style: 'BAL',
    defMod: 0.90,
    ctlMod: 1.12,
    attMod: 1.1025,
    structure: { GK: 1, DF: 2, MF: 0, FW: 2 },
  },
};

export const FORMATION_CHANCE_RANGES = {
  'HOME:ATT|AWAY:ATT': { min: 7, max: 15 },
  'HOME:ATT|AWAY:BAL': { min: 6, max: 12 },
  'HOME:ATT|AWAY:DEF': { min: 5, max: 11 },

  'HOME:BAL|AWAY:ATT': { min: 7, max: 12 },
  'HOME:BAL|AWAY:BAL': { min: 5, max: 10 },
  'HOME:BAL|AWAY:DEF': { min: 5, max: 10 },

  'HOME:DEF|AWAY:ATT': { min: 6, max: 11 },
  'HOME:DEF|AWAY:BAL': { min: 5, max: 10 },
  'HOME:DEF|AWAY:DEF': { min: 5, max: 9 },
};

export const FORMATION_PROFILES = {
  Pyramid: { possession: 1.00, chanceCreation: 1.00, chanceQuality: 1.03, defSolidity: 1.02, injuryRisk: 1.00 },
  Diamond: { possession: 1.03, chanceCreation: 1.00, chanceQuality: 1.00, defSolidity: 1.00, injuryRisk: 1.00 },
  Y: { possession: 1.00, chanceCreation: 1.03, chanceQuality: 1.02, defSolidity: 0.97, injuryRisk: 1.00 },
  Box: { possession: 1.12, chanceCreation: 1.05, chanceQuality: 1.05, defSolidity: 0.90, injuryRisk: 1.05 },
};

export const SKILL_CURVE = {
  exponent: 6.0,
  floor: 1.0,
};

export const POSITION_WEIGHTS = {
  control: { GK: 0.05, DF: 0.15, MF: 0.65, FW: 0.15 },
  defense: { GK: 0.35, DF: 0.40, MF: 0.20, FW: 0.05 },
};

export const TACTICS = {
  press: {
    low: { label: 'Low', controlFactor: 1.02, injuryFactor: 0.95, fatigueFactor: 1.0 },
    medium: { label: 'Medium', controlFactor: 1.0, injuryFactor: 1.0, fatigueFactor: 1.0 },
    high: { label: 'High', controlFactor: 0.94, injuryFactor: 1.10, fatigueFactor: 0.94 },
  },
  tempo: {
    slow: { label: 'Slow', chanceFactor: 0.92, qualityFactor: 1.05 },
    normal: { label: 'Normal', chanceFactor: 1.0, qualityFactor: 1.0 },
    fast: { label: 'Fast', chanceFactor: 1.10, qualityFactor: 0.96 },
  },
  lineHeight: {
    deep: { label: 'Deep', controlFactor: 1.03, defenseFactor: 1.05 },
    normal: { label: 'Normal', controlFactor: 1.0, defenseFactor: 1.0 },
    high: { label: 'High', controlFactor: 0.97, defenseFactor: 0.96 },
  },
};

export const PLAYER_ROLES = {
  none: { label: 'No role', value: '' },
  captain: { label: 'Captain', value: 'captain' },
  targetMan: { label: 'Target Man', value: 'target_man' },
  playmaker: { label: 'Playmaker', value: 'playmaker' },
  ballWinner: { label: 'Ball Winner', value: 'ball_winner' },
};

export const CHANCE_TYPES = {
  OpenPlay: {
    label: 'Open Play',
    baseWeight: 8,
    attackBoost: 1.00,
    defenseScale: 1.00,
    positionWeights: { GK: 2, DF: 10, MF: 20, FW: 70 },
  },
  Cross: {
    label: 'Cross',
    baseWeight: 5,
    attackBoost: 0.95,
    defenseScale: 1.05,
    positionWeights: { GK: 0, DF: 5, MF: 25, FW: 70 },
  },
  Corner: {
    label: 'Corner',
    baseWeight: 3,
    attackBoost: 0.90,
    defenseScale: 1.10,
    positionWeights: { GK: 0, DF: 15, MF: 25, FW: 60 },
  },
  LongRange: {
    label: 'Long Range',
    baseWeight: 3,
    attackBoost: 0.70,
    defenseScale: 1.20,
    positionWeights: { GK: 0, DF: 10, MF: 50, FW: 40 },
  },
  FreeKick: {
    label: 'Free Kick',
    baseWeight: 3,
    attackBoost: 0.85,
    defenseScale: 1.10,
    positionWeights: { GK: 0, DF: 10, MF: 45, FW: 45 },
  },
  Penalty: {
    label: 'Penalty',
    baseWeight: 2,
    attackBoost: 1.50,
    defenseScale: 0.50,
    positionWeights: { GK: 0, DF: 5, MF: 25, FW: 70 },
  },
  GoalKeeperShot: {
    label: 'Breakaway',
    baseWeight: 2,
    attackBoost: 1.20,
    defenseScale: 0.70,
    positionWeights: { GK: 0, DF: 0, MF: 20, FW: 80 },
  },
};

export const BOOSTS = {
  None: { label: 'No Boost', type: 'None', min: 1.0, max: 1.0 },
  MagicTruffle: { label: 'Magic Truffle (1-5%)', type: 'All', min: 1.01, max: 1.05 },
  GoldenTruffle: { label: 'Golden Truffle (3-7%)', type: 'All', min: 1.03, max: 1.07 },
  IridiumTruffle: { label: 'Iridium Truffle (10%)', type: 'All', min: 1.10, max: 1.10 },
  HalftimeOrange: { label: 'Half-time Orange (3-7%)', type: 'CTL', min: 1.03, max: 1.07 },
};

export const DR_DECAY = 0.97;
export const DR_MIN = 0.35;
export const DEFENSE_BIAS_MULTIPLIER = 1.05;
export const OUT_OF_POSITION_SCALE = 0.85;

const normalizeRangeMap = (ranges) =>
  Object.fromEntries(
    Object.keys(ranges)
      .sort()
      .map((key) => [key, { min: ranges[key].min, max: ranges[key].max }]),
  );

const normalizeFormations = (formations) =>
  Object.fromEntries(
    Object.keys(formations)
      .sort()
      .map((key) => {
        const form = formations[key];
        return [
          key,
          {
            style: form.style,
            defMod: form.defMod,
            ctlMod: form.ctlMod,
            attMod: form.attMod,
            profile: FORMATION_PROFILES[key],
            structure: {
              GK: form.structure.GK,
              DF: form.structure.DF,
              MF: form.structure.MF,
              FW: form.structure.FW,
            },
          },
        ];
      }),
  );

export const getRulesParityView = () => ({
  formations: normalizeFormations(FORMATIONS),
  defenseBiasMultiplier: DEFENSE_BIAS_MULTIPLIER,
  boosts: {
    decayPerApplication: DR_DECAY,
    minMultiplier: DR_MIN,
  },
  skillCurve: SKILL_CURVE,
  positionWeights: POSITION_WEIGHTS,
  tactics: TACTICS,
  chanceTypes: CHANCE_TYPES,
  chanceRanges: normalizeRangeMap(FORMATION_CHANCE_RANGES),
});
