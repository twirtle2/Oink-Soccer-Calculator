import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../../public/data/playable-catalog-manifest.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL(`../../public/data/${manifest.catalogFile}`, import.meta.url)));
test('catalog is at least season 18 and includes published eligible positions', () => {
  assert.ok(catalog.season >= 18, `catalog is season ${catalog.season}`);
  if (catalog.season !== 18) return;
  assert.equal(catalog.assets['459490430'].playerName, 'M. Depay');
  assert.ok(catalog.assets['459490430'].positions.includes('FW'));
  assert.equal(catalog.assets['359083389'].playerName, 'A. Armstrong');
  assert.ok(catalog.assets['359083389'].positions.includes('FW'));
});
