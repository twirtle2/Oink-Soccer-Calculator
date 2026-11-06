import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchHeldAssetBalancesForAddress,
  fetchHeldAssetBalancesForAddresses,
  fetchHeldAssetIdsForAddresses,
} from './indexer.js';

const withMockedFetch = async (handler, run) => {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
  }
};

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

test('multi-account asset scans keep successful accounts when one fails', async () => {
  await withMockedFetch(async (url) => {
    if (String(url).includes('/GOOD/')) {
      return okResponse({
        assets: [{ 'asset-id': 123, amount: 1 }],
      });
    }
    throw new Error('temporary indexer failure');
  }, async () => {
    const ids = await fetchHeldAssetIdsForAddresses(['GOOD', 'BAD']);
    const balances = await fetchHeldAssetBalancesForAddresses(['GOOD', 'BAD']);
    assert.deepEqual([...ids], ['123']);
    assert.equal(balances.get('123'), 1);
  });
});

test('concurrent id and balance scans share one account request', async () => {
  let requestCount = 0;
  await withMockedFetch(async () => {
    requestCount += 1;
    return okResponse({
      assets: [{ 'asset-id': 456, amount: 2 }],
    });
  }, async () => {
    const [ids, balances] = await Promise.all([
      fetchHeldAssetIdsForAddresses(['SHARED']),
      fetchHeldAssetBalancesForAddress('SHARED'),
    ]);
    assert.deepEqual([...ids], ['456']);
    assert.equal(balances.get('456'), 2);
    assert.equal(requestCount, 1);
  });
});
