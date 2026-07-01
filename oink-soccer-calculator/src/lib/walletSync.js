const uniqueById = (players) => {
  const map = new Map();
  for (const player of players) {
    map.set(player.id, player);
  }
  return Array.from(map.values());
};

const normalizeAssetId = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(?:Algorand:)?(\d+)$/i);
  return match ? match[1] : null;
};

const getPlayerAssetId = (player) => (
  normalizeAssetId(player?.assetId)
  || normalizeAssetId(player?.assetKey)
  || normalizeAssetId(player?.id)
);

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
      role: '',
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

export const applyLiveLineupInjuries = (players, liveLineupPlayers = []) => {
  const liveByAssetId = new Map();
  liveLineupPlayers.forEach((player) => {
    const assetId = getPlayerAssetId(player);
    if (!assetId) return;
    liveByAssetId.set(assetId, player);
  });

  if (liveByAssetId.size === 0) return players;

  let changed = false;
  const nextPlayers = players.map((player) => {
    const assetId = getPlayerAssetId(player);
    if (!assetId || !liveByAssetId.has(assetId)) return player;
    const livePlayer = liveByAssetId.get(assetId);
    const nextInjury = livePlayer.injury || null;
    const nextInjuryDetails = livePlayer.injuryDetails || null;
    if (
      player.injury === nextInjury
      && JSON.stringify(player.injuryDetails || null) === JSON.stringify(nextInjuryDetails)
    ) {
      return player;
    }
    changed = true;
    return {
      ...player,
      injury: nextInjury,
      injuryDetails: nextInjuryDetails,
    };
  });

  return changed ? nextPlayers : players;
};
