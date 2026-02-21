import algosdk from 'algosdk';

const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

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

const toHttpUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('template-ipfs://')) return null;
  if (raw.startsWith('ipfs://')) return `${IPFS_GATEWAY}${raw.replace('ipfs://', '')}`;
  if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
  return null;
};

const resolveAssetUrl = (urlValue, reserveAddress) => {
  if (!urlValue || typeof urlValue !== 'string') return null;
  if (urlValue.startsWith('template-ipfs://')) {
    const ipfsTemplate = decodeArc19IpfsTemplate(urlValue, reserveAddress);
    if (!ipfsTemplate) return null;
    return toHttpUrl(ipfsTemplate.replace('template-ipfs://', 'ipfs://'));
  }
  return toHttpUrl(urlValue);
};

const isDirectImageUrl = (url) => /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(url);

const parseImageFromMetadata = (metadata) => {
  const candidate = metadata?.image
    || metadata?.image_url
    || metadata?.properties?.image
    || metadata?.properties?.image_url;
  return toHttpUrl(candidate);
};

const fetchImageFromMetadataUrl = async (metadataUrl, signal) => {
  const response = await fetch(metadataUrl, { signal });
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('image/')) {
    return metadataUrl;
  }

  if (contentType.includes('application/json') || contentType.includes('text/json') || metadataUrl.endsWith('.json')) {
    const metadata = await response.json();
    return parseImageFromMetadata(metadata);
  }

  return null;
};

const resolveFromAssetParams = async (assetId, signal) => {
  const response = await fetch(`${INDEXER_BASE}/v2/assets/${assetId}`, { signal });
  if (!response.ok) return null;
  const payload = await response.json();
  const params = payload?.asset?.params;
  if (!params) return null;

  const unitImage = resolveAssetUrl(params?.['unit-name-image-url'], params?.reserve);
  if (unitImage) return stripUrlFragment(unitImage);

  const url = resolveAssetUrl(params.url, params.reserve);
  if (!url) return null;
  const cleanUrl = stripUrlFragment(url);
  if (!cleanUrl) return null;
  if (isDirectImageUrl(cleanUrl)) return cleanUrl;

  const metadataImage = await fetchImageFromMetadataUrl(cleanUrl, signal);
  if (metadataImage) {
    return stripUrlFragment(metadataImage);
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
