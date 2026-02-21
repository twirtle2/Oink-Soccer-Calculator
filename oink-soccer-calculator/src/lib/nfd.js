const NFD_LOOKUP_BASE = 'https://api.nf.domains/nfd/lookup';
const IPFS_GATEWAY_BASE = 'https://ipfs.io/ipfs/';

const normalizeAvatarUrl = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }

  if (value.startsWith('ipfs://')) {
    const ipfsPath = value.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return `${IPFS_GATEWAY_BASE}${ipfsPath}`;
  }

  if (value.startsWith('https://') || value.startsWith('http://')) {
    return value;
  }

  return null;
};

const extractImageFromMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const direct =
    metadata.image ||
    metadata.image_url ||
    metadata.imageUrl ||
    metadata.properties?.image ||
    metadata.properties?.image_url ||
    metadata.properties?.imageUrl ||
    null;

  return normalizeAvatarUrl(direct);
};

const resolveAvatarMediaUrl = async (avatarRaw, signal) => {
  const candidateUrl = normalizeAvatarUrl(avatarRaw);
  if (!candidateUrl) {
    return null;
  }

  try {
    const headResponse = await fetch(candidateUrl, { method: 'HEAD', signal });
    const contentType = (headResponse.headers.get('content-type') || '').toLowerCase();

    if (contentType.startsWith('image/')) {
      return candidateUrl;
    }

    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const jsonResponse = await fetch(candidateUrl, { signal });
      if (!jsonResponse.ok) {
        return candidateUrl;
      }
      const metadata = await jsonResponse.json();
      const resolvedImageUrl = extractImageFromMetadata(metadata);
      return resolvedImageUrl || candidateUrl;
    }
  } catch (_) {
    return candidateUrl;
  }

  return candidateUrl;
};

const pickLookupEntry = (payload, address) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload[address]) {
    return payload[address];
  }

  const lowerAddress = address.toLowerCase();
  const byKey = Object.entries(payload).find(([key]) => key.toLowerCase() === lowerAddress);
  if (byKey) {
    return byKey[1];
  }

  const firstRecord = Object.values(payload).find((value) => value && typeof value === 'object');
  return firstRecord || null;
};

export const lookupNfdByAddress = async (address, signal) => {
  if (!address) {
    return null;
  }

  const url = `${NFD_LOOKUP_BASE}?address=${encodeURIComponent(address)}&view=thumbnail&allowUnverified=true`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`NFD lookup failed (${response.status})`);
  }

  const payload = await response.json();
  const entry = pickLookupEntry(payload, address);
  if (!entry) {
    return null;
  }

  const avatarRaw = entry?.properties?.userDefined?.avatar || entry?.properties?.verified?.avatar || null;
  const avatarUrl = await resolveAvatarMediaUrl(avatarRaw, signal);
  const name = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : null;

  return {
    name,
    avatarUrl,
  };
};
