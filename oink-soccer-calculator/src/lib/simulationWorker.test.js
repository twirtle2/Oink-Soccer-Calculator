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
