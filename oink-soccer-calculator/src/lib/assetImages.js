import algosdk from 'algosdk';

const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud';
const PERA_ASSET_BASE = 'https://mainnet.api.perawallet.app/v1/public/assets';
const REQUEST_TIMEOUT_MS = 8000;

// Ordered IPFS gateways. The first is the public gateway that serves the
// Best Frens/SCHIZO metadata and images; the rest are fallbacks when it is
// unreachable. The custom oink.club gateway is deliberately not used because
// it returns 401 outside the club.
const IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
];

// The Lost Pigs game serves each BOT asset's static image from its own CDN.
const LOST_PIGS_CDN = 'https://cdn.thelostpigs.com/';
// YBG uses the game's dedicated Pinata gateway. The game appends an
// origin-scoped cache parameter and loads images with anonymous CORS.
const YBG_GATEWAY = 'https://ybg.mypinata.cloud/ipfs/';

// Resolved successes are cached permanently. Transient failures are intentionally
// NOT cached, so a flaky gateway does not permanently blank an NFT for the tab.
const cache = new Map();

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ARC19_TEMPLATE_REGEX = /\{ipfscid:(\d+):([a-z0-9-]+):([a-z0-9-]+):([a-z0-9-]+)\}/i;

const toBase58 = (bytes) => {
  if (!bytes?.length) return '';
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroCount = 0;
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) {
    leadingZeroCount += 1;
  }
  return `${'1'.repeat(leadingZeroCount)}${digits.reverse().map((d) => BASE58_ALPHABET[d]).join('')}`;
};

const toBase32 = (bytes) => {
  if (!bytes?.length) return '';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
};

const toVarInt = (value) => {
  const out = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Uint8Array.from(out);
};

const concatBytes = (...arrays) => {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
};

const decodeArc19IpfsTemplate = (template, reserveAddress) => {
  const match = template?.match(ARC19_TEMPLATE_REGEX);
  if (!match || !reserveAddress) return null;

  const version = Number.parseInt(match[1], 10);
  const codec = match[2];
  const field = match[3];
  const hashType = match[4];
  if (!Number.isFinite(version) || field !== 'reserve' || hashType !== 'sha2-256') {
    return null;
  }

  const codecCode = codec === 'raw' ? 0x55 : codec === 'dag-pb' ? 0x70 : null;
  if (codecCode === null) return null;

  let digest;
  try {
    digest = algosdk.decodeAddress(reserveAddress).publicKey;
  } catch {
    return null;
  }
  const multihash = concatBytes(Uint8Array.from([0x12, 0x20]), digest);

  let cid;
  if (version === 0) {
    if (codec !== 'dag-pb') return null;
    cid = toBase58(multihash);
  } else if (version === 1) {
    const cidBytes = concatBytes(toVarInt(1), toVarInt(codecCode), multihash);
    cid = `b${toBase32(cidBytes)}`;
  } else {
    return null;
  }

  return template.replace(ARC19_TEMPLATE_REGEX, cid);
};

const stripUrlFragment = (url) => {
  if (!url) return null;
  const index = url.indexOf('#');
  if (index === -1) return url;
  return url.slice(0, index);
};

const extractIpfsPath = (url) => {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i);
  return match ? match[1] : null;
};

const buildCandidateUrls = (raw, reserveAddress) => {
  if (typeof raw !== 'string') return [];
  if (raw.startsWith('template-ipfs://')) {
    const ipfsTemplate = decodeArc19IpfsTemplate(raw, reserveAddress);
    if (!ipfsTemplate) return [];
    return IPFS_GATEWAYS.map((gateway) => `${gateway}${ipfsTemplate.replace('template-ipfs://', '')}`);
  }
  if (raw.startsWith('ipfs://')) {
    const ipfsPath = raw.replace('ipfs://', '');
    return IPFS_GATEWAYS.map((gateway) => `${gateway}${ipfsPath}`);
  }
  if (raw.startsWith('https://') || raw.startsWith('http://')) {
    const ipfsPath = extractIpfsPath(raw);
    if (ipfsPath) return IPFS_GATEWAYS.map((gateway) => `${gateway}${ipfsPath}`);
    return [raw];
  }
  return [];
};

const gatewayForUrl = (url) => (
  IPFS_GATEWAYS.find((gateway) => String(url || '').startsWith(gateway)) || IPFS_GATEWAYS[0]
);

// The Lost Pigs game serves each BOT asset's static image straight from the
// collection CDN (`cdn.thelostpigs.com/<cid>`) rather than a generic gateway.
const detectCollection = (unitName) => (
  (() => {
    const normalized = String(unitName || '').trim().toUpperCase();
    if (normalized.startsWith('BOT')) return 'lostPigs';
    if (normalized.startsWith('YBG')) return 'ybg';
    return 'ipfs';
  })()
);

const withOriginScopedCache = (url) => {
  if (!url?.startsWith(YBG_GATEWAY)) return url;
  if (url.includes('xo=')) return url;
  const hostname = globalThis.window?.location?.hostname;
  if (!hostname) return url;
  return `${url}${url.includes('?') ? '&' : '?'}xo=${encodeURIComponent(hostname)}`;
};

export const crossOriginForImageUrl = (url) => (
  url?.startsWith(YBG_GATEWAY) ? 'anonymous' : undefined
);

const imageIpfsPath = (value) => {
  const clean = stripUrlFragment(value);
  if (!clean) return null;
  if (clean.startsWith('ipfs://')) return clean.replace('ipfs://', '');
  if (clean.startsWith('template-ipfs://')) return null;
  if (clean.startsWith('https://') || clean.startsWith('http://')) return extractIpfsPath(clean);
  return null;
};

const resolveFinalImage = (rawImage, gateway, collection) => {
  if (typeof rawImage !== 'string' || !rawImage) return null;
  const clean = stripUrlFragment(rawImage);
  if (!clean) return null;
  if (clean.startsWith('template-ipfs://')) return null;

  if (collection === 'lostPigs' || collection === 'ybg') {
    const ipfsPath = imageIpfsPath(clean);
    if (ipfsPath && collection === 'ybg') {
      return withOriginScopedCache(`${YBG_GATEWAY}${ipfsPath}`);
    }
    if (ipfsPath) return `${LOST_PIGS_CDN}${ipfsPath}`;
    if (clean.startsWith('https://') || clean.startsWith('http://')) return clean;
    return null;
  }

  if (clean.startsWith('ipfs://')) {
    return gateway ? `${gateway}${clean.replace('ipfs://', '')}` : null;
  }
  if (clean.startsWith('https://') || clean.startsWith('http://')) {
    const ipfsPath = extractIpfsPath(clean);
    if (ipfsPath && gateway) return `${gateway}${ipfsPath}`;
    return clean;
  }
  return null;
};

const isDirectImageUrl = (url) => /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(url);

const parseImageFromMetadata = (metadata, collection) => {
  if (collection === 'lostPigs') {
    // Match the game by preferring the lighter static variant when present.
    return metadata?.properties?.image_static
      || metadata?.image
      || metadata?.image_url
      || metadata?.properties?.image
      || metadata?.properties?.image_url
      || null;
  }
  return metadata?.image
    || metadata?.image_url
    || metadata?.properties?.image
    || metadata?.properties?.image_url
    || null;
};

export const getGenericIpfsFallback = (url) => {
  if (!url?.startsWith(YBG_GATEWAY)) return url;
  const path = url.slice(YBG_GATEWAY.length).split('?')[0];
  return `${IPFS_GATEWAYS[0]}${path}`;
};

const fetchWithTimeout = async (url, signal) => {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromParent);
  }
};

const resolveFromPera = async (assetId, signal) => {
  try {
    const response = await fetchWithTimeout(`${PERA_ASSET_BASE}/${assetId}/`, signal);
    if (!response.ok) return null;
    const payload = await response.json();
    const collectible = payload?.collectible;
    if (!collectible) return null;

    const collection = detectCollection(payload?.unit_name);
    const metadataImage = parseImageFromMetadata(collectible.metadata, collection);
    if (collection === 'lostPigs' && metadataImage) {
      return resolveFinalImage(metadataImage, IPFS_GATEWAYS[0], collection);
    }

    const mediaUrl = collectible.media?.find((media) => media?.type === 'image' && media?.url)?.url;
    if (mediaUrl) {
      return collection === 'ybg'
        ? withOriginScopedCache(mediaUrl.startsWith(YBG_GATEWAY)
          ? mediaUrl
          : resolveFinalImage(mediaUrl, YBG_GATEWAY, 'ybg') || mediaUrl)
        : stripUrlFragment(mediaUrl);
    }
    return resolveFinalImage(metadataImage, IPFS_GATEWAYS[0], collection);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

const firstReachableUrl = async (urls, signal) => {
  for (const url of urls) {
    if (!url) continue;
    let response;
    try {
      response = await fetchWithTimeout(url, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }
    if (response.ok) return url;
  }
  return null;
};

const isReachable = async (url, signal) => {
  if (!url) return false;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return response.ok;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromParent);
  }
};

const fetchImageFromMetadataCandidate = async (metadataUrl, signal, collection) => {
  let response;
  try {
    response = await fetchWithTimeout(metadataUrl, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'fail' };
  }
  if (!response.ok) return { status: 'fail' };

  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('image/')) {
    return { status: 'ok', isImage: true, image: metadataUrl };
  }

  if (contentType.includes('application/json') || contentType.includes('text/json') || metadataUrl.endsWith('.json')) {
    let metadata;
    try {
      metadata = await response.json();
    } catch {
      return { status: 'fail' };
    }
    return { status: 'ok', isImage: false, image: parseImageFromMetadata(metadata, collection) };
  }

  return { status: 'fail' };
};

const resolveFromAssetParams = async (assetId, signal) => {
  const response = await fetch(`${INDEXER_BASE}/v2/assets/${assetId}`, { signal });
  if (!response.ok) return null;
  const payload = await response.json();
  const params = payload?.asset?.params;
  if (!params) return null;

  const collection = detectCollection(params?.['unit-name']);
  const reserve = params?.reserve;

  const unitImage = params?.['unit-name-image-url'];
  if (unitImage) {
    const finalUnit = resolveFinalImage(
      stripUrlFragment(await firstReachableUrl(buildCandidateUrls(unitImage, reserve), signal)),
      undefined,
      collection,
    );
    if (finalUnit) return finalUnit;
  }

  const urlCandidates = buildCandidateUrls(params.url, reserve);

  const directCandidates = urlCandidates
    .map((url) => stripUrlFragment(url))
    .filter((url) => url && isDirectImageUrl(url));
  if (directCandidates.length > 0) {
    const reachable = await firstReachableUrl(directCandidates, signal);
    if (reachable) return reachable;
  }

  for (const metadataCandidate of urlCandidates) {
    const result = await fetchImageFromMetadataCandidate(metadataCandidate, signal, collection);
    if (result.status === 'fail') continue;
    if (result.isImage) return stripUrlFragment(result.image);
    const finalUrl = resolveFinalImage(result.image, gatewayForUrl(metadataCandidate), collection);
    if (finalUrl) return stripUrlFragment(finalUrl);
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
    const resolved = await resolveFromPera(cacheKey, signal)
      || await resolveFromAssetParams(cacheKey, signal);

    let finalResolved = resolved;
    if (finalResolved?.startsWith(YBG_GATEWAY) && !await isReachable(withOriginScopedCache(finalResolved), signal)) {
      const genericFallback = getGenericIpfsFallback(finalResolved);
      if (await isReachable(genericFallback, signal)) {
        finalResolved = genericFallback;
      }
    }

    if (finalResolved) {
      cache.set(cacheKey, finalResolved);
      return finalResolved;
    }
    return null;
  } catch {
    return null;
  }
};
