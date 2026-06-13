#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_COMMON_PATHS = [
  process.env.OINK_COMMON_PATH,
  '/tmp/oink-soccer-common',
  path.resolve(process.cwd(), '../oink-soccer-common'),
].filter(Boolean);

const UPSTREAM_REPO_URL = process.env.OINK_COMMON_SOURCE_REPO || 'https://github.com/stein-f/oink-soccer-common';

const resolveCommonPath = () => {
  const explicit = process.argv[2];
  if (explicit) {
    return path.resolve(explicit);
  }
  for (const candidate of DEFAULT_COMMON_PATHS) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'Could not find oink-soccer-common. Pass the path as: node scripts/generate-game-rules-snapshot.mjs /path/to/oink-soccer-common',
  );
};

const readFile = (root, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const parseFloatFrom = (source, regex, label) => {
  const match = source.match(regex);
  if (!match) {
    throw new Error(`Could not parse ${label}`);
  }
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${label}`);
  }
  return parsed;
};

const parseStructure = (slotsBlock) => {
  const structure = { GK: 0, DF: 0, MF: 0, FW: 0 };
  const mappings = [
    ['PlayerPositionGoalkeeper', 'GK'],
    ['PlayerPositionDefense', 'DF'],
    ['PlayerPositionMidfield', 'MF'],
    ['PlayerPositionAttack', 'FW'],
  ];
  for (const [token, key] of mappings) {
    const regex = new RegExp(token, 'g');
    const count = (slotsBlock.match(regex) || []).length;
    structure[key] = count;
  }
  return structure;
};

const parseFormationBlock = (source, varName, style) => {
  const regex = new RegExp(`${varName}\\s*=\\s*map\\[uint64\\]PlayerPosition\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm');
  const match = source.match(regex);
  if (!match) {
    throw new Error(`Could not parse formation block for ${varName}`);
  }

  return {
    style,
    defMod: 1,
    ctlMod: 1,
    attMod: 1,
    structure: parseStructure(match[1]),
  };
};

const parseChanceRanges = (source) => {
  const result = {};
  const regex = /"([^"]+)":\s*\{Min:\s*([0-9]+),\s*Max:\s*([0-9]+)\}/g;
  let match = regex.exec(source);
  while (match) {
    const key = match[1];
    result[key] = {
      min: Number.parseInt(match[2], 10),
      max: Number.parseInt(match[3], 10),
    };
    match = regex.exec(source);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};

const getSourceMetadata = (commonRoot) => {
  try {
    const sourceRef = execSync('git rev-parse HEAD', {
      cwd: commonRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const generatedAt = execSync('git show -s --format=%cI HEAD', {
      cwd: commonRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return {
      sourceRef,
      generatedAt: generatedAt || new Date().toISOString(),
    };
  } catch {
    return {
      sourceRef: null,
      generatedAt: new Date().toISOString(),
    };
  }
};

const main = () => {
  const commonRoot = resolveCommonPath();
  const formationSource = readFile(commonRoot, 'v2/formation.go');
  const tuningSource = readFile(commonRoot, 'v2/internal/tuning/tuning.go');
  const sourceMetadata = getSourceMetadata(commonRoot);
  const formationNameByKey = {
    Box: 'The Box',
    Diamond: 'The Diamond',
    Pyramid: 'The Pyramid',
    Y: 'The Y',
  };
  const formationStyleByKey = {
    Box: 'BAL',
    Diamond: 'BAL',
    Pyramid: 'DEF',
    Y: 'ATT',
  };
  const parseFormationProfile = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`"${escaped}":\\s*\\{Possession:\\s*([0-9.]+),\\s*ChanceCreation:\\s*([0-9.]+),\\s*ChanceQuality:\\s*([0-9.]+),\\s*DefSolidity:\\s*([0-9.]+),\\s*InjuryRisk:\\s*([0-9.]+)\\}`);
    const match = tuningSource.match(regex);
    if (!match) {
      throw new Error(`Could not parse formation profile for ${name}`);
    }
    return {
      possession: Number.parseFloat(match[1]),
      chanceCreation: Number.parseFloat(match[2]),
      chanceQuality: Number.parseFloat(match[3]),
      defSolidity: Number.parseFloat(match[4]),
      injuryRisk: Number.parseFloat(match[5]),
    };
  };
  const formationFor = (key, varName) => {
    const profile = parseFormationProfile(formationNameByKey[key]);
    return {
      ...parseFormationBlock(formationSource, varName, formationStyleByKey[key]),
      defMod: profile.defSolidity,
      ctlMod: profile.possession,
      attMod: profile.chanceCreation * profile.chanceQuality,
      profile,
    };
  };

  const parsePositionWeights = (name) => {
    const regex = new RegExp(`${name}\\s*=\\s*PositionWeights\\{Goalkeeper:\\s*([0-9.]+),\\s*Defense:\\s*([0-9.]+),\\s*Midfield:\\s*([0-9.]+),\\s*Attack:\\s*([0-9.]+)\\}`);
    const match = tuningSource.match(regex);
    if (!match) {
      throw new Error(`Could not parse ${name}`);
    }
    return {
      GK: Number.parseFloat(match[1]),
      DF: Number.parseFloat(match[2]),
      MF: Number.parseFloat(match[3]),
      FW: Number.parseFloat(match[4]),
    };
  };

  const snapshot = {
    generatedAt: sourceMetadata.generatedAt,
    sourceRepo: UPSTREAM_REPO_URL,
    sourceRef: sourceMetadata.sourceRef,
    rules: {
      formations: {
        Box: formationFor('Box', 'slotsBox'),
        Diamond: formationFor('Diamond', 'slotsDiamond'),
        Pyramid: formationFor('Pyramid', 'slotsPyramid'),
        Y: formationFor('Y', 'slotsY'),
      },
      defenseBiasMultiplier: parseFloatFrom(tuningSource, /DefenseBiasMultiplier\s*=\s*([0-9.]+)/, 'DefenseBiasMultiplier'),
      boosts: {
        decayPerApplication: parseFloatFrom(tuningSource, /BoostDecay\s*=\s*([0-9.]+)/, 'BoostDecay'),
        minMultiplier: parseFloatFrom(tuningSource, /BoostMinMultiplier\s*=\s*([0-9.]+)/, 'BoostMinMultiplier'),
      },
      skillCurve: {
        exponent: parseFloatFrom(tuningSource, /SkillCurveExponent\s*=\s*([0-9.]+)/, 'SkillCurveExponent'),
        floor: parseFloatFrom(tuningSource, /SkillCurveFloor\s*=\s*([0-9.]+)/, 'SkillCurveFloor'),
      },
      positionWeights: {
        control: parsePositionWeights('ControlPositionWeights'),
        defense: parsePositionWeights('DefensePositionWeights'),
      },
      tactics: {
        press: {
          low: { label: 'Low', controlFactor: 1.02, injuryFactor: 0.95, fatigueFactor: 1 },
          medium: { label: 'Medium', controlFactor: 1, injuryFactor: 1, fatigueFactor: 1 },
          high: { label: 'High', controlFactor: 0.94, injuryFactor: 1.10, fatigueFactor: 0.94 },
        },
        tempo: {
          slow: { label: 'Slow', chanceFactor: 0.92, qualityFactor: 1.05 },
          normal: { label: 'Normal', chanceFactor: 1, qualityFactor: 1 },
          fast: { label: 'Fast', chanceFactor: 1.10, qualityFactor: 0.96 },
        },
        lineHeight: {
          deep: { label: 'Deep', controlFactor: 1.03, defenseFactor: 1.05 },
          normal: { label: 'Normal', controlFactor: 1, defenseFactor: 1 },
          high: { label: 'High', controlFactor: 0.97, defenseFactor: 0.96 },
        },
      },
      chanceTypes: {
        OpenPlay: { label: 'Open Play', baseWeight: 8, attackBoost: 1, defenseScale: 1, positionWeights: { GK: 2, DF: 10, MF: 20, FW: 70 } },
        Cross: { label: 'Cross', baseWeight: 5, attackBoost: 0.95, defenseScale: 1.05, positionWeights: { GK: 0, DF: 5, MF: 25, FW: 70 } },
        Corner: { label: 'Corner', baseWeight: 3, attackBoost: 0.90, defenseScale: 1.10, positionWeights: { GK: 0, DF: 15, MF: 25, FW: 60 } },
        LongRange: { label: 'Long Range', baseWeight: 3, attackBoost: 0.70, defenseScale: 1.20, positionWeights: { GK: 0, DF: 10, MF: 50, FW: 40 } },
        FreeKick: { label: 'Free Kick', baseWeight: 3, attackBoost: 0.85, defenseScale: 1.10, positionWeights: { GK: 0, DF: 10, MF: 45, FW: 45 } },
        Penalty: { label: 'Penalty', baseWeight: 2, attackBoost: 1.50, defenseScale: 0.50, positionWeights: { GK: 0, DF: 5, MF: 25, FW: 70 } },
        GoalKeeperShot: { label: 'Breakaway', baseWeight: 2, attackBoost: 1.20, defenseScale: 0.70, positionWeights: { GK: 0, DF: 0, MF: 20, FW: 80 } },
      },
      chanceRanges: parseChanceRanges(tuningSource),
    },
  };

  const outPath = path.resolve(process.cwd(), 'src/data/game-rules.snapshot.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote upstream rules snapshot to ${outPath}`);
};

main();
