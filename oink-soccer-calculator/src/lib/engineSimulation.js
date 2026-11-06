const POSITION_NAMES = { GK: 'Goalkeeper', DF: 'Defense', MF: 'Midfield', FW: 'Attack' };
const FORMATION_NAMES = { Pyramid: 'The Pyramid', Diamond: 'The Diamond', Y: 'The Y', Box: 'The Box' };
const finite = (value, fallback = 0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;

export const engineBoosts = (state, decay, minimum) => (state?.boosts || []).map((entry) => {
  const boost = entry.boost || entry;
  const effectiveness = state.source === 'live' ? Math.max(0, Math.min(100, finite(state.effectivenessPct, 100))) / 100 : 1;
  const applications = Math.max(0, Math.floor(finite(boost.applications)));
  const scale = effectiveness * Math.max(minimum, Math.pow(decay, applications));
  return {
    boost_type: boost.boost_type,
    boost_position: boost.boost_position || '',
    min_boost: 1 + (finite(boost.min_boost, 1) - 1) * scale,
    max_boost: 1 + (finite(boost.max_boost, 1) - 1) * scale,
    decay_charge: 0,
  };
});

export const engineLineup = (players, formation, tactics, boosts) => ({
  team: { id: 'team', formation: FORMATION_NAMES[formation], tactics: {
    Press: tactics.press, Tempo: tactics.tempo, LineHeight: tactics.lineHeight, SetPieceTaker: String(tactics.setPieceTaker || ''),
  } },
  players: players.map((player) => {
    const stats = player.stats || {};
    const reduction = finite(player.injuryDetails?.statsReduction, { Low: 0.95, Mid: 0.90, High: 0.85 }[player.injury] || 1);
    const attributes = {
      goalkeeper_rating: finite(stats.GKP), defense_rating: finite(stats.DEF), speed_rating: finite(stats.SPD),
      control_rating: finite(stats.CTL), attack_rating: finite(stats.ATT), aggression_rating: finite(stats.AGG),
      work_rate: finite(stats.WRT), finishing: finite(stats.FIN), heading: finite(stats.HDG),
      technique: finite(stats.TEC), composure: finite(stats.CMP), tackling: finite(stats.TCK),
      position: POSITION_NAMES[player.pos], positions: (player.positions || [player.pos]).map((pos) => POSITION_NAMES[pos]).filter(Boolean),
      tags: player.tags || [],
    };
    return { id: String(player.id), name: player.name, position: POSITION_NAMES[player.selectedPosition || player.pos], attributes,
      role: player.role || '', ...(player.injury && reduction < 1 ? { injury: { injury: { stats_reduction: reduction } } } : {}) };
  }),
  item_boosts: boosts,
});
