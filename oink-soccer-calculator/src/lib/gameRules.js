export const FORMATIONS = {
  Pyramid: {
    name: 'The Pyramid (2-1-1)',
    style: 'DEF',
    defMod: 1.05,
    ctlMod: 0.97,
    attMod: 0.94,
    structure: { GK: 1, DF: 2, MF: 1, FW: 1 },
  },
  Diamond: {
    name: 'The Diamond (1-2-1)',
    style: 'BAL',
    defMod: 0.94,
    ctlMod: 1.02,
    attMod: 0.94,
    structure: { GK: 1, DF: 1, MF: 2, FW: 1 },
  },
  Y: {
    name: 'The Y (1-1-2)',
    style: 'ATT',
    defMod: 0.96,
    ctlMod: 0.98,
    attMod: 1.05,
    structure: { GK: 1, DF: 1, MF: 1, FW: 2 },
  },
  Box: {
    name: 'The Box (2-0-2)',
    style: 'BAL',
    defMod: 1.05,
    ctlMod: 1,
    attMod: 1.05,
    structure: { GK: 1, DF: 2, MF: 0, FW: 2 },
  },
};

export const FORMATION_CHANCE_RANGES = {
  'HOME:ATT|AWAY:ATT': { min: 7, max: 15 },
  'HOME:ATT|AWAY:BAL': { min: 6, max: 12 },
  'HOME:ATT|AWAY:DEF': { min: 5, max: 11 },

  'HOME:BAL|AWAY:ATT': { min: 7, max: 12 },
  'HOME:BAL|AWAY:BAL': { min: 4, max: 9 },
  'HOME:BAL|AWAY:DEF': { min: 3, max: 8 },

  'HOME:DEF|AWAY:ATT': { min: 6, max: 11 },
  'HOME:DEF|AWAY:BAL': { min: 3, max: 8 },
  'HOME:DEF|AWAY:DEF': { min: 2, max: 6 },
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
  chanceRanges: normalizeRangeMap(FORMATION_CHANCE_RANGES),
});

