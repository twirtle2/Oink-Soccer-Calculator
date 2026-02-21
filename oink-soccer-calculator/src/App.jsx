import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Upload, Image as ImageIcon, Bandage, X, TrendingUp, ChevronDown, ChevronUp, RefreshCw, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import { fetchHeldAssetIdsForAddresses } from './lib/indexer';
import { buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import { parseOpponentScreenshotsLocally } from './lib/localScreenshotParser';

// --- Game Constants ---
const POSITIONS = {
  GK: { label: 'Goalkeeper', short: 'GK', color: 'from-yellow-500 to-yellow-600' },
  DF: { label: 'Defender', short: 'DF', color: 'from-blue-500 to-blue-600' },
  MF: { label: 'Midfielder', short: 'MF', color: 'from-emerald-500 to-emerald-600' },
  FW: { label: 'Forward', short: 'FW', color: 'from-red-500 to-red-600' },
};

const FORMATIONS = {
  Pyramid: {
    name: "The Pyramid (2-1-1)",
    style: "DEF",
    defMod: 1.04, ctlMod: 0.97, attMod: 0.94,
    structure: { GK: 1, DF: 2, MF: 1, FW: 1 }
  },
  Diamond: {
    name: "The Diamond (1-2-1)",
    style: "BAL",
    defMod: 0.92, ctlMod: 1.015, attMod: 0.92,
    structure: { GK: 1, DF: 1, MF: 2, FW: 1 }
  },
  Y: {
    name: "The Y (1-1-2)",
    style: "ATT",
    defMod: 0.96, ctlMod: 0.98, attMod: 1.04,
    structure: { GK: 1, DF: 1, MF: 1, FW: 2 }
  },
  Box: {
    name: "The Box (2-0-2)",
    style: "BAL",
    defMod: 1.07, ctlMod: 1.0, attMod: 1.06,
    structure: { GK: 1, DF: 2, MF: 0, FW: 2 }
  },
};

// --- Event Count Logic (Home/Away Bias) ---
const FORMATION_CHANCE_RANGES = {
  "HOME:ATT|AWAY:ATT": { min: 7, max: 15 },
  "HOME:ATT|AWAY:BAL": { min: 6, max: 12 },
  "HOME:ATT|AWAY:DEF": { min: 5, max: 11 },

  "HOME:BAL|AWAY:ATT": { min: 7, max: 12 },
  "HOME:BAL|AWAY:BAL": { min: 4, max: 9 },
  "HOME:BAL|AWAY:DEF": { min: 3, max: 8 },

  "HOME:DEF|AWAY:ATT": { min: 6, max: 11 },
  "HOME:DEF|AWAY:BAL": { min: 3, max: 8 },
  "HOME:DEF|AWAY:DEF": { min: 2, max: 6 },
};

const getAverageEvents = (homeFormKey, awayFormKey) => {
  const homeStyle = FORMATIONS[homeFormKey]?.style || 'BAL';
  const awayStyle = FORMATIONS[awayFormKey]?.style || 'BAL';
  const key = `HOME:${homeStyle}|AWAY:${awayStyle}`;

  const range = FORMATION_CHANCE_RANGES[key] || { min: 3, max: 10 };
  return (range.min + range.max) / 2;
};

const INJURIES = {
  None: { label: 'Healthy', reduction: 1.0, color: 'bg-green-500', text: 'text-green-400' },
  Low: { label: 'Minor (95%)', reduction: 0.95, color: 'bg-yellow-500', text: 'text-yellow-400' },
  Mid: { label: 'Moderate (90%)', reduction: 0.90, color: 'bg-orange-500', text: 'text-orange-400' },
  High: { label: 'Severe (85%)', reduction: 0.85, color: 'bg-red-600', text: 'text-red-400' },
};

const BOOSTS = {
  None: { label: 'No Boost', type: 'None', min: 1.0, max: 1.0 },
  MagicTruffle: { label: 'Magic Truffle (1-5%)', type: 'All', min: 1.01, max: 1.05 },
  GoldenTruffle: { label: 'Golden Truffle (3-7%)', type: 'All', min: 1.03, max: 1.07 },
  IridiumTruffle: { label: 'Iridium Truffle (10%)', type: 'All', min: 1.10, max: 1.10 },
  HalftimeOrange: { label: 'Half-time Orange (3-7%)', type: 'CTL', min: 1.03, max: 1.07 },
};

const DR_DECAY = 0.97;
const DR_MIN = 0.35;

const calculateBoostMultiplier = (boostKey, applications = 1) => {
  if (boostKey === 'None' || !BOOSTS[boostKey]) return 1.0;
  const boost = BOOSTS[boostKey];
  const baseBoost = (boost.min + boost.max) / 2;

  // If only 1 person applies it, it's 100% effective (no decay)
  if (applications <= 1) return baseBoost;

  // Decay starts from the 2nd application onwards? 
  // Actually, usually "1 application" = 100% effective.
  // "2 applications" = 97% effective? Or is it 0.97^2?
  // Let's assume 1 application = 100% (multiplier 1.0)

  let m = Math.pow(DR_DECAY, applications - 1); // Shifted so 1 app = 1.0
  if (m < DR_MIN) m = DR_MIN;

  if (baseBoost >= 1.0) {
    return 1.0 + (baseBoost - 1.0) * m;
  }
  return baseBoost * m;
};

// --- Math Functions ---
const getControlScore = (stats, pos, injuryMod = 1.0, boostMults = {}) => {
  const spd = stats.SPD * (boostMults.SPD || 1.0);
  const ctl = stats.CTL * (boostMults.CTL || 1.0);
  return Math.round((((ctl * 4) + spd) / 5) * injuryMod);
};

const getAttackScore = (stats, pos, injuryMod = 1.0, boostMults = {}) => {
  const spd = stats.SPD * (boostMults.SPD || 1.0);
  const att = stats.ATT * (boostMults.ATT || 1.0);
  return Math.round((((att * 3) + spd) / 4) * injuryMod);
};

const getDefenseScore = (stats, pos, injuryMod = 1.0, boostMults = {}) => {
  const spd = stats.SPD * (boostMults.SPD || 1.0);
  const def = (pos === 'GK' ? stats.GKP : stats.DEF) * (boostMults[pos === 'GK' ? 'GKP' : 'DEF'] || 1.0);
  return Math.round((((def * 5) + spd) / 6) * injuryMod);
};

const getOfficialOvr = (stats, pos) => {
  if (pos === 'GK') return Math.round(((stats.GKP * 5) + stats.SPD) / 6);
  if (pos === 'DF') return Math.round(((stats.DEF * 5) + stats.SPD) / 6);
  if (pos === 'MF') return Math.round(((stats.CTL * 4) + stats.SPD) / 5);
  if (pos === 'FW') return Math.round(((stats.ATT * 3) + stats.SPD) / 4);
  return 0;
};

const calculateTeamScores = (players, formationKey, activeBoost, boostApps) => {
  const form = FORMATIONS[formationKey];

  const boostType = BOOSTS[activeBoost]?.type || 'None';
  const mult = calculateBoostMultiplier(activeBoost, boostApps);

  const boostMults = {
    CTL: (boostType === 'All' || boostType === 'CTL') ? mult : 1.0,
    ATT: (boostType === 'All') ? mult : 1.0,
    DEF: (boostType === 'All') ? mult : 1.0,
    SPD: (boostType === 'All') ? mult : 1.0,
    GKP: (boostType === 'All') ? mult : 1.0,
  };

  const stats = {
    Control: 0, Defense: 0, Attack: 0,
    AvgControl: 0, AvgDefense: 0, AvgAttack: 0,
    Count: players.length
  };

  if (players.length === 0) return stats;

  const byPos = { GK: [], DF: [], MF: [], FW: [] };
  players.forEach(p => {
    if (byPos[p.pos]) byPos[p.pos].push(p);
  });

  const getAvgWithInjury = (list, scoreFn) => {
    if (list.length === 0) return 0;
    return list.reduce((sum, p) => {
      const mod = p.injury && INJURIES[p.injury] ? INJURIES[p.injury].reduction : 1.0;
      return sum + scoreFn(p.stats, p.pos, mod, boostMults);
    }, 0) / list.length;
  }

  const avgCtl = {
    GK: getAvgWithInjury(byPos.GK, getControlScore),
    DF: getAvgWithInjury(byPos.DF, getControlScore),
    MF: getAvgWithInjury(byPos.MF, getControlScore),
    FW: getAvgWithInjury(byPos.FW, getControlScore)
  };

  const avgDef = {
    GK: getAvgWithInjury(byPos.GK, getDefenseScore),
    DF: getAvgWithInjury(byPos.DF, getDefenseScore),
    MF: getAvgWithInjury(byPos.MF, getDefenseScore),
    FW: getAvgWithInjury(byPos.FW, getDefenseScore)
  };

  const avgAtt = {
    GK: getAvgWithInjury(byPos.GK, getAttackScore),
    DF: getAvgWithInjury(byPos.DF, getAttackScore),
    MF: getAvgWithInjury(byPos.MF, getAttackScore),
    FW: getAvgWithInjury(byPos.FW, getAttackScore)
  };

  let ctlWeights, defWeights;

  if (formationKey === 'Box') {
    ctlWeights = { GK: 0.05, DF: 0.35, MF: 0.00, FW: 0.60 };
    defWeights = { GK: 0.35, DF: 0.50, MF: 0.00, FW: 0.15 };
  } else {
    ctlWeights = { GK: 0.05, DF: 0.15, MF: 0.65, FW: 0.15 };
    defWeights = { GK: 0.35, DF: 0.40, MF: 0.20, FW: 0.05 };
  }

  const rawControl =
    (avgCtl.GK * ctlWeights.GK) +
    (avgCtl.DF * ctlWeights.DF) +
    (avgCtl.MF * ctlWeights.MF) +
    (avgCtl.FW * ctlWeights.FW);

  const rawDefense =
    (avgDef.GK * defWeights.GK) +
    (avgDef.DF * defWeights.DF) +
    (avgDef.MF * defWeights.MF) +
    (avgDef.FW * defWeights.FW);

  stats.Control = rawControl * form.ctlMod;

  const DEFENSE_BIAS_MULTIPLIER = 1.05;
  stats.Defense = Math.min(100, rawDefense * form.defMod * DEFENSE_BIAS_MULTIPLIER);

  const attChanceWeights = formationKey === 'Box'
    ? { FW: 0.7, DF: 0.2, GK: 0.1 }
    : { FW: 0.6, MF: 0.3, DF: 0.1, GK: 0 };

  stats.Attack =
    ((avgAtt.FW * (attChanceWeights.FW || 0)) +
      (avgAtt.MF * (attChanceWeights.MF || 0)) +
      (avgAtt.DF * (attChanceWeights.DF || 0))) * form.attMod;

  stats.Control = parseFloat(stats.Control.toFixed(1));
  stats.Defense = parseFloat(stats.Defense.toFixed(1));
  stats.Attack = parseFloat(stats.Attack.toFixed(1));

  return stats;
};

// --- Initial Fallback Data ---
const initialMyTeam = [];

const initialOpponent = [];

const createImportDraftPlayer = (player = {}, index = 0) => {
  const pos = ['GK', 'DF', 'MF', 'FW'].includes(player.pos) ? player.pos : 'FW';
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${index}`,
    name: player.name || '',
    pos,
    stats: {
      SPD: Number.isFinite(player.stats?.SPD) ? player.stats.SPD : 50,
      ATT: Number.isFinite(player.stats?.ATT) ? player.stats.ATT : (pos === 'GK' ? 0 : 50),
      CTL: Number.isFinite(player.stats?.CTL) ? player.stats.CTL : 50,
      DEF: Number.isFinite(player.stats?.DEF) ? player.stats.DEF : 50,
      GKP: Number.isFinite(player.stats?.GKP) ? player.stats.GKP : (pos === 'GK' ? 50 : 0),
    },
  };
};

const ensureDraftSize = (rows, size = 5) => {
  const next = [...rows];
  while (next.length < size) {
    next.push(createImportDraftPlayer({ name: '', pos: 'FW', stats: { SPD: 50, ATT: 50, CTL: 50, DEF: 50, GKP: 0 } }, next.length));
  }
  return next.slice(0, size);
};


export default function OinkSoccerCalc() {
  const { wallets } = useWallet();
  const persistedState = useMemo(() => loadCalculatorState(), []);
  const autoSyncedAddressKeyRef = useRef('');

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [showImportReview, setShowImportReview] = useState(false);
  const [importDraftPlayers, setImportDraftPlayers] = useState([]);
  const [importDraftFormation, setImportDraftFormation] = useState('Pyramid');
  const [walletSyncing, setWalletSyncing] = useState(false);

  const [mySquad, setMySquad] = useState(persistedState.mySquad || initialMyTeam); // Full roster
  const [myTeam, setMyTeam] = useState(persistedState.myTeam || initialMyTeam.slice(0, 5)); // Active 5
  const [opponentTeam, setOpponentTeam] = useState(persistedState.opponentTeam || initialOpponent);
  const [myForm, setMyForm] = useState(persistedState.myForm || 'Pyramid');
  const [oppForm, setOppForm] = useState(persistedState.oppForm || 'Pyramid');

  const [myBoost, setMyBoost] = useState(persistedState.myBoost || 'None');
  const [myBoostApps, setMyBoostApps] = useState(persistedState.myBoostApps || 1);
  const [homeAdvantage, setHomeAdvantage] = useState(persistedState.homeAdvantage || 'home'); // 'home' or 'away'
  const [walletSyncMeta, setWalletSyncMeta] = useState(
    persistedState.walletSyncMeta || {
      lastSyncedAt: null,
      matchedCount: 0,
      unmatchedCount: 0,
      lastError: null,
    },
  );

  const [activeTab, setActiveTab] = useState('simulation');
  const [editingId, setEditingId] = useState(null);
  const [formTarget, setFormTarget] = useState('mySquad');
  const [showManualForm, setShowManualForm] = useState(false);

  // --- Sorting & Filtering State ---
  const [benchFilter, setBenchFilter] = useState('All');
  const [benchSort, setBenchSort] = useState('ovr_desc'); // 'ovr_desc' or 'ovr_asc'

  const [newPlayer, setNewPlayer] = useState({
    name: '', pos: 'FW',
    stats: { DEF: 50, CTL: 50, ATT: 50, SPD: 50, GKP: 0 },
    injury: null
  });

  const [suggestions, setSuggestions] = useState({});
  const [analyzing, setAnalyzing] = useState(false);

  const connectedAddresses = useMemo(() => {
    const addresses = new Set();
    for (const wallet of wallets) {
      if (!wallet.isConnected) continue;
      for (const account of wallet.accounts) {
        addresses.add(account.address);
      }
    }
    return Array.from(addresses);
  }, [wallets]);

  const connectedAddressKey = useMemo(
    () => [...connectedAddresses].sort().join('|'),
    [connectedAddresses],
  );

  useEffect(() => {
    // Auto set form target based on tab
    if (activeTab === 'myTeam') setFormTarget('mySquad');
    if (activeTab === 'opponent') setFormTarget('opponent');
  }, [activeTab]);

  const saveToDb = useCallback((overrides = {}) => {
    saveCalculatorState({
      mySquad: overrides.mySquad !== undefined ? overrides.mySquad : mySquad,
      myTeam: overrides.myTeam !== undefined ? overrides.myTeam : myTeam,
      opponentTeam: overrides.opponentTeam !== undefined ? overrides.opponentTeam : opponentTeam,
      myForm: overrides.myForm !== undefined ? overrides.myForm : myForm,
      oppForm: overrides.oppForm !== undefined ? overrides.oppForm : oppForm,
      myBoost: overrides.myBoost !== undefined ? overrides.myBoost : myBoost,
      myBoostApps: overrides.myBoostApps !== undefined ? overrides.myBoostApps : myBoostApps,
      homeAdvantage: overrides.homeAdvantage !== undefined ? overrides.homeAdvantage : homeAdvantage,
      walletSyncMeta: overrides.walletSyncMeta !== undefined ? overrides.walletSyncMeta : walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myBoost, myBoostApps, homeAdvantage, walletSyncMeta]);

  useEffect(() => {
    saveCalculatorState({
      mySquad,
      myTeam,
      opponentTeam,
      myForm,
      oppForm,
      myBoost,
      myBoostApps,
      homeAdvantage,
      walletSyncMeta,
    });
  }, [mySquad, myTeam, opponentTeam, myForm, oppForm, myBoost, myBoostApps, homeAdvantage, walletSyncMeta]);

  const myStats = useMemo(() => calculateTeamScores(myTeam, myForm, myBoost, myBoostApps), [myTeam, myForm, myBoost, myBoostApps]);
  const oppStats = useMemo(() => calculateTeamScores(opponentTeam, oppForm, 'None', 1), [opponentTeam, oppForm]);

  const simulation = useMemo(() => {
    if (myStats.Count === 0 || oppStats.Count === 0) {
      return { win: '50.0', myPossession: '50', myxG: '0.00', oppxG: '0.00' };
    }

    // Home/Away modifiers
    const HOME_ATTACK_BOOST = 1.05;
    const HOME_DEFENSE_BOOST = 1.03;
    const AWAY_ATTACK_PENALTY = 0.97;
    const AWAY_DEFENSE_PENALTY = 0.98;

    // Apply modifiers based on home/away status
    const myAttackMod = homeAdvantage === 'home' ? HOME_ATTACK_BOOST : AWAY_ATTACK_PENALTY;
    const myDefenseMod = homeAdvantage === 'home' ? HOME_DEFENSE_BOOST : AWAY_DEFENSE_PENALTY;
    const oppAttackMod = homeAdvantage === 'home' ? AWAY_ATTACK_PENALTY : HOME_ATTACK_BOOST;
    const oppDefenseMod = homeAdvantage === 'home' ? AWAY_DEFENSE_PENALTY : HOME_DEFENSE_BOOST;

    const myModifiedAttack = myStats.Attack * myAttackMod;
    const myModifiedDefense = myStats.Defense * myDefenseMod;
    const oppModifiedAttack = oppStats.Attack * oppAttackMod;
    const oppModifiedDefense = oppStats.Defense * oppDefenseMod;

    const totalControl = myStats.Control + oppStats.Control;
    const myPossession = totalControl === 0 ? 0.5 : (myStats.Control / totalControl);

    const calcGoalProb = (att, def) => {
      const ratio = def === 0 ? 2 : att / def;
      return Math.max(0.01, Math.min(0.9, 0.15 * (ratio ** 1.5)));
    };

    const myGoalProb = calcGoalProb(myModifiedAttack, oppModifiedDefense);
    const oppGoalProb = calcGoalProb(oppModifiedAttack, myModifiedDefense);

    const AVG_EVENTS = getAverageEvents(myForm, oppForm);
    const myEvents = AVG_EVENTS * myPossession;
    const oppEvents = AVG_EVENTS * (1 - myPossession);

    const myxG = myEvents * myGoalProb;
    const oppxG = oppEvents * oppGoalProb;

    const totalxG = myxG + oppxG;
    const winProb = totalxG === 0 ? 50 : (myxG / totalxG) * 100;

    return {
      win: winProb.toFixed(1),
      myPossession: (myPossession * 100).toFixed(0),
      myxG: myxG.toFixed(2),
      oppxG: oppxG.toFixed(2)
    };
  }, [myStats, oppStats, homeAdvantage, myForm, oppForm]);

  const formationMismatch = useMemo(() => {
    if (myTeam.length === 0) return null;
    const form = FORMATIONS[myForm];
    if (!form) return null;

    const counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
    myTeam.forEach(p => {
      if (counts[p.pos] !== undefined) counts[p.pos]++;
    });

    const struct = form.structure;
    const mismatches = [];

    if (counts.GK !== struct.GK) mismatches.push(`GK: ${counts.GK}/${struct.GK}`);
    if (counts.DF !== struct.DF) mismatches.push(`DF: ${counts.DF}/${struct.DF}`);
    if (counts.MF !== struct.MF) mismatches.push(`MF: ${counts.MF}/${struct.MF}`);
    if (counts.FW !== struct.FW) mismatches.push(`FW: ${counts.FW}/${struct.FW}`);

    if (mismatches.length > 0) {
      return `Formation Mismatch: ${mismatches.join(', ')}`;
    }
    return null;
  }, [myTeam, myForm]);

  const handleSyncWalletAssets = useCallback(async (addressesOverride = connectedAddresses) => {
    const addressesToSync = Array.from(new Set((addressesOverride || []).filter(Boolean)));
    if (addressesToSync.length === 0 || walletSyncing) {
      return;
    }

    setWalletSyncing(true);
    const nextMeta = {
      ...walletSyncMeta,
      lastError: null,
    };
    setWalletSyncMeta(nextMeta);

    try {
      const [catalogByAssetId, heldAssetIds] = await Promise.all([
        loadPlayableCatalog(),
        fetchHeldAssetIdsForAddresses(addressesToSync),
      ]);

      const { walletPlayers, matchedCount, unmatchedCount } = buildWalletPlayers(heldAssetIds, catalogByAssetId);
      const { nextSquad, nextTeam } = mergeWalletPlayers({ mySquad, myTeam, walletPlayers });

      const updatedMeta = {
        lastSyncedAt: new Date().toISOString(),
        matchedCount,
        unmatchedCount,
        lastError: null,
      };

      setMySquad(nextSquad);
      setMyTeam(nextTeam);
      setWalletSyncMeta(updatedMeta);
      saveToDb({ mySquad: nextSquad, myTeam: nextTeam, walletSyncMeta: updatedMeta });
    } catch (error) {
      const updatedMeta = {
        ...nextMeta,
        lastError: error instanceof Error ? error.message : 'Wallet sync failed',
      };
      setWalletSyncMeta(updatedMeta);
      saveToDb({ walletSyncMeta: updatedMeta });
    } finally {
      setWalletSyncing(false);
    }
  }, [connectedAddresses, mySquad, myTeam, saveToDb, walletSyncMeta, walletSyncing]);

  useEffect(() => {
    if (!connectedAddressKey) {
      autoSyncedAddressKeyRef.current = '';
      return;
    }

    if (walletSyncing || autoSyncedAddressKeyRef.current === connectedAddressKey) {
      return;
    }

    autoSyncedAddressKeyRef.current = connectedAddressKey;
    void handleSyncWalletAssets(connectedAddresses);
  }, [connectedAddressKey, connectedAddresses, handleSyncWalletAssets, walletSyncing]);

  const handleImportDraftChange = (id, key, value) => {
    setImportDraftPlayers((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [key]: value } : row)),
    );
  };

  const handleImportDraftStatChange = (id, statKey, value) => {
    const parsed = Number.parseInt(value, 10);
    const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;

    setImportDraftPlayers((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        return {
          ...row,
          stats: {
            ...row.stats,
            [statKey]: clamped,
          },
        };
      }),
    );
  };

  const handleApplyImportDraft = () => {
    const normalized = ensureDraftSize(importDraftPlayers, 5).map((row, idx) => {
      const pos = ['GK', 'DF', 'MF', 'FW'].includes(row.pos) ? row.pos : 'FW';
      const stats = {
        SPD: Math.max(0, Math.min(100, Number.parseInt(row.stats?.SPD, 10) || 50)),
        ATT: Math.max(0, Math.min(100, Number.parseInt(row.stats?.ATT, 10) || (pos === 'GK' ? 0 : 50))),
        CTL: Math.max(0, Math.min(100, Number.parseInt(row.stats?.CTL, 10) || 50)),
        DEF: Math.max(0, Math.min(100, Number.parseInt(row.stats?.DEF, 10) || 50)),
        GKP: Math.max(0, Math.min(100, Number.parseInt(row.stats?.GKP, 10) || (pos === 'GK' ? 50 : 0))),
      };

      return {
        id: Date.now() + Math.random() + idx,
        name: row.name?.trim() || `Opponent ${idx + 1}`,
        pos,
        stats,
        ovr: getOfficialOvr(stats, pos),
        injury: null,
        source: 'upload',
      };
    });

    const nextFormation = Object.keys(FORMATIONS).includes(importDraftFormation) ? importDraftFormation : 'Pyramid';
    setOppForm(nextFormation);
    setOpponentTeam(normalized);
    saveToDb({ opponentTeam: normalized, oppForm: nextFormation });
    setShowImportReview(false);
    setUploadStatus({
      tone: 'success',
      message: `Applied ${normalized.length} reviewed opponent players in ${FORMATIONS[nextFormation].name}.`,
    });
  };

  const handleCancelImportDraft = () => {
    setShowImportReview(false);
    setImportDraftPlayers([]);
  };

  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress(0);
    setUploadStatus({ tone: 'info', message: `Processing ${files.length} screenshot(s)...` });

    try {
      const localResult = await parseOpponentScreenshotsLocally(files, (done, total) => {
        setUploadProgress(Math.round((done / total) * 100));
      });

      const detectedRows = localResult.players.slice(0, 5).map((player, index) => createImportDraftPlayer(player, index));
      const nextDraft = ensureDraftSize(detectedRows, 5);
      const nextFormation = Object.keys(FORMATIONS).includes(localResult.detectedFormationKey)
        ? localResult.detectedFormationKey
        : 'Pyramid';

      setImportDraftPlayers(nextDraft);
      setImportDraftFormation(nextFormation);
      setShowImportReview(true);

      if (localResult.players.length === 0) {
        setUploadStatus({
          tone: 'error',
          message: 'Auto-detection missed this screenshot. Update the 5 rows below and click Apply Opponent.',
        });
      } else {
        setUploadStatus({
          tone: 'info',
          message: `Detected ${localResult.players.length} player(s) with free local OCR. Review and click Apply Opponent.`,
        });
      }
    } catch (err) {
      console.error("Screenshot import failed:", err);
      setUploadStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Screenshot import failed. Fill manual entries below.',
      });
      const fallbackDraft = ensureDraftSize([], 5);
      setImportDraftPlayers(fallbackDraft);
      setImportDraftFormation('Pyramid');
      setShowImportReview(true);
    } finally {
      setUploading(false);
      e.target.value = null;
    }
  };

  const handleFormChange = (type, val) => {
    if (type === 'my') {
      setMyForm(val);
      saveToDb({ myForm: val });
    } else {
      setOppForm(val);
      saveToDb({ oppForm: val });
    }
  };

  const handleBoostChange = (boostType) => {
    setMyBoost(boostType);
    saveToDb({ myBoost: boostType });
  }

  const handleBoostAppsChange = (val) => {
    const num = Math.max(1, Math.min(20, parseInt(val) || 1));
    setMyBoostApps(num);
    saveToDb({ myBoostApps: num });
  }

  const handleHomeAwayToggle = (value) => {
    setHomeAdvantage(value);
    saveToDb({ homeAdvantage: value });
  }

  const handleEditPlayer = (player, teamType) => {
    setEditingId(player.id);
    setNewPlayer({
      name: player.name,
      pos: player.pos,
      stats: { ...player.stats },
      injury: player.injury || 'None'
    });
    setFormTarget(teamType === 'myTeam' ? 'mySquad' : teamType);
    setShowManualForm(true);
    const formEl = document.getElementById('player-form');
    if (formEl) formEl.scrollIntoView({ behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setNewPlayer({ name: '', pos: 'FW', stats: { DEF: 50, CTL: 50, ATT: 50, SPD: 50, GKP: 0 }, injury: null });
    setShowManualForm(false);
  };

  const handleSavePlayer = () => {
    const isMySquad = formTarget === 'mySquad';
    const currentList = isMySquad ? mySquad : opponentTeam;
    const existingPlayer = editingId ? currentList.find(item => item.id === editingId) : null;

    const p = {
      ...newPlayer,
      id: editingId || Date.now(),
      ovr: getOfficialOvr(newPlayer.stats, newPlayer.pos),
      injury: newPlayer.injury === 'None' ? null : newPlayer.injury,
      source: existingPlayer?.source || 'manual'
    };

    let newList;
    if (editingId) {
      newList = currentList.map(item => item.id === editingId ? p : item);
      if (isMySquad) {
        const newActive = myTeam.map(item => item.id === editingId ? p : item);
        setMyTeam(newActive);
        saveToDb({ myTeam: newActive });
      }
    } else {
      newList = [...currentList, p];
    }

    if (isMySquad) {
      setMySquad(newList);
      saveToDb({ mySquad: newList });
    } else {
      setOpponentTeam(newList);
      saveToDb({ opponentTeam: newList });
    }

    handleCancelEdit();
  };

  const handleRemove = (id, teamType) => {
    if (teamType === 'mySquad' || teamType === 'myTeam') {
      const newSquad = mySquad.filter(p => p.id !== id);
      const newActive = myTeam.filter(p => p.id !== id);
      setMySquad(newSquad);
      setMyTeam(newActive);
      saveToDb({ mySquad: newSquad, myTeam: newActive });
    } else {
      const newList = opponentTeam.filter(p => p.id !== id);
      setOpponentTeam(newList);
      saveToDb({ opponentTeam: newList });
    }

    if (editingId === id) handleCancelEdit();
  };

  const handleStatChange = (k, v) => setNewPlayer(prev => ({ ...prev, stats: { ...prev.stats, [k]: parseInt(v) || 0 } }));

  const handleInjuryChange = (player, severity, teamType) => {
    const isMySide = teamType === 'myTeam' || teamType === 'mySquad';

    if (isMySide) {
      const newSquad = mySquad.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setMySquad(newSquad);
      const newActive = myTeam.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setMyTeam(newActive);

      saveToDb({ mySquad: newSquad, myTeam: newActive });
    } else {
      const newList = opponentTeam.map(p => p.id === player.id ? { ...p, injury: severity === 'None' ? null : severity } : p);
      setOpponentTeam(newList);
      saveToDb({ opponentTeam: newList });
    }
  }

  const handleSwap = (benchPlayer) => {
    if (myTeam.find(p => p.id === benchPlayer.id)) {
      const newActive = myTeam.filter(p => p.id !== benchPlayer.id);
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
      return;
    }

    if (myTeam.length < 5) {
      const newActive = [...myTeam, benchPlayer];
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
      return;
    }

    const samePosIndex = myTeam.findIndex(p => p.pos === benchPlayer.pos);
    if (samePosIndex !== -1) {
      const newActive = [...myTeam];
      newActive[samePosIndex] = benchPlayer;
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
    } else {
      const newActive = [...myTeam];
      newActive[4] = benchPlayer;
      setMyTeam(newActive);
      saveToDb({ myTeam: newActive });
    }
  };

  // --- Bench Sort & Filter ---
  const toggleSort = () => {
    setBenchSort(prev => prev === 'ovr_desc' ? 'ovr_asc' : 'ovr_desc');
  };

  const benchPlayers = useMemo(() => {
    const activeIds = new Set(myTeam.map(p => p.id));
    let players = mySquad.filter(p => !activeIds.has(p.id));

    // Filter
    if (benchFilter !== 'All') {
      players = players.filter(p => p.pos === benchFilter);
    }

    // Sort
    players.sort((a, b) => {
      if (benchSort === 'ovr_desc') return b.ovr - a.ovr;
      if (benchSort === 'ovr_asc') return a.ovr - b.ovr;
      return 0;
    });

    return players;
  }, [mySquad, myTeam, benchFilter, benchSort]);

  const getCombinations = (arr, k) => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];
    const [first, ...rest] = arr;
    const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = getCombinations(rest, k);
    return [...withFirst, ...withoutFirst];
  };

  const analyzeLineups = async () => {
    setAnalyzing(true);
    setSuggestions({});

    // Allow UI to update before heavy calculation
    await new Promise(resolve => setTimeout(resolve, 100));

    const currentWin = parseFloat(simulation.win);
    const bestByFormation = {};

    const byPos = { GK: [], DF: [], MF: [], FW: [] };
    mySquad.forEach(p => {
      if (byPos[p.pos]) byPos[p.pos].push(p);
    });

    // Iterate all formations
    for (const formKey of Object.keys(FORMATIONS)) {
      const structure = FORMATIONS[formKey].structure;

      // Check if we have enough players for this formation
      if (byPos.GK.length < structure.GK ||
        byPos.DF.length < structure.DF ||
        byPos.MF.length < structure.MF ||
        byPos.FW.length < structure.FW) {
        continue;
      }

      let bestForThisForm = { win: -1, lineup: [] };

      // Generate combinations for each position
      const gkCombos = getCombinations(byPos.GK, structure.GK);
      const dfCombos = getCombinations(byPos.DF, structure.DF);
      const mfCombos = getCombinations(byPos.MF, structure.MF);
      const fwCombos = getCombinations(byPos.FW, structure.FW);

      // Cartesian product of all position combos
      for (const gks of gkCombos) {
        for (const dfs of dfCombos) {
          for (const mfs of mfCombos) {
            for (const fws of fwCombos) {
              const lineup = [...gks, ...dfs, ...mfs, ...fws];

              // Calculate stats for this lineup
              const stats = calculateTeamScores(lineup, formKey, myBoost, myBoostApps);

              // Calculate win prob against CURRENT opponent
              // Re-implementing simulation logic here to avoid hook dependency issues inside loop
              const totalControl = stats.Control + oppStats.Control;
              const myPossession = totalControl === 0 ? 0.5 : (stats.Control / totalControl);

              const calcGoalProb = (att, def) => {
                const ratio = def === 0 ? 2 : att / def;
                return Math.max(0.01, Math.min(0.9, 0.15 * (ratio ** 1.5)));
              };

              const myGoalProb = calcGoalProb(stats.Attack, oppStats.Defense);
              const oppGoalProb = calcGoalProb(oppStats.Attack, stats.Defense);

              const AVG_EVENTS = getAverageEvents(formKey, oppForm);
              const myEvents = AVG_EVENTS * myPossession;
              const oppEvents = AVG_EVENTS * (1 - myPossession);

              const myxG = myEvents * myGoalProb;
              const oppxG = oppEvents * oppGoalProb;

              const totalxG = myxG + oppxG;
              const winProb = totalxG === 0 ? 50 : (myxG / totalxG) * 100;

              if (winProb > bestForThisForm.win) {
                bestForThisForm = {
                  formation: formKey,
                  lineup: lineup,
                  win: winProb,
                  diff: winProb - currentWin
                };
              }
            }
          }
        }
      }

      if (bestForThisForm.win > -1) {
        bestByFormation[formKey] = bestForThisForm;
      }
    }

    setSuggestions(bestByFormation);
    setAnalyzing(false);
  };

  const applySuggestion = (config) => {
    if (!config) return;
    setMyTeam(config.lineup);
    setMyForm(config.formation);
    saveToDb({ myTeam: config.lineup, myForm: config.formation });
    setSuggestions({});
    setActiveTab('myTeam'); // Switch to team view to see changes
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans pb-12 selection:bg-green-500/30" >
      <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-8" >

        {/* Header */}
        < div className="flex flex-col md:flex-row items-start justify-between gap-6 pb-8 border-b border-slate-800" >
          <div>
            <h1 className="text-4xl font-black text-white flex items-center gap-3 tracking-tight" >
              <span className="text-green-500" > OINK </span> ANALYZER
            </h1>
            < p className="text-slate-500 font-medium mt-1" > Advanced Engine Simulator • Wallet + Local Storage </p>
          </div>
          <div className="flex flex-col items-end gap-3 w-full md:w-auto">
            <WalletConnector
              onSync={handleSyncWalletAssets}
              isSyncing={walletSyncing}
              syncMeta={walletSyncMeta}
            />
            < div className="bg-slate-800/50 px-6 py-4 rounded-2xl border border-slate-700/50 text-center min-w-[200px] w-full md:w-auto" >
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1" > Win Probability </div>
              < div className={`text-4xl font-black ${simulation.win > 50 ? 'text-green-400' : 'text-red-400'}`
              }>
                {simulation.win} %
              </div>
              < div className="text-[10px] text-slate-500 mt-1" > Based on {Number(simulation.myxG) + Number(simulation.oppxG)} simulated goals </div>
            </div>
          </div>
        </div>

        {/* Top Bar */}
        <div className="flex flex-col xl:flex-row items-center justify-between gap-4 bg-slate-800 p-4 rounded-xl" >
          <div className="flex items-center gap-3 w-full xl:w-auto" >
            <span className="text-xs font-bold text-green-400 uppercase whitespace-nowrap" > My Formation </span>
            < select
              value={myForm}
              onChange={(e) => handleFormChange('my', e.target.value)}
              className="bg-slate-900 border border-slate-700 text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-green-500 flex-1 xl:w-48"
            >
              {Object.keys(FORMATIONS).map(k => <option key={k} value={k} > {FORMATIONS[k].name} </option>)}
            </select>
          </div>

          < div className="flex flex-wrap justify-center gap-2 w-full xl:w-auto" >
            <TabButton active={activeTab === 'simulation'} onClick={() => setActiveTab('simulation')} label="Simulation" icon={< Activity size={14} />} />
            < TabButton active={activeTab === 'myTeam'} onClick={() => setActiveTab('myTeam')} label="My Squad" icon={< Users size={14} />} />
            < TabButton active={activeTab === 'opponent'} onClick={() => setActiveTab('opponent')} label="Opponent" icon={< Users size={14} />} />
          </div>

          < div className="flex items-center gap-3 w-full xl:w-auto justify-end" >
            <span className="text-xs font-bold text-red-400 uppercase whitespace-nowrap" > Opp Formation </span>
            < select
              value={oppForm}
              onChange={(e) => handleFormChange('opp', e.target.value)}
              className="bg-slate-900 border border-slate-700 text-sm rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-500 flex-1 xl:w-48"
            >
              {Object.keys(FORMATIONS).map(k => <option key={k} value={k} > {FORMATIONS[k].name} </option>)}
            </select>
          </div>
        </div>

        {/* Boost Selection - Only show on Sim or My Team */}
        {
          (activeTab === 'simulation' || activeTab === 'myTeam') && (
            <div className="bg-slate-800 p-4 rounded-xl flex flex-col md:flex-row items-center gap-4 border border-slate-700" >
              <div className="flex items-center gap-2" >
                <TrendingUp className="text-yellow-400" size={20} />
                <span className="font-bold text-sm text-slate-300 uppercase" > Active Boost </span>
              </div>
              < div className="flex-1 flex gap-2 overflow-x-auto w-full" >
                {
                  Object.keys(BOOSTS).map(key => (
                    <button
                      key={key}
                      onClick={() => handleBoostChange(key)}
                      className={`px-3 py-1.5 rounded text-xs font-bold whitespace-nowrap transition-colors ${myBoost === key ? 'bg-yellow-500 text-black' : 'bg-slate-900 text-slate-400 hover:text-white'}`
                      }
                    >
                      {BOOSTS[key].label}
                    </button>
                  ))}
              </div>
              {
                myBoost !== 'None' && (
                  <div className="flex items-center gap-2 border-l border-slate-700 pl-4" >
                    <span className="text-[10px] font-bold text-slate-500 uppercase" > Effectiveness </span>
                    < input
                      type="range" min="1" max="10"
                      value={myBoostApps}
                      onChange={(e) => handleBoostAppsChange(e.target.value)
                      }
                      className="w-24 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-yellow-500"
                    />
                    <span className="text-xs font-mono text-yellow-400 w-8 text-right" >
                      {Math.round(Math.pow(DR_DECAY, myBoostApps - 1) * 100)} %
                    </span>
                  </div>
                )}
            </div>
          )}

        {/* Home/Away Toggle - Only show on Simulation tab */}
        {
          activeTab === 'simulation' && (
            <div className="bg-slate-800 p-4 rounded-xl flex flex-col md:flex-row items-center justify-between gap-4 border border-slate-700" >
              <div className="flex items-center gap-2" >
                <Activity className="text-blue-400" size={20} />
                <span className="font-bold text-sm text-slate-300 uppercase" > Match Location </span>
              </div>
              < div className="flex gap-3" >
                <button
                  onClick={() => handleHomeAwayToggle('home')}
                  className={`px-6 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${homeAdvantage === 'home' ? 'bg-green-600 text-white shadow-lg shadow-green-500/20' : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-700'}`}
                >
                  <Users size={16} />
                  Home (+5% ATT, +3% DEF)
                </button>
                <button
                  onClick={() => handleHomeAwayToggle('away')}
                  className={`px-6 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${homeAdvantage === 'away' ? 'bg-red-600 text-white shadow-lg shadow-red-500/20' : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-700'}`}
                >
                  <Users size={16} />
                  Away (-3% ATT, -2% DEF)
                </button>
              </div>
              <div className="text-xs text-slate-500" >
                Adjusts your team's performance modifiers
              </div>
            </div>
          )
        }

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8" >

          {/* Left Column */}
          < div className="lg:col-span-2 space-y-6" >

            {activeTab === 'simulation' && (
              <div className="space-y-6 animate-in fade-in duration-500" >

                {/* Suggestion Box */}
                {
                  mySquad.length > 5 && (
                    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4" >
                      {
                        Object.keys(suggestions).length === 0 && !analyzing && (
                          <div className="flex items-center justify-between">
                            <div>
                              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                                <Zap size={14} className="text-yellow-400" /> Smart Coach
                              </h4>
                              < p className="text-xs text-slate-400 mt-1" > Analyze your bench for a better lineup against this opponent.</p>
                            </div>
                            < button
                              onClick={analyzeLineups}
                              className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                            >
                              Analyze Bench
                            </button>
                          </div>
                        )
                      }

                      {
                        analyzing && (
                          <div className="flex items-center justify-center gap-3 py-2" >
                            <Loader2 size={16} className="animate-spin text-blue-400" />
                            <span className="text-xs font-bold text-slate-300" > Crunching the numbers...</span>
                          </div>
                        )
                      }

                      {
                        Object.keys(suggestions).length > 0 && (
                          <div className="animate-in fade-in slide-in-from-top-2 space-y-2" >
                            <div className="flex items-center justify-between" >
                              <h4 className="text-sm font-bold text-white flex items-center gap-2" >
                                <Zap size={14} className="text-yellow-400" /> Analysis Complete
                              </h4>
                              < button
                                onClick={() => setSuggestions({})
                                }
                                className="p-1.5 hover:bg-slate-700 rounded text-slate-400"
                              >
                                <X size={14} />
                              </button>
                            </div>

                            < div className="grid grid-cols-1 gap-2" >
                              {
                                Object.values(suggestions).sort((a, b) => b.win - a.win).map((sugg) => (
                                  <div key={sugg.formation} className="bg-slate-900/50 p-3 rounded-lg border border-slate-700 flex items-center justify-between" >
                                    <div>
                                      <div className="text-xs font-bold text-slate-400" > {FORMATIONS[sugg.formation].name} </div>
                                      < div className="text-sm font-black text-white" >
                                        {sugg.win.toFixed(1)} % Win
                                        < span className={`ml-2 text-xs ${sugg.diff >= 0 ? 'text-green-400' : 'text-red-400'}`} >
                                          {sugg.diff >= 0 ? '+' : ''}{sugg.diff.toFixed(1)}%
                                        </span>
                                      </div>
                                    </div>
                                    < button
                                      onClick={() => applySuggestion(sugg)}
                                      className="bg-slate-700 hover:bg-green-600 text-white text-[10px] font-bold px-3 py-1.5 rounded transition-colors"
                                    >
                                      Apply
                                    </button>
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                <div className="grid grid-cols-3 gap-4" >
                  <ScoreCard title="Team Control" myVal={myStats.Control} oppVal={oppStats.Control} color="text-emerald-400" />
                  <ScoreCard title="Team Defense" myVal={myStats.Defense} oppVal={oppStats.Defense} color="text-blue-400" />
                  <ScoreCard title="Eff. Attack" myVal={myStats.Attack} oppVal={oppStats.Attack} color="text-red-400" />
                </div>

                {
                  formationMismatch && (
                    <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-4 flex items-start gap-3" >
                      <Bandage className="text-red-500 shrink-0 mt-0.5" size={16} />
                      <div>
                        <h4 className="text-sm font-bold text-red-400" > Formation Mismatch </h4>
                        < p className="text-xs text-slate-400 mt-1" >
                          Your active lineup does not match the selected formation({FORMATIONS[myForm].name}).
                          This may result in penalties.
                        </p>
                        < p className="text-xs font-mono text-red-300 mt-2 bg-red-900/30 p-1.5 rounded" >
                          {formationMismatch}
                        </p>
                      </div>
                    </div>
                  )
                }

                <div className="bg-slate-800 rounded-2xl p-6 border border-slate-700" >
                  <h3 className="text-white font-bold text-lg mb-6 flex items-center gap-2" >
                    <Activity size={20} className="text-green-500" /> Match Engine Forecast
                  </h3>

                  < div className="space-y-8" >
                    <div>
                      <div className="flex justify-between text-sm font-bold mb-2 text-slate-400" >
                        <span>Possession </span>
                        < span > {simulation.myPossession} % / {100 - simulation.myPossession}%</span >
                      </div>
                      < div className="h-4 bg-slate-900 rounded-full flex overflow-hidden" >
                        <div className="bg-emerald-500" style={{ width: `${simulation.myPossession}%` }}> </div>
                        < div className="bg-slate-700 flex-1" > </div>
                      </div>
                    </div>

                    < div className="grid grid-cols-2 gap-8" >
                      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50" >
                        <div className="text-xs text-slate-500 uppercase font-bold mb-1" > My Expected Goals </div>
                        < div className="text-3xl font-black text-white" > {simulation.myxG} </div>
                        < div className="text-xs text-green-400 mt-1" >
                          Attack {myStats.Attack} vs Def {oppStats.Defense}
                        </div>
                      </div>
                      < div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50 text-right" >
                        <div className="text-xs text-slate-500 uppercase font-bold mb-1" > Opponent xG </div>
                        < div className="text-3xl font-black text-white" > {simulation.oppxG} </div>
                        < div className="text-xs text-red-400 mt-1" >
                          Attack {oppStats.Attack} vs Def {myStats.Defense}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {
              activeTab === 'myTeam' && (
                <div className="space-y-8 animate-in slide-in-from-right-4 duration-300 pb-20" >

                  {/* Active Formation View */}
                  < div >
                    <h3 className="text-sm font-bold text-slate-400 uppercase mb-3 flex items-center gap-2" >
                      <Activity size={14} className="text-green-500" /> Active Lineup(Max 5)
                    </h3>
                    < div className="space-y-3" >
                      {
                        myTeam.map((p) => (
                          <PlayerRow
                            key={p.id}
                            player={p}
                            onEdit={() => handleEditPlayer(p, activeTab)}
                            onDelete={() => handleRemove(p.id, activeTab)
                            }
                            isEditing={editingId === p.id}
                            onInjuryChange={(sev) => handleInjuryChange(p, sev, activeTab)}
                            isActive={true}
                            onSwap={() => handleSwap(p)}
                          />
                        ))}
                      {
                        myTeam.length === 0 && (
                          <div className="p-6 text-center border-2 border-dashed border-slate-700 rounded-xl text-slate-500 text-sm" >
                            Your lineup is empty.Tap players from the Bench below to add them.
                          </div>
                        )
                      }
                    </div>
                  </div>

                  {/* Bench View */}
                  <div>
                    <div className="flex justify-between items-end mb-3" >
                      <h3 className="text-sm font-bold text-slate-400 uppercase flex items-center gap-2" >
                        <Users size={14} /> Available Squad (Bench)
                      </h3>

                      {/* Bench Filters & Sort */}
                      <div className="flex items-center gap-2" >
                        <div className="flex bg-slate-800 rounded-lg p-0.5 border border-slate-700" >
                          {
                            ['All', 'FW', 'MF', 'DF', 'GK'].map(pos => (
                              <button
                                key={pos}
                                onClick={() => setBenchFilter(pos)}
                                className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${benchFilter === pos ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                              >
                                {pos}
                              </button>
                            ))}
                        </div>
                        < button
                          onClick={toggleSort}
                          className="p-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
                          title={`Sort by OVR (${benchSort === 'ovr_desc' ? 'High to Low' : 'Low to High'})`}
                        >
                          {benchSort === 'ovr_desc' ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />}
                        </button>
                      </div>
                    </div>

                    < div className="space-y-3" >
                      {
                        benchPlayers.map((p) => (
                          <PlayerRow
                            key={p.id}
                            player={p}
                            onEdit={() => handleEditPlayer(p, activeTab)}
                            onDelete={() => handleRemove(p.id, 'mySquad')}
                            isEditing={editingId === p.id}
                            onInjuryChange={(sev) => handleInjuryChange(p, sev, activeTab)}
                            isBench={true}
                            onSwap={() => handleSwap(p)}
                          />
                        ))}
                      {
                        benchPlayers.length === 0 && (
                          <div className="p-6 text-center border-2 border-dashed border-slate-700 rounded-xl text-slate-500 text-sm" >
                            {mySquad.length === 0 ? "No bench players yet. Sync wallet assets or add manual players." : "No players match your filter."}
                          </div>
                        )
                      }
                    </div>
                  </div>

                </div>
              )}

            {
              activeTab === 'opponent' && (
                <div className="animate-in slide-in-from-right-4 duration-300 space-y-4 pb-20" >
                  {
                    opponentTeam.map((p) => (
                      <PlayerRow
                        key={p.id}
                        player={p}
                        onEdit={() => handleEditPlayer(p, activeTab)}
                        onDelete={() => handleRemove(p.id, activeTab)
                        }
                        isEditing={editingId === p.id}
                        onInjuryChange={(sev) => handleInjuryChange(p, sev, activeTab)}
                      />
                    ))}
                  {
                    opponentTeam.length === 0 && (
                      <div className="p-8 text-center border-2 border-dashed border-slate-700 rounded-xl text-slate-500" >
                        No opponent data.Use the Screenshot Import on the right.
                      </div>
                    )
                  }
                </div>
              )}
          </div>

          {/* Right Sidebar: Tools */}
          <div id="player-form" className="bg-slate-800 rounded-2xl p-6 border border-slate-700 h-fit sticky top-6 shadow-xl" >

            {/* New: Screenshot Uploader */}
            < div className="mb-6 pb-6 border-b border-slate-700" >
              <div className="flex justify-between items-center mb-3" >
                <h3 className="font-bold text-white flex items-center gap-2 text-sm" >
                  <ImageIcon size={16} className="text-blue-400" />
                  Opponent Screenshot Scanner
                </h3>
                {uploading && <Loader2 size={14} className="animate-spin text-blue-400" />}
              </div>

              {
                uploading && (
                  <div className="w-full bg-slate-700 rounded-full h-2.5 mb-3 overflow-hidden" >
                    <div
                      className="bg-blue-500 h-2.5 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${uploadProgress}%` }
                      }
                    > </div>
                  </div>
                )}

              <div className="relative group" >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImageUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  disabled={uploading}
                />
                <div className={`border-2 border-dashed rounded-xl p-4 text-center transition-colors ${uploading ? 'border-blue-500/50 bg-blue-500/10' : 'border-slate-600 hover:border-blue-400 hover:bg-slate-700'}`}>
                  <div className="flex flex-col items-center gap-2" >
                    <Upload size={20} className={uploading ? "text-blue-400 animate-bounce" : "text-slate-400"} />
                    <span className="text-[10px] font-bold uppercase text-slate-400" >
                      {uploading ? "Analyzing..." : 'Upload Opponent Screenshot'}
                    </span>
                    < p className="text-[9px] text-slate-600" >
                      Replaces opponent team.
                    </p>
                  </div>
                </div>
              </div>
              {uploadStatus && (
                <div
                  className={`mt-3 rounded-lg border p-2 text-[11px] ${
                    uploadStatus.tone === 'success'
                      ? 'border-emerald-500/40 bg-emerald-900/20 text-emerald-200'
                      : uploadStatus.tone === 'error'
                        ? 'border-red-500/40 bg-red-900/20 text-red-200'
                        : 'border-blue-500/40 bg-blue-900/20 text-blue-200'
                  }`}
                >
                  {uploadStatus.message}
                </div>
              )}

              {showImportReview && (
                <div className="mt-4 rounded-xl border border-slate-600 bg-slate-900/60 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-bold text-slate-200 uppercase">Review Opponent Import</div>
                    <select
                      value={importDraftFormation}
                      onChange={(e) => setImportDraftFormation(e.target.value)}
                      className="bg-slate-900 border border-slate-700 text-[11px] rounded px-2 py-1 text-white focus:outline-none focus:border-blue-500"
                    >
                      {Object.keys(FORMATIONS).map((k) => (
                        <option key={k} value={k}>
                          {FORMATIONS[k].name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="max-h-[340px] overflow-y-auto space-y-2 pr-1">
                    {importDraftPlayers.map((row, idx) => (
                      <div key={row.id} className="rounded-lg border border-slate-700/70 bg-slate-800/60 p-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-slate-400 w-4">{idx + 1}</span>
                          <input
                            type="text"
                            value={row.name}
                            onChange={(e) => handleImportDraftChange(row.id, 'name', e.target.value)}
                            placeholder={`Opponent ${idx + 1}`}
                            className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-green-500"
                          />
                          <select
                            value={row.pos}
                            onChange={(e) => handleImportDraftChange(row.id, 'pos', e.target.value)}
                            className="bg-slate-900 border border-slate-700 text-xs rounded px-2 py-1 text-white focus:outline-none focus:border-green-500"
                          >
                            {Object.keys(POSITIONS).map((k) => (
                              <option key={k} value={k}>{k}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid grid-cols-5 gap-1">
                          {['SPD', 'ATT', 'CTL', 'DEF', 'GKP'].map((statKey) => (
                            <div key={statKey}>
                              <label className="block text-[9px] font-bold text-slate-500 mb-1">{statKey}</label>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                value={row.stats[statKey]}
                                onChange={(e) => handleImportDraftStatChange(row.id, statKey, e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-white font-mono focus:outline-none focus:border-blue-500"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleApplyImportDraft}
                      className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2 transition-colors"
                    >
                      Apply Opponent
                    </button>
                    <button
                      onClick={handleCancelImportDraft}
                      className="rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold py-2 transition-colors"
                    >
                      Discard Draft
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible Manual Form */}
            <div>
              <button
                onClick={() => setShowManualForm(!showManualForm)}
                className="w-full flex justify-between items-center mb-4 text-sm font-bold text-slate-400 hover:text-white transition-colors"
              >
                <span className="flex items-center gap-2" >
                  {editingId ? <Pencil size={14} className="text-yellow-400" /> : <Plus size={14} className="text-green-500" />}
                  {editingId ? 'Edit Player' : 'Manual Entry'}
                </span>
                {showManualForm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {
                showManualForm && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-2" >

                    {editingId && (
                      <div className="flex justify-end" >
                        <button onClick={handleCancelEdit} className="text-xs text-slate-400 hover:text-white flex items-center gap-1 bg-slate-700 px-2 py-1 rounded" >
                          <RotateCcw size={12} /> Cancel Edit
                        </button>
                      </div>
                    )
                    }

                    {
                      !editingId && (
                        <div className="flex bg-slate-900 p-1 rounded-lg" >
                          <button onClick={() => setFormTarget('mySquad')} className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${formTarget === 'mySquad' ? 'bg-green-600 text-white' : 'text-slate-400 hover:text-slate-200'}`
                          }> My Squad </button>
                          < button onClick={() => setFormTarget('opponent')} className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${formTarget === 'opponent' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}> Opponent </button>
                        </div>
                      )}

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1" > Name </label>
                      < input
                        type="text" placeholder="Player Name"
                        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm focus:border-green-500 outline-none text-white"
                        value={newPlayer.name} onChange={e => setNewPlayer({ ...newPlayer, name: e.target.value })}
                      />
                    </div>

                    < div >
                      <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1" > Position </label>
                      < div className="grid grid-cols-4 gap-2" >
                        {
                          Object.keys(POSITIONS).map(k => (
                            <button
                              key={k}
                              onClick={() => setNewPlayer({ ...newPlayer, pos: k })}
                              className={`text-xs font-bold py-2 rounded border ${newPlayer.pos === k ? 'bg-green-500/20 border-green-500 text-green-400' : 'bg-slate-900 border-transparent text-slate-500 hover:bg-slate-800'}`}
                            >
                              {k}
                            </button>
                          ))}
                      </div>
                    </div>

                    < div className="grid grid-cols-2 gap-3" >
                      {
                        ['ATT', 'CTL', 'SPD', 'DEF'].map(s => (
                          <div key={s} >
                            <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1" > {s} </label>
                            < input
                              type="number"
                              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono focus:border-green-500 outline-none text-white"
                              value={newPlayer.stats[s]} onChange={e => handleStatChange(s, e.target.value)
                              }
                            />
                          </div>
                        ))}
                      {
                        newPlayer.pos === 'GK' && (
                          <div className="col-span-2 animate-in fade-in" >
                            <label className="text-[10px] font-bold text-yellow-500 uppercase block mb-1" > GKP(Goalkeeping) </label>
                            < input
                              type="number"
                              className="w-full bg-yellow-900/20 border border-yellow-500/30 rounded px-2 py-1.5 text-sm font-mono text-yellow-200 focus:border-yellow-500 outline-none"
                              value={newPlayer.stats.GKP} onChange={e => handleStatChange('GKP', e.target.value)}
                            />
                          </div>
                        )
                      }
                    </div>

                    {/* Injury Status in Form */}
                    <div>
                      <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1" > Injury Status </label>
                      < div className="grid grid-cols-4 gap-2" >
                        {
                          Object.keys(INJURIES).map(sev => (
                            <button
                              key={sev}
                              onClick={() => setNewPlayer({ ...newPlayer, injury: sev === 'None' ? null : sev })}
                              className={`text-[10px] font-bold py-2 rounded border ${(newPlayer.injury === sev || (!newPlayer.injury && sev === 'None'))
                                ? `${INJURIES[sev].color} border-transparent text-white`
                                : 'bg-slate-900 border-slate-700 text-slate-500 hover:bg-slate-800'
                                }`}
                            >
                              {sev === 'None' ? 'Healthy' : sev}
                            </button>
                          ))}
                      </div>
                    </div>

                    < button
                      onClick={handleSavePlayer}
                      className={`w-full py-3 font-bold rounded-xl mt-4 transition-all active:scale-95 flex items-center justify-center gap-2 ${editingId ? 'bg-yellow-600 hover:bg-yellow-500 text-white' : 'bg-green-600 hover:bg-green-500 text-white'}`}
                    >
                      {editingId ? <Save size={16} /> : <Plus size={16} />}
                      {editingId ? 'Update Player' : 'Add Player'}
                    </button>
                  </div>
                )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// --- Components ---

function TabButton({ active, onClick, label, icon }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${active ? 'bg-slate-600 text-white' : 'text-slate-400 hover:bg-slate-700 hover:text-white'}`
      }
    >
      {icon} {label}
    </button>
  )
}

function ScoreCard({ title, myVal, oppVal, color }) {
  const diff = (myVal - oppVal).toFixed(1);
  return (
    <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col justify-between" >
      <div className="text-xs font-bold text-slate-500 uppercase mb-2" > {title} </div>
      < div className="flex items-baseline justify-between" >
        <span className={`text-3xl font-black ${color}`}> {myVal} </span>
        < span className="text-xl font-bold text-slate-600" > {oppVal} </span>
      </div>
      < div className={`text-[10px] font-bold mt-2 ${diff > 0 ? 'text-green-400' : 'text-red-400'}`
      }>
        {diff > 0 ? '+' : ''}{diff} vs Opponent
      </div>
    </div>
  )
}

function PlayerRow({ player, onEdit, onDelete, isEditing, onInjuryChange, isActive, isBench, onSwap }) {
  const [injuryMenuOpen, setInjuryMenuOpen] = useState(false);

  const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1.0;
  const scores = {
    CTL: getControlScore(player.stats, player.pos, injuryMod),
    ATT: getAttackScore(player.stats, player.pos, injuryMod),
    DEF: getDefenseScore(player.stats, player.pos, injuryMod)
  };

  const defLabel = player.pos === 'GK' ? 'GKP' : 'DEF';
  const defRaw = player.pos === 'GK' ? player.stats.GKP : player.stats.DEF;

  const handleInjurySelect = (sev) => {
    onInjuryChange(sev === 'None' ? null : sev);
    setInjuryMenuOpen(false);
  }

  const posStyle = POSITIONS[player.pos] || { color: 'from-slate-500 to-slate-600', label: 'Unknown', short: '??' };
  const source = player.source || 'manual';
  const sourceBadgeClass = source === 'wallet'
    ? 'bg-green-900/50 text-green-300 border-green-500/30'
    : source === 'upload'
      ? 'bg-blue-900/50 text-blue-300 border-blue-500/30'
      : 'bg-slate-700/60 text-slate-300 border-slate-500/30';
  const sourceLabel = source === 'wallet' ? 'Wallet' : source === 'upload' ? 'Upload' : 'Manual';

  return (
    <div className={`relative bg-slate-800 p-3 rounded-xl border flex items-center justify-between group transition-colors ${isEditing ? 'border-yellow-500 bg-yellow-500/5' : 'border-slate-700 hover:border-slate-600'} ${injuryMenuOpen ? 'z-50' : 'z-0'}`
    }>

      {
        player.injury && (
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500 z-10 rounded-l-xl"> </div>
        )
      }

      < div className="flex items-center gap-3 z-10 pl-2 flex-1 cursor-pointer" onClick={onSwap} >
        <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold bg-gradient-to-br ${posStyle.color} text-white shadow-lg relative`}>
          {player.pos}
          {isActive && <div className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full border border-slate-800" > </div>}
        </div>
        < div >
          <div className="font-bold text-slate-200 text-sm flex items-center gap-2" >
            {player.name}
            {isEditing && <span className="text-[10px] bg-yellow-500 text-black px-1 rounded font-bold" > EDITING </span>}
            <span className={`text-[10px] border px-1.5 rounded font-bold ${sourceBadgeClass}`}>{sourceLabel}</span>
            {player.injury && INJURIES[player.injury] && <span className="text-[10px] bg-red-900/50 text-red-400 border border-red-500/30 px-1.5 rounded flex items-center gap-1" > <Activity size={10} /> {INJURIES[player.injury].label}</span >}
          </div>

          < div className="flex flex-wrap gap-x-4 gap-y-1 mt-1" >
            <div className="text-[10px] font-mono flex items-center gap-1 bg-slate-900/50 px-1.5 py-0.5 rounded border border-slate-700/50 text-slate-400" >
              <Zap size={10} /> {player.stats.SPD}
            </div>
            < StatDisplay label="CTL" raw={player.stats.CTL} boosted={scores.CTL} injured={!!player.injury} />
            {
              player.pos !== 'GK' && (
                <StatDisplay label="ATT" raw={player.stats.ATT} boosted={scores.ATT} injured={!!player.injury
                } />
              )}
            <StatDisplay label={defLabel} raw={defRaw} boosted={scores.DEF} injured={!!player.injury} />
          </div>
        </div>
      </div>

      {/* Action Section */}
      <div className="flex items-center gap-3 z-10" >
        <div className="text-right hidden sm:block" >
          <div className="text-[10px] font-bold text-slate-500" > OVR </div>
          < div className={`text-lg font-black leading-none ${player.injury ? 'text-red-400' : 'text-white'}`}> {player.ovr} </div>
        </div>

        < div className="flex gap-1 relative" >
          {/* Swap Button (Visual only, row click does swap) */}
          {
            (isActive || isBench) && (
              <button onClick={onSwap} className={`p-2 rounded transition-colors ${isActive ? 'text-green-400 bg-green-900/20 hover:bg-green-900/40' : 'text-slate-600 hover:text-green-400 hover:bg-slate-700'}`
              } title={isActive ? "Remove from lineup" : "Add to lineup"} >
                <RefreshCw size={14} />
              </button>
            )}

          <button
            onClick={() => setInjuryMenuOpen(!injuryMenuOpen)}
            className={`p-2 rounded transition-colors ${player.injury ? 'text-red-400 bg-red-900/20' : 'text-slate-600 hover:text-red-400 hover:bg-slate-700'}`}
          >
            {injuryMenuOpen ? <X size={14} /> : <Bandage size={14} />}
          </button>

          {
            injuryMenuOpen && (
              <div className="absolute right-0 top-full mt-2 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl p-1 flex flex-col gap-1 min-w-[140px] z-[100] animate-in fade-in zoom-in-95 duration-200 ring-1 ring-white/10" >
                <div className="px-2 py-1 text-[10px] font-bold text-slate-500 uppercase border-b border-slate-800 mb-1" > Set Condition </div>
                {
                  Object.keys(INJURIES).map(sev => (
                    <button
                      key={sev}
                      onClick={() => handleInjurySelect(sev)}
                      className={`text-xs text-left px-2 py-2 rounded hover:bg-slate-800 flex items-center justify-between group/item ${player.injury === sev || (!player.injury && sev === 'None') ? 'bg-slate-800' : ''}`
                      }
                    >
                      <span className={INJURIES[sev].text}> {INJURIES[sev].label} </span>
                      {(player.injury === sev || (!player.injury && sev === 'None')) && <div className="w-1.5 h-1.5 rounded-full bg-current" > </div>}
                    </button>
                  ))}
              </div>
            )}

          <button onClick={onEdit} className="p-2 text-slate-500 hover:text-yellow-400 hover:bg-slate-700 rounded transition-colors" title="Edit Player" >
            <Pencil size={14} />
          </button>
          < button onClick={onDelete} className="p-2 text-slate-500 hover:text-red-400 hover:bg-slate-700 rounded transition-colors" title="Delete Player" >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

function StatDisplay({ label, raw, boosted, injured }) {
  return (
    <div className={`text-[10px] font-mono flex items-center gap-1 bg-slate-900/50 px-1.5 py-0.5 rounded border ${injured ? 'border-red-900/30' : 'border-slate-700/50'}`
    }>
      <span className="text-slate-500 font-bold" > {label} </span>
      < span className="text-slate-300" > {raw} </span>
      < span className="text-slate-600" >→</span>
      < span className={`${injured ? 'text-red-400' : (boosted > raw ? "text-green-400 font-bold" : "text-slate-200")}`}> {boosted} </span>
    </div>
  );
}
