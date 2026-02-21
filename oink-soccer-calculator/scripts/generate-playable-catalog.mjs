#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const UPSTREAM_REPO_URL = process.env.OINK_COMMON_SOURCE_REPO || 'https://github.com/stein-f/oink-soccer-common';

const DEFAULT_COMMON_PATHS = [
  process.env.OINK_COMMON_PATH,
  '/tmp/oink-soccer-common',
  path.resolve(process.cwd(), '../oink-soccer-common'),
].filter(Boolean);

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
    'Could not find oink-soccer-common. Pass the path as: npm run generate:catalog -- /path/to/oink-soccer-common',
  );
};

const parseCsv = (input) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];
  return rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = values[idx] ?? '';
    });
    return record;
  });
};

const toInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const mapPosition = (value) => {
  const pos = (value || '').trim().toUpperCase();
  if (pos === 'GK') return 'GK';
  if (['CB', 'LCB', 'RCB', 'LB', 'LWB', 'RB', 'RWB', 'CDM', 'LDM', 'RDM'].includes(pos)) return 'DF';
  if (['CM', 'LCM', 'RCM', 'CAM', 'LAM', 'RAM', 'LM', 'LW', 'RM', 'RW'].includes(pos)) return 'MF';
  if (['CF', 'LF', 'RF', 'ST', 'LS', 'RS'].includes(pos)) return 'FW';
  return 'FW';
};

const getPreferredPosition = (fifaRow) => {
  const clubPos = mapPosition(fifaRow.club_position);
  if (fifaRow.club_position) {
    return clubPos;
  }
  const firstPlayerPos = (fifaRow.player_positions || '').split(',')[0] || '';
  return mapPosition(firstPlayerPos);
};

const getStats = (fifaRow, pos) => {
  const spd = toInt(fifaRow.pace, toInt(fifaRow.overall, 50));
  const att = toInt(fifaRow.shooting, pos === 'GK' ? 0 : 50);
  const ctl = toInt(fifaRow.passing, 50);
  const def = toInt(fifaRow.defending, 50);
  const gkp = toInt(fifaRow.goalkeeping_handling, pos === 'GK' ? 50 : 0);
  return { SPD: spd, ATT: att, CTL: ctl, DEF: def, GKP: gkp };
};

const getOvr = (stats, pos) => {
  if (pos === 'GK') return Math.round(((stats.GKP * 5) + stats.SPD) / 6);
  if (pos === 'DF') return Math.round(((stats.DEF * 5) + stats.SPD) / 6);
  if (pos === 'MF') return Math.round(((stats.CTL * 4) + stats.SPD) / 5);
  return Math.round(((stats.ATT * 3) + stats.SPD) / 4);
};

const getSourceMetadata = (commonRoot) => {
  try {
    const sourceRef = execSync('git rev-parse HEAD', {
      cwd: commonRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const sourceCommitTime = execSync('git show -s --format=%cI HEAD', {
      cwd: commonRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return {
      sourceRef,
      generatedAt: sourceCommitTime || new Date().toISOString(),
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
  const configPath = path.join(commonRoot, 'cmd/allocation/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const season = config.current_season;

  const assignedPath = path.join(commonRoot, `cmd/allocation/s${season}/out/assigned_players.csv`);
  const fifaPath = path.join(commonRoot, 'cmd/allocation/fifa_players_22.csv');

  const assignedRows = parseCsv(fs.readFileSync(assignedPath, 'utf8'));
  const fifaRows = parseCsv(fs.readFileSync(fifaPath, 'utf8'));
  const fifaById = new Map(fifaRows.map((row) => [row.sofifa_id, row]));

  const assets = {};

  for (const row of assignedRows) {
    const assetKey = row.player_id || '';
    const assetId = assetKey.includes(':') ? assetKey.split(':').pop() : assetKey;
    const fifaPlayerId = row.fifa_player_id;
    const fifaRow = fifaById.get(fifaPlayerId);

    if (!assetId || !fifaRow) {
      continue;
    }

    const pos = getPreferredPosition(fifaRow);
    const stats = getStats(fifaRow, pos);
    const ovr = getOvr(stats, pos);

    assets[assetId] = {
      assetId,
      assetKey,
      assetName: row.asset_name,
      fifaPlayerId,
      playerName: row.player_name || fifaRow.short_name,
      pos,
      stats,
      ovr,
      season,
    };
  }

  const { sourceRef, generatedAt } = getSourceMetadata(commonRoot);
  const catalogFile = `playable-assets.s${season}.json`;

  const output = {
    season,
    generatedAt,
    sourceRepo: UPSTREAM_REPO_URL,
    sourceRef,
    assets,
  };

  const publicDataPath = path.resolve(process.cwd(), 'public/data');
  const outputPath = path.join(publicDataPath, catalogFile);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output));

  const manifestPath = path.join(publicDataPath, 'playable-catalog-manifest.json');
  const manifest = {
    currentSeason: season,
    catalogFile,
    generatedAt,
    sourceRepo: UPSTREAM_REPO_URL,
    sourceRef,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Generated ${Object.keys(assets).length} playable assets to ${outputPath}`);
  console.log(`Updated catalog manifest at ${manifestPath}`);
};

main();
