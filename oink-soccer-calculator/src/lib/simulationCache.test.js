import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulationCache, pendingSimulationJobs, validSimulationJob, setupSimulationKey } from './simulationCache.js';

test('returning to a fixture resumes only its unfinished simulations', () => {
  const cache = createSimulationCache(2);
  const jobs = [{ key: '0' }, { key: '1' }, { key: '2' }];
  const progress = { screening: {}, finalists: {}, suggestions: null };
  cache.set('fixture-a:lineup-a', progress);
  progress.screening['0'] = { key: '0' };
  cache.set('fixture-b:lineup-a', { screening: {} });
  assert.deepEqual(pendingSimulationJobs(jobs, cache.get('fixture-a:lineup-a').screening), [{ key: '1' }, { key: '2' }]);
  assert.equal(cache.get('fixture-a:lineup-b'), undefined);
  cache.set('fixture-c:lineup-a', {});
  assert.equal(cache.get('fixture-b:lineup-a'), undefined);
});

test('failed and incomplete results cannot be cached as completed work', () => {
  const row = { trials: 100, wins: 20, draws: 30, losses: 50, goalsFor: 80, goalsAgainst: 120 };
  assert.ok(validSimulationJob({ results: [row] }));
  assert.ok(!validSimulationJob({ error: 'failed', results: [row] }));
  assert.ok(!validSimulationJob({ results: [{ ...row, losses: 1 }] }));
  assert.ok(!validSimulationJob({ results: [{ ...row, goalsFor: undefined }] }));
});

test('completed results survive a reload in the same browser tab', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const options = { storage, storageKey: 'test', shouldPersist: (entry) => Boolean(entry.suggestions) };
  const cache = createSimulationCache(2, options);
  cache.set('match-a', { suggestions: { Pyramid: { win: 15 } } }, { persist: true });
  const afterReload = createSimulationCache(2, options);
  assert.deepEqual(afterReload.get('match-a').suggestions, { Pyramid: { win: 15 } });
});


test('identical matchups reuse a key but lineup, opponent, venue and boost changes do not', () => {
  const input = { squad: [{ id: 'one', stats: { ATT: 80 } }], opponent: { players: [{ id: 'opp' }] }, myHome: true, boosts: [] };
  const key = setupSimulationKey(input);
  assert.equal(setupSimulationKey({ ...input }), key);
  assert.notEqual(setupSimulationKey({ ...input, squad: [{ id: 'one', stats: { ATT: 81 } }] }), key);
  assert.notEqual(setupSimulationKey({ ...input, opponent: { players: [{ id: 'other' }] } }), key);
  assert.notEqual(setupSimulationKey({ ...input, myHome: false }), key);
  assert.notEqual(setupSimulationKey({ ...input, boosts: [{ min_boost: 1.1 }] }), key);
});

test('storage failures do not break the in-memory cache', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const cache = createSimulationCache(2, { storage, storageKey: 'test' });
  cache.set('match', { suggestions: {} }, { persist: true });
  assert.deepEqual(cache.get('match'), { suggestions: {} });
});
