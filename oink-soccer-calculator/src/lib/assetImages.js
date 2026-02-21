const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const cache = new Map();

const toHttpUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('ipfs://')) return `${IPFS_GATEWAY}${raw.replace('ipfs://', '')}`;
  if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
  return null;
};

const isDirectImageUrl = (url) => /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(url);

const resolveFromAssetParams = async (assetId, signal) => {
  const response = await fetch(`${INDEXER_BASE}/v2/assets/${assetId}`, { signal });
  if (!response.ok) return null;
  const payload = await response.json();
  const params = payload?.asset?.params;
  if (!params) return null;

  const unitImage = toHttpUrl(params?.['unit-name-image-url']);
  if (unitImage) return unitImage;

  const url = toHttpUrl(params.url);
  if (!url) return null;
  if (isDirectImageUrl(url)) return url;

  if (url.endsWith('.json')) {
    const metadataResponse = await fetch(url, { signal });
    if (!metadataResponse.ok) return null;
    const metadata = await metadataResponse.json();
    const metadataImage = toHttpUrl(metadata?.image || metadata?.image_url || metadata?.properties?.image);
    if (metadataImage) return metadataImage;
  }

  return null;
};

export const resolvePlayerImage = async (player, signal) => {
  if (player?.imageUrl) return player.imageUrl;
  const assetId = player?.assetId;
  if (!assetId) return null;

  const cacheKey = String(assetId);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const resolved = await resolveFromAssetParams(cacheKey, signal);
    cache.set(cacheKey, resolved || null);
    return resolved || null;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
};

