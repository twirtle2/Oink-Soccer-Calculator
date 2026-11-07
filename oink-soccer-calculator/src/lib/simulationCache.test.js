import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulationCache, pendingSimulationJobs, validSimulationJob } from './simulationCache.js';

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
