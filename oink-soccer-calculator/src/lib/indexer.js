const INDEXER_BASE_URL = 'https://mainnet-idx.algonode.cloud';
const PAGE_LIMIT = 1000;

const fetchAccountAssetPage = async (address, nextToken = null) => {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (nextToken) {
    params.set('next', nextToken);
  }

  const response = await fetch(`${INDEXER_BASE_URL}/v2/accounts/${address}/assets?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Indexer request failed (${response.status}) for ${address}`);
  }
  return response.json();
};

export const fetchHeldAssetIdsForAddress = async (address) => {
  const heldIds = new Set();
  let nextToken = null;

  do {
    const payload = await fetchAccountAssetPage(address, nextToken);
    const assets = payload?.assets || [];
    for (const asset of assets) {
      if ((asset.amount || 0) > 0 && asset['asset-id']) {
        heldIds.add(String(asset['asset-id']));
      }
    }
    nextToken = payload['next-token'] || null;
  } while (nextToken);

  return heldIds;
};

export const fetchHeldAssetBalancesForAddress = async (address) => {
  const balances = new Map();
  let nextToken = null;

  do {
    const payload = await fetchAccountAssetPage(address, nextToken);
    const assets = payload?.assets || [];
    for (const asset of assets) {
      const amount = Number(asset.amount || 0);
      if (amount > 0 && asset['asset-id']) {
        const assetId = String(asset['asset-id']);
        balances.set(assetId, (balances.get(assetId) || 0) + amount);
      }
    }
    nextToken = payload['next-token'] || null;
  } while (nextToken);

  return balances;
};

export const fetchHeldAssetIdsForAddresses = async (addresses) => {
  const deduped = new Set();
  const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
  const perAddress = await Promise.all(uniqueAddresses.map((address) => fetchHeldAssetIdsForAddress(address)));

  for (const set of perAddress) {
    for (const id of set) {
      deduped.add(id);
    }
  }

  return deduped;
};

export const fetchHeldAssetBalancesForAddresses = async (addresses) => {
  const deduped = new Map();
  const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
  const perAddress = await Promise.all(uniqueAddresses.map((address) => fetchHeldAssetBalancesForAddress(address)));

  for (const balances of perAddress) {
    for (const [assetId, amount] of balances.entries()) {
      deduped.set(assetId, (deduped.get(assetId) || 0) + amount);
    }
  }

  return deduped;
};

export const fetchAssetParams = async (assetId) => {
  const response = await fetch(`${INDEXER_BASE_URL}/v2/assets/${encodeURIComponent(String(assetId))}`);
  if (!response.ok) {
    throw new Error(`Asset lookup failed (${response.status}) for ${assetId}`);
  }
  const payload = await response.json();
  return payload?.asset?.params || null;
};

export const fetchAssetParamsForIds = async (assetIds) => {
  const uniqueIds = Array.from(new Set((assetIds || []).map(String).filter(Boolean)));
  const entries = await Promise.all(
    uniqueIds.map(async (assetId) => {
      try {
        return [assetId, await fetchAssetParams(assetId)];
      } catch (_) {
        return [assetId, null];
      }
    }),
  );

  return Object.fromEntries(entries);
};
