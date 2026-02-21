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

const mapTeamPayloadToPlayers = (teamId, payload) => {
  const slots = payload?.team_selection?.slots || {};
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

    return {
      id: `teamurl:${teamId}:${slotKey}`,
      name,
      pos,
      stats,
      ovr,
      injury: null,
      source: 'team-url',
      imageUrl: slot.asset?.image_url || slot.asset?.image || attrs.image_url || null,
    };
  });

  const formationLabel = payload?.team?.formation || '';
  const formationKey = deriveFormationKey(formationLabel);
  const teamLabel = payload?.team?.custom_name || payload?.team?.id || teamId;

  return {
    teamId,
    teamLabel,
    formationLabel,
    formationKey,
    players,
  };
};

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

export const importOpponentFromTeamInput = async (input) => {
  const teamId = extractTeamIdFromInput(input);
  const payload = await fetchTeamPayload(teamId);
  const mapped = mapTeamPayloadToPlayers(teamId, payload);

  if (mapped.players.length === 0) {
    throw new Error('No active lineup found for this team.');
  }

  return mapped;
};
