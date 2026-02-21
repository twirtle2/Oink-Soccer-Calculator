let catalogPromise = null;

export const loadPlayableCatalog = async () => {
  if (!catalogPromise) {
    catalogPromise = fetch(`${import.meta.env.BASE_URL}data/playable-assets.s14.json`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load playable asset catalog (${response.status})`);
        }
        return response.json();
      })
      .then((payload) => payload?.assets || {})
      .catch((error) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
};
