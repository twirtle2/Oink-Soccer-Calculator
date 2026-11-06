import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

test('worker loads bundled engine and compares current and item scenarios', async () => {
  globalThis.crypto ||= webcrypto;
  globalThis.self = globalThis;
  globalThis.fetch = async (url) => {
    const data = await readFile(new URL(url));
    return { ok: true, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  let response;
  globalThis.postMessage = (value) => { response = value; };
  await import('./simulationWorker.js');
  const positions = ['Goalkeeper', 'Defense', 'Defense', 'Midfield', 'Attack'];
  const players = positions.map((pos, i) => ({ id: String(i), position: pos, attributes: { position: pos, positions: [pos], goalkeeper_rating: 75, defense_rating: 75, speed_rating: 75, control_rating: 75, attack_rating: 75 } }));
  const lineup = { team: { formation: 'The Pyramid' }, players };
  const request = { home: lineup, away: lineup, myHome: true, trials: 100, seed: 1729, scenarios: [{ key: 'baseline', boosts: [] }, { key: 'GoldenTruffle', boosts: [{ boost_type: 'Team Boost', min_boost: 1.05, max_boost: 1.05 }] }] };
  await globalThis.onmessage({ data: { baseUrl: new URL('../../public/', import.meta.url).href, request } });
  assert.equal(response?.error, undefined);
  assert.deepEqual(response.results.map((result) => result.key), ['baseline', 'GoldenTruffle']);
  assert.equal(response.results[1].wins + response.results[1].draws + response.results[1].losses, 100);
});


test('worker runs a batch and reports individual failures without discarding successful jobs', async () => {
  const messages = [];
  globalThis.postMessage = (value) => messages.push(value);
  const positions = ['Goalkeeper', 'Defense', 'Defense', 'Midfield', 'Attack'];
  const players = positions.map((position, i) => ({ id: String(i), position, attributes: { position, positions: [position], goalkeeper_rating: 75, defense_rating: 75, speed_rating: 75, control_rating: 75, attack_rating: 75 } }));
  const lineup = { team: { formation: 'The Pyramid' }, players };
  const request = { home: lineup, away: lineup, myHome: true, trials: 20, seed: 1729, scenarios: [{ key: 'baseline', boosts: [] }] };
  await globalThis.onmessage({ data: { baseUrl: new URL('../../public/', import.meta.url).href, jobs: [{ key: 'good', request }, { key: 'bad', request: { ...request, trials: 0 } }] } });
  const batch = messages.at(-1).batchResults;
  assert.equal(batch[0].results[0].trials, 20);
  assert.match(batch[1].error, /invalid simulation count/);
  assert.deepEqual(messages.slice(0, 2).map((m) => m.progress), [1, 2]);
});

test('season batch item scenarios agree with a standalone selected-match simulation', async () => {
  const messages = [];
  globalThis.postMessage = (value) => messages.push(value);
  const positions = ['Goalkeeper', 'Defense', 'Defense', 'Midfield', 'Attack'];
  const players = positions.map((position, i) => ({ id: String(i), position, attributes: { position, positions: [position], goalkeeper_rating: 75, defense_rating: 75, speed_rating: 75, control_rating: 75, attack_rating: 75 } }));
  const lineup = { team: { formation: 'The Pyramid' }, players };
  const scenarios = [{ key: 'baseline', boosts: [] }, { key: 'GoldenTruffle:100', boosts: [{ boost_type: 'Team Boost', min_boost: 1.05, max_boost: 1.05 }] }];
  const request = { home: lineup, away: lineup, myHome: false, trials: 200, seed: 1729, scenarios };
  const baseUrl = new URL('../../public/', import.meta.url).href;
  await globalThis.onmessage({ data: { baseUrl, request } });
  const standalone = messages.at(-1).results;
  messages.length = 0;
  await globalThis.onmessage({ data: { baseUrl, jobs: [{ key: 'own:fixture:0', request }] } });
  assert.deepEqual(messages.at(-1).batchResults[0].results, standalone);
  for (const row of standalone) assert.equal(row.wins + row.draws + row.losses, 200);
});
