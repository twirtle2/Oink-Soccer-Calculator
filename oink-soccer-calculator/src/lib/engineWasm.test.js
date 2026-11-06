import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

test('bundled Go WebAssembly engine runs deterministic match scenarios', async () => {
  globalThis.crypto ||= webcrypto;
  await import('../../public/engine/wasm_exec.js');
  const go = new globalThis.Go();
  const bytes = await readFile(new URL('../../public/engine/oink-engine.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  void go.run(instance);
  const positions = ['Goalkeeper', 'Defense', 'Defense', 'Midfield', 'Attack'];
  const players = positions.map((pos, i) => ({ id: String(i), position: pos, attributes: { position: pos, positions: [pos], goalkeeper_rating: 75, defense_rating: 75, speed_rating: 75, control_rating: 75, attack_rating: 75 } }));
  const lineup = { team: { formation: 'The Pyramid' }, players };
  const request = { home: lineup, away: lineup, myHome: true, trials: 100, seed: 1729, scenarios: [{ key: 'baseline', boosts: [] }] };
  const a = JSON.parse(globalThis.runOinkMatches(JSON.stringify(request)));
  const b = JSON.parse(globalThis.runOinkMatches(JSON.stringify(request)));
  assert.deepEqual(a, b);
  assert.equal(a.results[0].wins + a.results[0].draws + a.results[0].losses, 100);
});
