const uniqueById = (players) => {
  const map = new Map();
  for (const player of players) {
    map.set(player.id, player);
  }
  return Array.from(map.values());
};

const byOvrDesc = (a, b) => b.ovr - a.ovr;

const pickLineup = (currentTeam, squad, limit = 5) => {
  const squadById = new Map(squad.map((p) => [p.id, p]));
  const nextTeam = [];

  for (const player of currentTeam) {
    const stillExists = squadById.get(player.id);
    if (stillExists) {
      nextTeam.push(stillExists);
    }
  }

  if (nextTeam.length >= limit) {
    return nextTeam.slice(0, limit);
  }

  const selectedIds = new Set(nextTeam.map((p) => p.id));
  const candidates = squad.filter((p) => !selectedIds.has(p.id)).sort(byOvrDesc);
  for (const candidate of candidates) {
    if (nextTeam.length >= limit) {
      break;
    }
    nextTeam.push(candidate);
  }

  return nextTeam;
};

export const buildWalletPlayers = (heldAssetIds, catalogByAssetId) => {
  const walletPlayers = [];
  let unmatched = 0;

  for (const assetId of heldAssetIds) {
    const entry = catalogByAssetId[assetId];
    if (!entry) {
      unmatched += 1;
      continue;
    }

    walletPlayers.push({
      id: `asset:${entry.assetId}`,
      name: entry.assetName,
      pos: entry.pos,
      stats: entry.stats,
      ovr: entry.ovr,
      injury: null,
      source: 'wallet',
      assetId: entry.assetId,
      assetKey: entry.assetKey,
      playerName: entry.playerName,
      season: entry.season,
      positions: Array.isArray(entry.positions) && entry.positions.length > 0
        ? entry.positions
        : [entry.pos],
    });
  }

  return {
    walletPlayers: uniqueById(walletPlayers),
    matchedCount: walletPlayers.length,
    unmatchedCount: unmatched,
  };
};

export const mergeWalletPlayers = ({ mySquad, myTeam, walletPlayers }) => {
  const preserved = mySquad.filter((player) => player.source !== 'wallet');
  const nextSquad = uniqueById([...preserved, ...walletPlayers]);
  const nextTeam = pickLineup(myTeam, nextSquad, 5);

  return { nextSquad, nextTeam };
};
