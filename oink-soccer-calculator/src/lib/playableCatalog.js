let catalogPromise = null;

const LEGACY_DEFAULT_CATALOG = 'playable-assets.s14.json';

const fetchJsonOrNull = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
};

const loadCatalogFromManifest = async (manifest) => {
  const base = `${import.meta.env.BASE_URL}data/`;
  const catalogFile = manifest?.catalogFile
    || (manifest?.currentSeason ? `playable-assets.s${manifest.currentSeason}.json` : LEGACY_DEFAULT_CATALOG);
  const payload = await fetchJsonOrNull(`${base}${catalogFile}`);

  if (!payload) {
    throw new Error(`Failed to load playable asset catalog file "${catalogFile}"`);
  }

  return {
    manifest,
    season: payload?.season ?? manifest?.currentSeason ?? null,
    generatedAt: payload?.generatedAt ?? manifest?.generatedAt ?? null,
    sourceRepo: payload?.sourceRepo ?? manifest?.sourceRepo ?? null,
    sourceRef: payload?.sourceRef ?? manifest?.sourceRef ?? null,
    catalogFile,
    assets: payload?.assets || {},
  };
};

export const loadPlayableCatalog = async () => {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const base = `${import.meta.env.BASE_URL}data/`;
      const manifest = await fetchJsonOrNull(`${base}playable-catalog-manifest.json`);

      if (manifest) {
        return loadCatalogFromManifest(manifest);
      }

      const legacyPayload = await fetchJsonOrNull(`${base}${LEGACY_DEFAULT_CATALOG}`);
      if (!legacyPayload) {
        throw new Error('Failed to load playable asset catalog manifest and legacy catalog.');
      }

      return {
        manifest: null,
        season: legacyPayload?.season ?? null,
        generatedAt: legacyPayload?.generatedAt ?? null,
        sourceRepo: legacyPayload?.sourceRepo ?? null,
        sourceRef: legacyPayload?.sourceRef ?? null,
        catalogFile: LEGACY_DEFAULT_CATALOG,
        assets: legacyPayload?.assets || {},
      };
    })().catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }

  return catalogPromise;
};

