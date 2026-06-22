const LOST_PIGS_API_BASE = 'https://api.thelostpigs.com';

const POSITION_MAP = {
  Goalkeeper: 'GK',
  Defense: 'DF',
  Midfield: 'MF',
  Attack: 'FW',
};

const FORMATION_CANDIDATES = [
  { key: 'Diamond', regex: /(DIAMOND|1\s*[-:]\s*2\s*[-:]\s*1)/i },
  { key: 'Pyramid', regex: /(PYRAMID|2\s*[-:]\s*1\s*[-:]\s*1)/i },
  { key: 'Y', regex: /(\bTHE\s*Y\b|1\s*[-:]\s*1\s*[-:]\s*2)/i },
  { key: 'Box', regex: /(\bBOX\b|2\s*[-:]\s*0\s*[-:]\s*2)/i },
];

const clampStat = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
};

const normalizeTeamId = (value = '') => {
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return `AlgorandAsset:${trimmed}`;
  }

  const match = trimmed.match(/^AlgorandAsset:(\d+)$/i);
  if (!match) return null;
  return `AlgorandAsset:${match[1]}`;
};

const teamIdToAssetId = (teamId) => {
  const normalized = normalizeTeamId(teamId);
  if (!normalized) return null;
  return normalized.replace(/^AlgorandAsset:/i, '');
};

const deriveFormationKey = (formationLabel = '') => {
  if (!formationLabel) return null;
  for (const candidate of FORMATION_CANDIDATES) {
    if (candidate.regex.test(formationLabel)) {
      return candidate.key;
    }
  }
  return null;
};

const extractTeamIdFromInput = (value = '') => {
  const input = String(value).trim();
  if (!input) {
    throw new Error('Enter a Lost Pigs team URL or teamId.');
  }

  const directTeamId = normalizeTeamId(decodeURIComponent(input));
  if (directTeamId) return directTeamId;

  const inlineMatch = input.match(/AlgorandAsset(?::|%3A)\d+/i);
  if (inlineMatch) {
    const decoded = decodeURIComponent(inlineMatch[0]).replace(/%3A/gi, ':');
    const normalized = normalizeTeamId(decoded);
    if (normalized) return normalized;
  }

  try {
    const parsed = new URL(input);
    const fromQuery = parsed.searchParams.get('teamId');
    if (fromQuery) {
      const normalized = normalizeTeamId(decodeURIComponent(fromQuery));
      if (normalized) return normalized;
    }

    const pathTail = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const fromPath = normalizeTeamId(pathTail);
    if (fromPath) return fromPath;
  } catch (_) {
    // Continue to final validation error below.
  }

  throw new Error('Could not parse a teamId. Expected format: AlgorandAsset:<id>.');
};

const getPositionKey = (positionLabel, stats) => {
  if (POSITION_MAP[positionLabel]) return POSITION_MAP[positionLabel];
  if ((stats.GKP || 0) >= 55) return 'GK';
  const attack = stats.ATT || 0;
  const control = stats.CTL || 0;
  const defense = stats.DEF || 0;
  if (attack >= control && attack >= defense) return 'FW';
  if (defense >= control && defense >= attack) return 'DF';
  return 'MF';
};

const computeOvr = (stats, pos, providedOvr) => {
  const parsedProvided = Number.parseInt(String(providedOvr), 10);
  if (Number.isFinite(parsedProvided)) {
    return clampStat(parsedProvided, 0);
  }
  if (pos === 'GK') return Math.round(((stats.GKP * 5) + stats.SPD) / 6);
  if (pos === 'DF') return Math.round(((stats.DEF * 5) + stats.SPD) / 6);
  if (pos === 'MF') return Math.round(((stats.CTL * 4) + stats.SPD) / 5);
  return Math.round(((stats.ATT * 3) + stats.SPD) / 4);
};

const DEFAULT_FORMATION_POSITIONS = {
  Diamond: ['GK', 'DF', 'MF', 'MF', 'FW'],
  Pyramid: ['GK', 'DF', 'DF', 'MF', 'FW'],
  Y: ['GK', 'DF', 'MF', 'FW', 'FW'],
  Box: ['GK', 'DF', 'DF', 'FW', 'FW'],
};

const isPlaceholderPlayer = (player) => {
  const name = String(player?.name || '').trim();
  if (!/^player\s+\d+$/i.test(name)) return false;
  const stats = player?.stats || {};
  const coreStats = [stats.SPD, stats.ATT, stats.CTL, stats.DEF];
  return player?.ovr === 55
    && coreStats.every((value) => Number(value) === 55);
};

const createDefaultLineupPlayers = (teamId, formationKey) => {
  const positions = DEFAULT_FORMATION_POSITIONS[formationKey] || DEFAULT_FORMATION_POSITIONS.Diamond;
  return positions.map((pos, index) => {
    const stats = {
      SPD: 55,
      ATT: 55,
      CTL: 55,
      DEF: 55,
      GKP: pos === 'GK' ? 55 : 0,
      WRT: 0,
      FIN: 0,
      HDG: 0,
      TEC: 0,
      CMP: 0,
      TCK: 0,
    };

    return {
      id: `default:${teamId}:${index + 1}`,
      name: `PLAYER ${index + 1}`,
      pos,
      stats,
      ovr: 55,
      injury: null,
      role: '',
      source: 'team-url',
      imageUrl: null,
      positions: [pos],
    };
  });
};

const mapInjurySeverity = (assetInjury) => {
  const injury = assetInjury?.injury || assetInjury;
  if (!injury || typeof injury !== 'object') return null;

  const severity = String(injury.severity || '').toLowerCase();
  if (severity.includes('high') || severity.includes('severe')) return 'High';
  if (severity.includes('mid') || severity.includes('medium') || severity.includes('moderate')) return 'Mid';
  if (severity.includes('low') || severity.includes('minor')) return 'Low';

  const reduction = Number(injury.stats_reduction);
  if (Number.isFinite(reduction)) {
    if (reduction <= 0.875) return 'High';
    if (reduction <= 0.925) return 'Mid';
    if (reduction < 1) return 'Low';
  }

  return null;
};

const mapInjuryDetails = (assetInjury) => {
  const injury = assetInjury?.injury || assetInjury;
  const mappedSeverity = mapInjurySeverity(assetInjury);
  if (!mappedSeverity) return null;

  return {
    severity: mappedSeverity,
    label: injury?.severity || mappedSeverity,
    name: injury?.name || '',
    description: injury?.description || '',
    statsReduction: Number.isFinite(Number(injury?.stats_reduction))
      ? Number(injury.stats_reduction)
      : null,
    expires: assetInjury?.expires || injury?.expires || null,
  };
};

const mapTeamPayloadToPlayers = (teamId, payload) => {
  const slots = payload?.team_selection?.slots || {};
  const formationLabel = payload?.team?.formation || '';
  const formationKey = deriveFormationKey(formationLabel);
  const slotEntries = Object.entries(slots)
    .filter(([, value]) => value && value.player_attributes)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  const players = slotEntries.map(([slotKey, slot], index) => {
    const attrs = slot.player_attributes || {};
    const stats = {
      SPD: clampStat(attrs.speed_rating, 50),
      ATT: clampStat(attrs.attack_rating, 50),
      CTL: clampStat(attrs.control_rating, 50),
      DEF: clampStat(attrs.defense_rating, 50),
      GKP: clampStat(attrs.goalkeeper_rating, 0),
      WRT: clampStat(attrs.work_rate, 0),
      FIN: clampStat(attrs.finishing, 0),
      HDG: clampStat(attrs.heading, 0),
      TEC: clampStat(attrs.technique, 0),
      CMP: clampStat(attrs.composure, 0),
      TCK: clampStat(attrs.tackling, 0),
    };

    const pos = getPositionKey(attrs.position, stats);
    if (pos !== 'GK') {
      stats.GKP = 0;
    } else if (stats.GKP === 0) {
      stats.GKP = 50;
    }

    const name = attrs.based_on_player
      || slot.asset?.name
      || `Opponent ${index + 1}`;
    const ovr = computeOvr(stats, pos, attrs.overall_rating);
    const injuryDetails = mapInjuryDetails(slot.asset?.injury || slot.injury || attrs.injury);

    return {
      id: `teamurl:${teamId}:${slotKey}`,
      name,
      pos,
      stats,
      ovr,
      injury: injuryDetails?.severity || null,
      injuryDetails,
      role: slot.role || slot.player_role || '',
      source: 'team-url',
      imageUrl: slot.asset?.image_url || slot.asset?.image || attrs.image_url || null,
      positions: Array.isArray(attrs.positions) && attrs.positions.length > 0
        ? attrs.positions.map(p => getPositionKey(p, stats))
        : [pos],
    };
  });

  const teamLabel = payload?.team?.custom_name || payload?.team?.id || teamId;
  const lineupPlayers = players.length > 0
    ? players
    : formationKey
      ? createDefaultLineupPlayers(teamId, formationKey)
      : players;
  const isDefaultLineup = lineupPlayers.length > 0 && lineupPlayers.every(isPlaceholderPlayer);

  return {
    teamId,
    teamLabel,
    formationLabel,
    formationKey,
    isDefaultLineup,
    players: lineupPlayers,
  };
};

const hasActivePlayableLineup = (players) => (
  Array.isArray(players)
  && players.length > 0
);

const fetchTeamPayload = async (teamId) => {
  const response = await fetch(`${LOST_PIGS_API_BASE}/v2/soccer/team/${encodeURIComponent(teamId)}`);
  if (response.ok) {
    return response.json();
  }

  let details = '';
  try {
    const body = await response.json();
    details = body?.message || body?.code || '';
  } catch (_) {
    details = '';
  }

  if (response.status === 404) {
    throw new Error('Team not found. Check the URL or teamId.');
  }
  if (details) {
    throw new Error(`Lost Pigs API error: ${details}`);
  }
  throw new Error(`Lost Pigs API returned ${response.status}.`);
};

const fetchJsonOrThrow = async (path, notFoundMessage) => {
  const response = await fetch(`${LOST_PIGS_API_BASE}${path}`);
  if (response.ok) {
    return response.json();
  }

  if (response.status === 404 && notFoundMessage) {
    throw new Error(notFoundMessage);
  }

  let details = '';
  try {
    const body = await response.json();
    details = body?.message || body?.code || '';
  } catch (_) {
    details = '';
  }

  if (details) {
    throw new Error(`Lost Pigs API error: ${details}`);
  }
  throw new Error(`Lost Pigs API returned ${response.status}.`);
};

const normalizeSeasonValue = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('Lost Pigs API returned an invalid season value.');
  }
  return parsed;
};

export const fetchLeagueTeamsIndex = async () => {
  const [teamsPayload, configPayload] = await Promise.all([
    fetchJsonOrThrow('/soccer/league/teams'),
    fetchJsonOrThrow('/soccer/league/config'),
  ]);

  const leagueNames = {};
  for (const league of configPayload?.leagues_config || []) {
    if (!league?.id) continue;
    leagueNames[String(league.id)] = league?.name || `League ${league.id}`;
  }

  const payload = teamsPayload;
  const teamsByLeague = payload?.teams_by_league || {};
  const byLeague = {};
  const allTeams = [];

  for (const [leagueId, teams] of Object.entries(teamsByLeague)) {
    const normalized = (teams || [])
      .map((team) => {
        const teamId = normalizeTeamId(team?.id);
        if (!teamId) return null;
        return {
          leagueId: String(leagueId),
          teamId,
          teamName: team?.name || teamId,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.teamName.localeCompare(b.teamName));

    byLeague[String(leagueId)] = normalized;
    allTeams.push(...normalized);
  }

  return { byLeague, allTeams, leagueNames };
};

export const fetchCurrentSeason = async () => {
  const payload = await fetchGameCounter();
  return normalizeSeasonValue(payload?.season);
};

export const fetchGameCounter = async () => {
  const payload = await fetchJsonOrThrow('/soccer/game-counter');
  return {
    season: normalizeSeasonValue(payload?.season),
    game_round: Number.parseInt(String(payload?.game_round || 1), 10) || 1,
    games_per_season: Number.parseInt(String(payload?.games_per_season || 0), 10) || 0,
    is_active: Boolean(payload?.is_active),
  };
};

export const fetchLeagueRoundFixtures = async ({ leagueId, season, round }) => {
  const normalizedLeagueId = String(leagueId || '').trim();
  if (!normalizedLeagueId) {
    throw new Error('Missing leagueId for fixtures fetch.');
  }

  const normalizedSeason = normalizeSeasonValue(season);
  const normalizedRound = Number.parseInt(String(round || 1), 10) || 1;
  const payload = await fetchJsonOrThrow(
    `/soccer/league/${encodeURIComponent(normalizedLeagueId)}/season/${encodeURIComponent(String(normalizedSeason))}/round/${encodeURIComponent(String(normalizedRound))}/fixtures`,
    'League fixtures not found.',
  );

  return {
    fixtures: Array.isArray(payload?.fixtures) ? payload.fixtures : [],
    season: normalizedSeason,
    round: normalizedRound,
  };
};

export const fetchLeagueSeasonFixtures = async ({ leagueId, season, rounds }) => {
  const totalRounds = Number.parseInt(String(rounds || 0), 10) || 44;
  const roundNumbers = Array.from({ length: totalRounds }, (_, index) => index + 1);
  const payloads = await Promise.allSettled(
    roundNumbers.map((round) => fetchLeagueRoundFixtures({ leagueId, season, round })),
  );

  const fulfilled = payloads
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  if (fulfilled.length === 0) {
    throw new Error('No season fixtures could be loaded.');
  }

  return fulfilled.flatMap((payload) => (
    payload.fixtures.map((fixture) => ({
      ...fixture,
      game_round: payload.round,
      sort_round: payload.round,
      competition: 'league',
    }))
  ));
};

const getTournamentRoundLabel = (roundNumber, totalRounds) => {
  const round = Number.parseInt(String(roundNumber || 0), 10);
  const total = Number.parseInt(String(totalRounds || 0), 10);
  if (!round || !total) return 'Cup';
  if (round === total) return 'Final';
  if (round === total - 1) return 'Semi-final';
  if (round === total - 2) return 'Quarter-final';
  const teamsRemaining = 2 ** ((total - round) + 1);
  return `Round of ${teamsRemaining}`;
};

const getTournamentRoundNumberFromLabel = (roundLabel, totalRounds = 6) => {
  const label = String(roundLabel || '').trim().toLowerCase();
  if (!label) return null;
  if (label === 'final') return Number(totalRounds) || 6;
  if (label === 'sf' || label.includes('semi')) return Math.max(1, (Number(totalRounds) || 6) - 1);
  if (label === 'qf' || label.includes('quarter')) return Math.max(1, (Number(totalRounds) || 6) - 2);
  const roundOfMatch = label.match(/r(?:ound\s*of\s*)?(\d+)/i);
  const teamsRemaining = roundOfMatch ? Number.parseInt(roundOfMatch[1], 10) : Number.NaN;
  if (Number.isFinite(teamsRemaining) && teamsRemaining > 1) {
    const round = (Number(totalRounds) || 6) - Math.log2(teamsRemaining) + 1;
    return Number.isFinite(round) ? Math.max(1, Math.round(round)) : null;
  }
  return null;
};

const estimateTournamentSortRound = (roundNumber, totalRounds, leagueRounds) => {
  const round = Number.parseInt(String(roundNumber || 1), 10) || 1;
  const total = Math.max(1, Number.parseInt(String(totalRounds || round), 10) || round);
  const leagueTotal = Math.max(1, Number.parseInt(String(leagueRounds || 44), 10) || 44);

  if (round >= total) return leagueTotal + 0.5;
  if (total === 1) return leagueTotal + 0.5;

  return Math.min((round * 6) + 0.5, leagueTotal - 0.5);
};

const getKnownTournamentSchedule = (tournament, roundNumber) => {
  const season = Number(tournament?.season);
  const round = Number(roundNumber);
  if (season === 16) {
    const knownSchedule = {
      1: { gameTime: '2026-06-18T11:54:00Z', sortRound: 6.5 },
      2: { gameTime: '2026-06-25T11:59:00Z', sortRound: 12.5 },
      3: { gameTime: '2026-07-02T12:30:00Z', sortRound: 18.5 },
      4: { gameTime: '2026-07-09T12:30:00Z', sortRound: 24.5 },
      5: { gameTime: '2026-07-16T15:00:00Z', sortRound: 30.5 },
      6: { gameTime: '2026-07-25T20:00:00Z', sortRound: 38.5 },
    };
    return knownSchedule[round] || null;
  }
  return null;
};

const normalizeTournamentMatch = (tournament, match, leagueRounds) => {
  const homeTeamId = normalizeTeamId(match?.home_team_id);
  const awayTeamId = normalizeTeamId(match?.away_team_id);
  if (!homeTeamId || !awayTeamId) return null;

  const roundNumber = Number.parseInt(String(match?.round_number || 1), 10) || 1;
  const homeScore = match?.home_team_score;
  const awayScore = match?.away_team_score;
  const hasScore = homeScore !== null
    && homeScore !== undefined
    && awayScore !== null
    && awayScore !== undefined;
  const fallbackKey = `cup:${tournament.id}:${roundNumber}:${match?.game_id || 'match'}`;
  const gameKey = match?.game_key || fallbackKey;
  const knownSchedule = getKnownTournamentSchedule(tournament, roundNumber);
  const gameTime = match?.game_time || knownSchedule?.gameTime || null;

  return {
    ...match,
    game_key: gameKey,
    source_game_key: match?.game_key || '',
    game_round: `C${roundNumber}`,
    sort_round: knownSchedule?.sortRound || estimateTournamentSortRound(roundNumber, tournament?.total_rounds, leagueRounds),
    competition: 'cup',
    tournament_id: tournament.id,
    tournament_name: tournament.name || 'The Lost Cup',
    cup_round_number: roundNumber,
    cup_round_label: getTournamentRoundLabel(roundNumber, tournament?.total_rounds),
    game_time: gameTime,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    home_team_name: match?.home_team_name || homeTeamId,
    away_team_name: match?.away_team_name || awayTeamId,
    game_result: hasScore
      ? {
        home_team_score: Number(homeScore || 0),
        away_team_score: Number(awayScore || 0),
        decided_on_penalties: Boolean(match?.decided_on_penalties),
        home_penalty_score: match?.home_penalty_score,
        away_penalty_score: match?.away_penalty_score,
      }
      : null,
  };
};

export const fetchActiveTournamentForSeason = async (season) => {
  const normalizedSeason = normalizeSeasonValue(season);
  const payload = await fetchJsonOrThrow('/soccer/tournaments', 'Tournaments not found.');
  const tournaments = Array.isArray(payload) ? payload : [];
  const seasonTournaments = tournaments.filter((tournament) => Number(tournament?.season) === normalizedSeason);
  const candidates = seasonTournaments.length > 0 ? seasonTournaments : tournaments;
  if (candidates.length === 0) return null;

  const active = candidates.filter((tournament) => tournament?.is_active);
  return [...(active.length > 0 ? active : candidates)]
    .sort((a, b) => Number(b?.season || 0) - Number(a?.season || 0))[0] || null;
};

export const fetchTournamentMatches = async (tournamentId) => {
  const normalizedTournamentId = String(tournamentId || '').trim();
  if (!normalizedTournamentId) {
    throw new Error('Missing tournamentId for cup fetch.');
  }

  const payload = await fetchJsonOrThrow(
    `/soccer/tournaments/${encodeURIComponent(normalizedTournamentId)}/matches`,
    'Tournament matches not found.',
  );
  return Array.isArray(payload) ? payload : [];
};

export const fetchSeasonTournamentFixtures = async ({ season, leagueRounds }) => {
  const tournament = await fetchActiveTournamentForSeason(season);
  if (!tournament) return [];
  const matches = await fetchTournamentMatches(tournament.id);
  return matches
    .map((match) => normalizeTournamentMatch(tournament, match, leagueRounds))
    .filter(Boolean);
};

export const fetchTeamSeasonFixtures = async ({ teamId, leagueId, season }) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId for team fixture fetch.');
  }

  const normalizedLeagueId = String(leagueId || '').trim();
  if (!normalizedLeagueId) {
    throw new Error('Missing leagueId for team fixture fetch.');
  }

  const normalizedSeason = normalizeSeasonValue(season);
  const payload = await fetchJsonOrThrow(
    `/soccer/team/${encodeURIComponent(normalizedTeamId)}/league/${encodeURIComponent(normalizedLeagueId)}/season/${encodeURIComponent(String(normalizedSeason))}/fixtures`,
    'Team fixtures not found.',
  );
  const rawFixtures = Array.isArray(payload?.fixtures) ? payload.fixtures : [];

  let lastLeagueRound = 0;
  return rawFixtures
    .map((fixture, index) => {
      if (String(fixture?.competition || '').toLowerCase() !== 'cup') {
        const round = Number.parseInt(String(fixture?.round || fixture?.game_round || index + 1), 10) || index + 1;
        lastLeagueRound = round;
        return {
          ...fixture,
          game_round: round,
          sort_round: round,
          competition: 'league',
        };
      }

      const roundNumber = getTournamentRoundNumberFromLabel(fixture?.round, 6);
      const fallbackKey = `cup-schedule:${normalizedTeamId}:${fixture?.round || roundNumber || index}`;
      return {
        ...fixture,
        game_key: fixture?.game_key || fallbackKey,
        source_game_key: fixture?.game_key || '',
        game_round: `C${roundNumber || '?'}`,
        sort_round: lastLeagueRound > 0 ? lastLeagueRound + 0.5 : index + 0.5,
        competition: 'cup',
        tournament_name: 'The Lost Cup',
        cup_round_number: roundNumber,
        cup_round_label: roundNumber ? getTournamentRoundLabel(roundNumber, 6) : fixture?.round || 'Cup',
        home_team_id: normalizeTeamId(fixture?.home_team_id) || normalizedTeamId,
        away_team_id: normalizeTeamId(fixture?.away_team_id) || '',
        home_team_name: fixture?.home_team_name || 'TBD',
        away_team_name: fixture?.away_team_name || 'TBD',
      };
    });
};

export const fetchLeagueTableTeams = async (leagueId) => {
  const payload = await fetchJsonOrThrow(
    `/soccer/league/${encodeURIComponent(String(leagueId))}/table`,
    'League table not found.',
  );

  const rows = payload?.rows || [];
  const teams = rows
    .map((row, index) => {
      const teamId = normalizeTeamId(row?.team_id);
      if (!teamId) return null;
      return {
        leagueId: String(leagueId),
        teamId,
        teamName: row?.team_name || teamId,
        currentRank: index + 1,
        currentPoints: Number(row?.points ?? 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.teamName.localeCompare(b.teamName));

  return {
    leagueId: String(leagueId),
    leagueName: payload?.league?.name || `League ${leagueId}`,
    teams,
  };
};

export const fetchTeamActiveBoosts = async (teamId) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId for boost fetch.');
  }

  const payload = await fetchJsonOrThrow(
    `/soccer/team/${encodeURIComponent(normalizedTeamId)}/boosts`,
    'Team boosts not found.',
  );

  return Array.isArray(payload?.boosts) ? payload.boosts : [];
};

export const fetchTeamBoostCooldown = async (teamId) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId for boost cooldown fetch.');
  }

  const payload = await fetchJsonOrThrow(
    `/soccer/team/${encodeURIComponent(normalizedTeamId)}/boosts/cooldown`,
    'Team boost cooldown not found.',
  );
  const cooldown = typeof payload?.cooldown === 'string' ? payload.cooldown : null;
  return Number.isFinite(new Date(cooldown || '').getTime()) ? cooldown : null;
};

export const fetchTeamBoostEffectiveness = async (teamId, leagueId, season) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId for boost effectiveness fetch.');
  }

  const normalizedLeagueId = String(leagueId || '').trim();
  if (!normalizedLeagueId) {
    throw new Error('Missing leagueId for boost effectiveness fetch.');
  }

  const normalizedSeason = normalizeSeasonValue(season);
  const payload = await fetchJsonOrThrow(
    `/soccer/team/${encodeURIComponent(normalizedTeamId)}/league/${encodeURIComponent(normalizedLeagueId)}/season/${encodeURIComponent(String(normalizedSeason))}/days-boosted`,
    'Team boost effectiveness not found.',
  );

  return {
    days_boosted: Number(payload?.days_boosted ?? 0),
    boost_effectiveness: Number(payload?.boost_effectiveness ?? 100),
  };
};

export const fetchTeamBoostState = async ({ teamId, leagueId, season }) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId for boost state fetch.');
  }

  const normalizedLeagueId = String(leagueId || '').trim();
  if (!normalizedLeagueId) {
    throw new Error('Missing leagueId for boost state fetch.');
  }

  const normalizedSeason = normalizeSeasonValue(season);
  const [boosts, effectiveness, cooldownUntil] = await Promise.all([
    fetchTeamActiveBoosts(normalizedTeamId),
    fetchTeamBoostEffectiveness(normalizedTeamId, normalizedLeagueId, normalizedSeason),
    fetchTeamBoostCooldown(normalizedTeamId).catch(() => null),
  ]);

  return {
    source: 'live',
    daysBoosted: Number(effectiveness?.days_boosted ?? 0),
    effectivenessPct: Number(effectiveness?.boost_effectiveness ?? 100),
    cooldownUntil,
    boosts: Array.isArray(boosts) ? boosts : [],
    fetchError: null,
  };
};

export const resolveOwnedTeamLeagues = (heldAssetIds, leagueIndex) => {
  const assets = heldAssetIds instanceof Set
    ? heldAssetIds
    : new Set(Array.from(heldAssetIds || []));

  const ownedTeams = (leagueIndex?.allTeams || []).filter((team) => {
    const assetId = teamIdToAssetId(team.teamId);
    return assetId ? assets.has(String(assetId)) : false;
  });

  const ownedTeamIds = ownedTeams.map((team) => team.teamId);
  const ownedLeagueIds = Array.from(new Set(ownedTeams.map((team) => team.leagueId)));
  const preferredLeagueId = ownedLeagueIds
    .slice()
    .sort((a, b) => Number(a) - Number(b))[0] || null;

  return { ownedTeams, ownedTeamIds, ownedLeagueIds, preferredLeagueId };
};

export const findTeamsByName = (teams, query) => {
  const safeTeams = Array.isArray(teams) ? teams : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return safeTeams;
  }

  return safeTeams
    .map((team) => {
      const name = String(team?.teamName || '').toLowerCase();
      let score = 0;
      if (name === q) score = 4;
      else if (name.startsWith(q)) score = 3;
      else if (name.includes(q)) score = 2;
      else score = 0;
      return { team, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.team.teamName.localeCompare(b.team.teamName);
    })
    .map((entry) => entry.team);
};

export const importOpponentFromTeamInput = async (input) => {
  const teamId = extractTeamIdFromInput(input);
  const payload = await fetchTeamPayload(teamId);
  const mapped = mapTeamPayloadToPlayers(teamId, payload);

  if (!hasActivePlayableLineup(mapped.players)) {
    throw new Error('No active lineup found for this team.');
  }

  return mapped;
};

export const fetchTeamLineup = async (teamId) => {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    throw new Error('Invalid teamId.');
  }

  const payload = await fetchTeamPayload(normalizedTeamId);
  const mapped = mapTeamPayloadToPlayers(normalizedTeamId, payload);

  if (!hasActivePlayableLineup(mapped.players)) {
    throw new Error('No active lineup found for this team.');
  }

  return mapped;
};
