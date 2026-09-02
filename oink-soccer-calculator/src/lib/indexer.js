const INDEXER_BASE_URL = 'https://mainnet-idx.algonode.cloud';
const PAGE_LIMIT = 1000;
const INDEXER_RETRY_DELAYS_MS = [250, 750];
const inFlightBalancesByAddress = new Map();

const fetchAccountAssetPage = async (address, nextToken = null) => {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (nextToken) {
    params.set('next', nextToken);
  }

  const url = `${INDEXER_BASE_URL}/v2/accounts/${address}/assets?${params.toString()}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return response.json();
    }

    const canRetry = response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    const retryDelay = INDEXER_RETRY_DELAYS_MS[attempt];
    if (!canRetry || retryDelay === undefined) {
      throw new Error(`Indexer request failed (${response.status}) for ${address}`);
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
};

const fetchHeldAssetBalancesUncached = async (address) => {
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

export const fetchHeldAssetBalancesForAddress = (address) => {
  const normalizedAddress = String(address || '').trim();
  if (!normalizedAddress) return Promise.resolve(new Map());

  const inFlight = inFlightBalancesByAddress.get(normalizedAddress);
  if (inFlight) return inFlight;

  const request = fetchHeldAssetBalancesUncached(normalizedAddress)
    .finally(() => {
      if (inFlightBalancesByAddress.get(normalizedAddress) === request) {
        inFlightBalancesByAddress.delete(normalizedAddress);
      }
    });
  inFlightBalancesByAddress.set(normalizedAddress, request);
  return request;
};

export const fetchHeldAssetIdsForAddress = async (address) => {
  const balances = await fetchHeldAssetBalancesForAddress(address);
  return new Set(balances.keys());
};

export const fetchHeldAssetIdsForAddresses = async (addresses) => {
  const deduped = new Set();
  const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
  const perAddress = await Promise.allSettled(uniqueAddresses.map((address) => fetchHeldAssetIdsForAddress(address)));

  for (const result of perAddress) {
    if (result.status !== 'fulfilled') continue;
    for (const id of result.value) {
      deduped.add(id);
    }
  }

  if (uniqueAddresses.length > 0 && perAddress.every((result) => result.status === 'rejected')) {
    throw perAddress[0].reason;
  }

  return deduped;
};

export const fetchHeldAssetBalancesForAddresses = async (addresses) => {
  const deduped = new Map();
  const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
  const perAddress = await Promise.allSettled(uniqueAddresses.map((address) => fetchHeldAssetBalancesForAddress(address)));

  for (const result of perAddress) {
    if (result.status !== 'fulfilled') continue;
    for (const [assetId, amount] of result.value.entries()) {
      deduped.set(assetId, (deduped.get(assetId) || 0) + amount);
    }
  }

  if (uniqueAddresses.length > 0 && perAddress.every((result) => result.status === 'rejected')) {
    throw perAddress[0].reason;
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
