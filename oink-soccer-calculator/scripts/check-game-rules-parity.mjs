#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NUMBER_TOLERANCE = 1e-9;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const compareValues = (actual, expected, currentPath, diffs) => {
  const actualType = Array.isArray(actual) ? 'array' : typeof actual;
  const expectedType = Array.isArray(expected) ? 'array' : typeof expected;

  if (actualType !== expectedType) {
    diffs.push(`${currentPath}: type mismatch (${actualType} vs ${expectedType})`);
    return;
  }

  if (actualType === 'number') {
    if (Math.abs(actual - expected) > NUMBER_TOLERANCE) {
      diffs.push(`${currentPath}: ${actual} !== ${expected}`);
    }
    return;
  }

  if (actualType !== 'object' || actual === null || expected === null) {
    if (actual !== expected) {
      diffs.push(`${currentPath}: ${String(actual)} !== ${String(expected)}`);
    }
    return;
  }

  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of [...keys].sort()) {
    compareValues(actual[key], expected[key], currentPath ? `${currentPath}.${key}` : key, diffs);
  }
};

const main = async () => {
  const projectRoot = process.cwd();
  const snapshotPath = path.resolve(projectRoot, 'src/data/game-rules.snapshot.json');
  const gameRulesPath = path.resolve(projectRoot, 'src/lib/gameRules.js');

  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot file not found: ${snapshotPath}`);
  }

  const snapshot = readJson(snapshotPath);
  const gameRulesModule = await import(pathToFileURL(gameRulesPath).href);
  const localRules = gameRulesModule.getRulesParityView();
  const upstreamRules = snapshot.rules;

  const diffs = [];
  compareValues(localRules, upstreamRules, 'rules', diffs);

  if (diffs.length > 0) {
    console.error('Game rule parity check failed:');
    for (const diff of diffs.slice(0, 50)) {
      console.error(`- ${diff}`);
    }
    if (diffs.length > 50) {
      console.error(`...and ${diffs.length - 50} more differences`);
    }
    process.exit(1);
  }

  console.log('Game rule parity check passed.');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

