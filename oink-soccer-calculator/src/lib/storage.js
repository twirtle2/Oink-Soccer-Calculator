const STORAGE_KEY = 'oink-soccer-calc:v2';

const DEFAULT_STATE = {
  mySquad: [],
  myTeam: [],
  opponentTeam: [],
  myForm: 'Pyramid',
  oppForm: 'Pyramid',
  myBoost: 'None',
  myBoostApps: 1,
  homeAdvantage: 'home',
  walletSyncMeta: {
    lastSyncedAt: null,
    matchedCount: 0,
    unmatchedCount: 0,
    lastError: null,
  },
};

const VALID_PLAYER_SOURCES = new Set(['wallet', 'manual', 'upload']);

const normalizePlayer = (player) => {
  if (!player || typeof player !== 'object') {
    return player;
  }

  let source = player.source;
  if (!VALID_PLAYER_SOURCES.has(source)) {
    source = 'manual';
  }

  return { ...player, source };
};

const normalizeArray = (arr) => {
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.map(normalizePlayer).filter(Boolean);
};

export const loadCalculatorState = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }

    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      mySquad: normalizeArray(parsed.mySquad),
      myTeam: normalizeArray(parsed.myTeam),
      opponentTeam: normalizeArray(parsed.opponentTeam),
      walletSyncMeta: {
        ...DEFAULT_STATE.walletSyncMeta,
        ...(parsed.walletSyncMeta || {}),
      },
    };
  } catch (error) {
    console.error('Failed to load saved calculator state', error);
    return DEFAULT_STATE;
  }
};

export const saveCalculatorState = (state) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const safeState = {
      ...DEFAULT_STATE,
      ...state,
      mySquad: normalizeArray(state.mySquad),
      myTeam: normalizeArray(state.myTeam),
      opponentTeam: normalizeArray(state.opponentTeam),
      walletSyncMeta: {
        ...DEFAULT_STATE.walletSyncMeta,
        ...(state.walletSyncMeta || {}),
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safeState));
  } catch (error) {
    console.error('Failed to save calculator state', error);
  }
};

export const calculatorStorageDefaults = DEFAULT_STATE;
