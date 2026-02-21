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
