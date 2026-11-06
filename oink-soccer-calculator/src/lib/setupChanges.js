const ROLE_LABELS = { captain: 'Captain', target_man: 'Target Man', playmaker: 'Playmaker', ball_winner: 'Ball Winner' };
const TACTIC_LABELS = { press: 'Press', tempo: 'Tempo', lineHeight: 'Line height' };
const playerKey = (player) => {
  const asset = player?.assetId || player?.assetKey;
  if (asset) return `asset:${String(asset).replace(/^Algorand:/i, '')}`;
  const id = String(player?.id || '');
  const match = id.match(/^asset:(\d+)$/i);
  return match ? `asset:${match[1]}` : id ? `id:${id}` : '';
};
const playerName = (player) => player?.assetName || player?.name || 'Unknown player';
const getSetPieceKey = (tactics, players) => {
  const reference = String(tactics?.setPieceTaker || '');
  if (!reference) return '';
  const match = players.find((player) => String(player.id) === reference || String(player.assetKey || '') === reference || String(player.assetId || '') === reference);
  return match ? playerKey(match) : null;
};

export const compareSetup = (live, recommendation) => {
  if (!live || live.isDefaultLineup || !live.formationKey || !Array.isArray(live.players) || live.players.length !== 5 || !recommendation?.formation || recommendation.lineup?.length !== 5) return null;
  const current = new Map(live.players.map((player) => [playerKey(player), player]));
  const proposed = new Map(recommendation.lineup.map((player) => [playerKey(player), player]));
  if (current.has('') || proposed.has('') || current.size !== 5 || proposed.size !== 5) return null;
  const positionsAvailable = live.players.every((player) => Boolean(player.selectedPosition));
  const changes = [];
  const playerChanges = {};
  const addPlayerChange = (key, type) => { (playerChanges[key] ||= []).push(type); };
  if (live.formationKey !== recommendation.formation) changes.push({ type: 'formation', text: `Formation: ${live.formationKey} → ${recommendation.formation}` });
  for (const [key, player] of proposed) {
    const existing = current.get(key);
    const position = player.selectedPosition || player.pos;
    if (!existing) {
      changes.push({ type: 'player', text: `Add ${playerName(player)} at ${position}` });
      addPlayerChange(key, 'Add');
    } else if (existing.selectedPosition && existing.selectedPosition !== position) {
      changes.push({ type: 'position', text: `Move ${playerName(player)}: ${existing.selectedPosition} → ${position}` });
      addPlayerChange(key, 'Move');
    }
    if ((existing?.role || '') !== (player.role || '')) {
      const role = ROLE_LABELS[player.role] || (player.role ? player.role : 'No role');
      changes.push({ type: 'role', text: `${playerName(player)}: ${role}` });
      addPlayerChange(key, 'Role');
    }
  }
  for (const [key, player] of current) if (!proposed.has(key)) changes.push({ type: 'player', text: `Remove ${playerName(player)}` });
  let tacticsAvailable = Boolean(live.tactics);
  if (tacticsAvailable) {
    const defaults = { press: 'medium', tempo: 'normal', lineHeight: 'normal' };
    for (const [key, label] of Object.entries(TACTIC_LABELS)) {
      const before = live.tactics[key] || defaults[key];
      const after = recommendation.tactics?.[key] || defaults[key];
      if (before !== after) changes.push({ type: key, text: `${label}: ${before} → ${after}` });
    }
    const oldTaker = getSetPieceKey(live.tactics, live.players);
    const newTaker = getSetPieceKey(recommendation.tactics, recommendation.lineup);
    if (oldTaker === null || newTaker === null) tacticsAvailable = false;
    else if (oldTaker !== newTaker) {
      const taker = proposed.get(newTaker);
      changes.push({ type: 'setPieceTaker', text: `Set pieces: ${taker ? playerName(taker) : 'Auto'}` });
      if (newTaker) addPlayerChange(newTaker, 'Set pieces');
    }
  }
  return { changes, playerChanges, tacticsAvailable, positionsAvailable, playerKey };
};
