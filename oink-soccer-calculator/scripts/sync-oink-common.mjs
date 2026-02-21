#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const DEFAULT_REPO_URL = process.env.OINK_COMMON_SOURCE_REPO || 'https://github.com/stein-f/oink-soccer-common.git';
const DEFAULT_REF = process.env.OINK_COMMON_REF || 'main';
const DEFAULT_COMMON_PATH = process.env.OINK_COMMON_PATH || '/tmp/oink-soccer-common';

const projectRoot = process.cwd();

const parseArgs = (argv) => {
  const args = { check: false, ref: DEFAULT_REF, repo: DEFAULT_REPO_URL, commonPath: DEFAULT_COMMON_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') {
      args.check = true;
      continue;
    }
    if (token === '--ref') {
      args.ref = argv[i + 1] || args.ref;
      i += 1;
      continue;
    }
    if (token === '--repo') {
      args.repo = argv[i + 1] || args.repo;
      i += 1;
      continue;
    }
    if (token === '--path') {
      args.commonPath = argv[i + 1] || args.commonPath;
      i += 1;
      continue;
    }
  }
  return args;
};

const run = (command, options = {}) => {
  execSync(command, {
    stdio: 'inherit',
    ...options,
  });
};

const ensureRepo = ({ repo, ref, commonPath }) => {
  const commonRoot = path.resolve(commonPath);
  const gitDir = path.join(commonRoot, '.git');
  if (!fs.existsSync(commonRoot) || !fs.existsSync(gitDir)) {
    fs.rmSync(commonRoot, { recursive: true, force: true });
    run(`git clone --depth 1 --branch ${ref} ${repo} ${commonRoot}`);
    return commonRoot;
  }

  run(`git -C ${commonRoot} fetch --depth 1 origin ${ref}`);
  run(`git -C ${commonRoot} checkout --detach FETCH_HEAD`);
  return commonRoot;
};

const runNodeScript = (scriptRelPath, args = []) => {
  const scriptPath = path.join(projectRoot, scriptRelPath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Failed running ${scriptRelPath}`);
  }
};

const pruneStaleCatalogs = () => {
  const dataDir = path.resolve(projectRoot, 'public/data');
  const manifestPath = path.join(dataDir, 'playable-catalog-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const activeCatalog = manifest.catalogFile;
  if (!activeCatalog) {
    return;
  }

  const entries = fs.readdirSync(dataDir);
  for (const entry of entries) {
    if (!/^playable-assets\.s\d+\.json$/.test(entry)) {
      continue;
    }
    if (entry === activeCatalog) {
      continue;
    }
    fs.rmSync(path.join(dataDir, entry), { force: true });
    console.log(`Removed stale catalog ${entry}`);
  }
};

const getDriftOutput = () =>
  execSync('git status --porcelain -- public/data src/data/game-rules.snapshot.json', {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();

const printDiff = () => {
  try {
    run('git --no-pager diff -- public/data src/data/game-rules.snapshot.json', { cwd: projectRoot });
  } catch {
    // Ignore diff rendering failures.
  }
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const commonRoot = ensureRepo(args);

  runNodeScript('scripts/generate-playable-catalog.mjs', [commonRoot]);
  pruneStaleCatalogs();
  runNodeScript('scripts/generate-game-rules-snapshot.mjs', [commonRoot]);
  runNodeScript('scripts/check-game-rules-parity.mjs');

  if (args.check) {
    const drift = getDriftOutput();
    if (drift) {
      console.error('Upstream drift detected:');
      console.error(drift);
      printDiff();
      process.exit(1);
    }
    console.log('No upstream drift detected.');
  }
};

main();

