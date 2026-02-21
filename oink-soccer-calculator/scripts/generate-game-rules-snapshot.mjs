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
  const regex = new RegExp(`var\\s+${varName}\\s*=\\s*FormationConfig\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
  const match = source.match(regex);
  if (!match) {
    throw new Error(`Could not parse formation block for ${varName}`);
  }
  const block = match[1];
  const slotsBlockMatch = block.match(/Slots:\s*map\[uint64\]PlayerPosition\s*\{([\s\S]*?)\},/m);
  if (!slotsBlockMatch) {
    throw new Error(`Could not parse slots for ${varName}`);
  }

  return {
    style,
    defMod: parseFloatFrom(block, /DefenseModifier:\s*([0-9.]+)/, `${varName}.DefenseModifier`),
    ctlMod: parseFloatFrom(block, /ControlModifier:\s*([0-9.]+)/, `${varName}.ControlModifier`),
    attMod: parseFloatFrom(block, /AttackModifier:\s*([0-9.]+)/, `${varName}.AttackModifier`),
    structure: parseStructure(slotsBlockMatch[1]),
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
  const formationSource = readFile(commonRoot, 'formation.go');
  const teamSource = readFile(commonRoot, 'team.go');
  const boostsSource = readFile(commonRoot, 'boosts.go');
  const gameSource = readFile(commonRoot, 'game.go');
  const sourceMetadata = getSourceMetadata(commonRoot);

  const snapshot = {
    generatedAt: sourceMetadata.generatedAt,
    sourceRepo: UPSTREAM_REPO_URL,
    sourceRef: sourceMetadata.sourceRef,
    rules: {
      formations: {
        Box: parseFormationBlock(formationSource, 'TheBoxFormation', 'BAL'),
        Diamond: parseFormationBlock(formationSource, 'TheDiamondFormation', 'BAL'),
        Pyramid: parseFormationBlock(formationSource, 'ThePyramidFormation', 'DEF'),
        Y: parseFormationBlock(formationSource, 'TheYFormation', 'ATT'),
      },
      defenseBiasMultiplier: parseFloatFrom(teamSource, /const\s+defenseBiasMultiplier\s*=\s*([0-9.]+)/, 'defenseBiasMultiplier'),
      boosts: {
        decayPerApplication: parseFloatFrom(boostsSource, /DRDecayPerApplication\s*=\s*([0-9.]+)/, 'DRDecayPerApplication'),
        minMultiplier: parseFloatFrom(boostsSource, /DRMinMultiplier\s*=\s*([0-9.]+)/, 'DRMinMultiplier'),
      },
      chanceRanges: parseChanceRanges(gameSource),
    },
  };

  const outPath = path.resolve(process.cwd(), 'src/data/game-rules.snapshot.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote upstream rules snapshot to ${outPath}`);
};

main();
