import test from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';

import { resolvePlayerImage } from './assetImages.js';

const INDEXER = 'https://mainnet-idx.algonode.cloud';
const PERA = 'https://mainnet.api.perawallet.app/v1/public/assets/';
const PINATA = 'https://gateway.pinata.cloud/ipfs/';
const IPFSIO = 'https://ipfs.io/ipfs/';
const LOST_PIGS_CDN = 'https://cdn.thelostpigs.com/';
const YBG_GATEWAY = 'https://ybg.mypinata.cloud/ipfs/';

const reserve = () => algosdk.generateAccount().addr.toString();
const templateUrl = () => 'template-ipfs://{ipfscid:1:raw:reserve:sha2-256}';

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const ok = () => new Response(null, { status: 200 });
const down = () => new Response('bad gateway', { status: 502 });

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const uri = String(url);
    const route = routes.find((r) => r.match(uri));
    if (!route) return new Response('not found', { status: 404 });
    return route.respond(uri, options);
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('uses Pera resolved media without fetching raw IPFS metadata', async () => {
  const restore = mockFetch([
    { match: (u) => u.startsWith(PERA), respond: () => json({
      unit_name: 'BFER0090',
      collectible: {
        metadata: { image: 'ipfs://raw-cid' },
        media: [{ type: 'image', url: 'https://ipfs-pera.algonode.dev/ipfs/resolved-cid' }],
      },
    }) },
  ]);

  const url = await resolvePlayerImage({ assetId: '90000' });
  restore();

  assert.equal(url, 'https://ipfs-pera.algonode.dev/ipfs/resolved-cid');
});

test('falls back to a healthy IPFS gateway for BFER/SCHIZO metadata', async () => {
  const restore = mockFetch([
    { match: (u) => u.startsWith(INDEXER), respond: () => json({
      asset: { params: { url: templateUrl(), reserve: reserve() } },
    }) },
    { match: (u) => u.startsWith(PINATA), respond: () => down() },
    { match: (u) => u.startsWith(IPFSIO), respond: () => json({
      image: 'ipfs://bafybeibferimg/portrait.png',
    }) },
  ]);

  const url = await resolvePlayerImage({ assetId: '90001' });
  restore();

  assert.equal(url, `${IPFSIO}bafybeibferimg/portrait.png`);
});

test('routes Lost Bots (BOT) static image through the collection CDN', async () => {
  const restore = mockFetch([
    { match: (u) => u.startsWith(INDEXER), respond: () => json({
      asset: { params: { 'unit-name': 'BOT1425', url: templateUrl(), reserve: reserve() } },
    }) },
    { match: (u) => u.startsWith(PINATA), respond: () => json({
      image: 'ipfs://bafybeianimated',
      properties: { image_static: 'ipfs://bafkreid6static' },
    }) },
  ]);

  const url = await resolvePlayerImage({ assetId: '90002' });
  restore();

  assert.equal(url, `${LOST_PIGS_CDN}bafkreid6static`);
});

test('routes YBG artwork through the game gateway with origin-scoped caching', async () => {
  globalThis.window = { location: { hostname: 'localhost' } };
  const restore = mockFetch([
    { match: (u) => u.startsWith(PERA), respond: () => json({
      unit_name: 'YBG42',
      collectible: {
        metadata: { image: 'ipfs://bafkreih3vl6ffcsub27erb65btyikmv66cgbxlv7reytgjusvjadujqd6u' },
      },
    }) },
    { match: (u) => u.startsWith(YBG_GATEWAY), respond: () => ok() },
  ]);

  try {
    const url = await resolvePlayerImage({ assetId: '90004' });
    assert.equal(url, `${YBG_GATEWAY}bafkreih3vl6ffcsub27erb65btyikmv66cgbxlv7reytgjusvjadujqd6u?xo=localhost`);
  } finally {
    restore();
    delete globalThis.window;
  }
});

test('falls back from denied YBG game gateway to a healthy generic gateway', async () => {
  globalThis.window = { location: { hostname: 'localhost' } };
  const requests = [];
  const restore = mockFetch([
    { match: (u) => u.startsWith(PERA), respond: (u) => {
      requests.push(u);
      return json({
      unit_name: 'YBG42',
      collectible: {
        metadata: { image: 'ipfs://bafkreih3vl6ffcsub27erb65btyikmv66cgbxlv7reytgjusvjadujqd6u' },
      }
      });
    } },
    { match: (u) => u.startsWith(YBG_GATEWAY), respond: (u) => {
      requests.push(u);
      return down();
    } },
    { match: (u) => u.startsWith(PINATA), respond: (u) => {
      requests.push(u);
      return ok();
    } },
  ]);

  try {
    const url = await resolvePlayerImage({ assetId: '90005' });
    assert.equal(url, `${PINATA}bafkreih3vl6ffcsub27erb65btyikmv66cgbxlv7reytgjusvjadujqd6u`);
  } finally {
    restore();
    delete globalThis.window;
  }
});

test('does not permanently cache a transient resolution failure', async () => {
  let healthy = false;
  const restore = mockFetch([
    { match: (u) => u.startsWith(INDEXER), respond: () => json({
      asset: { params: { url: templateUrl(), reserve: reserve() } },
    }) },
    { match: (u) => u.startsWith(PINATA), respond: () => (healthy ? json({
      image: 'ipfs://bafybeiretried/x.png',
    }) : down()) },
    { match: (u) => u.startsWith(IPFSIO), respond: () => (healthy ? ok() : down()) },
  ]);

  const first = await resolvePlayerImage({ assetId: '90003' });
  assert.equal(first, null);

  healthy = true;
  const second = await resolvePlayerImage({ assetId: '90003' });
  restore();

  assert.equal(second, `${PINATA}bafybeiretried/x.png`);
});
