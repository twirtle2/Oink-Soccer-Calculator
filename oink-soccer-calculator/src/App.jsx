import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Bandage, X, TrendingUp, ChevronDown, ChevronUp, RefreshCw, ArrowDownWideNarrow, ArrowUpNarrowWide, Link2 } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import { fetchHeldAssetIdsForAddresses } from './lib/indexer';
import { buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import { importOpponentFromTeamInput } from './lib/lostPigsTeamImport';
import { resolvePlayerImage } from './lib/assetImages';
import {
  BOOSTS,
  DEFENSE_BIAS_MULTIPLIER,
  DR_DECAY,
  DR_MIN,
  FORMATIONS,
  FORMATION_CHANCE_RANGES,
} from './lib/gameRules';

// --- Game Constants ---
const POSITIONS = {
  GK: { label: 'Goalkeeper', short: 'GK', color: 'from-yellow-500 to-yellow-600' },
  DF: { label: 'Defender', short: 'DF', color: 'from-blue-500 to-blue-600' },
  MF: { label: 'Midfielder', short: 'MF', color: 'from-emerald-500 to-emerald-600' },
  FW: { label: 'Forward', short: 'FW', color: 'from-red-500 to-red-600' },
};

// --- Event Count Logic (Home/Away Bias) ---
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

const calculateBoostMultiplier = (boostKey, applications = 1) => {
  if (boostKey === 'None' || !BOOSTS[boostKey]) return 1.0;
  const boost = BOOSTS[boostKey];
  const baseBoost = (boost.min + boost.max) / 2;

  if (applications <= 1) return baseBoost;

  let m = Math.pow(DR_DECAY, applications);
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


export default function OinkSoccerCalc() {
  const { wallets } = useWallet();
  const persistedState = useMemo(() => loadCalculatorState(), []);
  const autoSyncedAddressKeyRef = useRef('');

  const [importingTeamUrl, setImportingTeamUrl] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [teamUrlInput, setTeamUrlInput] = useState('');
  const [catalogSeason, setCatalogSeason] = useState(null);
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

  const [currentStep, setCurrentStep] = useState(1);
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
  const step1Ref = useRef(null);
  const step2Ref = useRef(null);
  const step3Ref = useRef(null);
  const step4Ref = useRef(null);

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
    let cancelled = false;
    void loadPlayableCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setCatalogSeason(catalog?.season ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogSeason(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      const [catalogPayload, heldAssetIds] = await Promise.all([
        loadPlayableCatalog(),
        fetchHeldAssetIdsForAddresses(addressesToSync),
      ]);

      const catalogByAssetId = catalogPayload?.assets || {};
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

  const handleImportTeamUrl = useCallback(async () => {
    if (importingTeamUrl) return;
    if (!teamUrlInput.trim()) {
      setUploadStatus({ tone: 'error', message: 'Enter a Lost Pigs team URL or teamId first.' });
      return;
    }

    setImportingTeamUrl(true);
    setUploadStatus({ tone: 'info', message: 'Fetching opponent lineup from Lost Pigs API...' });

    try {
      const imported = await importOpponentFromTeamInput(teamUrlInput);
      const nextFormation = imported.formationKey && FORMATIONS[imported.formationKey]
        ? imported.formationKey
        : oppForm;

      setOppForm(nextFormation);
      setOpponentTeam(imported.players);
      saveToDb({ opponentTeam: imported.players, oppForm: nextFormation });

      const formationText = imported.formationKey
        ? ` Formation: ${FORMATIONS[imported.formationKey].name}.`
        : '';

      setUploadStatus({
        tone: 'success',
        message: `Imported ${imported.players.length} opponent lineup players from ${imported.teamLabel}.${formationText}`,
      });
    } catch (err) {
      setUploadStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Team URL import failed.',
      });
    } finally {
      setImportingTeamUrl(false);
    }
  }, [importingTeamUrl, oppForm, saveToDb, teamUrlInput]);

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
  };

  const connectedWalletCount = connectedAddresses.length;
  const walletBadgeLabel = connectedWalletCount > 0
    ? `${connectedWalletCount} wallet${connectedWalletCount > 1 ? 's' : ''} connected`
    : 'No wallet connected';

  const stepCompletion = useMemo(() => ({
    1: myTeam.length > 0,
    2: opponentTeam.length > 0,
    3: Boolean(homeAdvantage && myBoost),
  }), [homeAdvantage, myBoost, myTeam.length, opponentTeam.length]);

  const stepItems = useMemo(() => ([
    { key: 1, label: 'My Squad' },
    { key: 2, label: 'Opponent' },
    { key: 3, label: 'Match Conditions' },
    { key: 4, label: 'Simulation' },
  ]), []);

  const stepIsClickable = (step) => {
    if (step === currentStep) return true;
    if (step < currentStep) return true;
    if (step === 2 && stepCompletion[1]) return true;
    if (step === 3 && stepCompletion[1] && stepCompletion[2]) return true;
    if (step === 4 && stepCompletion[1] && stepCompletion[2] && stepCompletion[3]) return true;
    return false;
  };

  const scrollToStep = useCallback((step) => {
    setCurrentStep(step);
    const sectionByStep = {
      1: step1Ref,
      2: step2Ref,
      3: step3Ref,
      4: step4Ref,
    };
    const target = sectionByStep[step]?.current;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const winPct = Number.parseFloat(simulation.win) || 0;
  const scoreGap = Number(simulation.myxG) - Number(simulation.oppxG);
  const drawPct = Math.max(12, Math.min(34, 24 - Math.abs(scoreGap) * 7));
  const remaining = Math.max(0, 100 - drawPct);
  const winShare = Math.max(0, Math.min(1, winPct / 100));
  const forecastWin = Number((remaining * winShare).toFixed(1));
  const forecastLoss = Number((100 - drawPct - forecastWin).toFixed(1));
  const forecastDraw = Number((100 - forecastWin - forecastLoss).toFixed(1));

  const controlDelta = Number((myStats.Control - oppStats.Control).toFixed(1));
  const defenseDelta = Number((myStats.Defense - oppStats.Defense).toFixed(1));
  const attackDelta = Number((myStats.Attack - oppStats.Attack).toFixed(1));

  const topSuggestion = useMemo(() => (
    Object.values(suggestions)
      .sort((a, b) => b.win - a.win)[0] || null
  ), [suggestions]);

  const annotation = useMemo(() => {
    const worstDelta = Math.min(controlDelta, defenseDelta, attackDelta);
    if (topSuggestion && topSuggestion.formation && topSuggestion.diff > 0) {
      return `Smart Coach sees an upgrade: ${FORMATIONS[topSuggestion.formation].name} projects ${topSuggestion.win.toFixed(1)}% win (${topSuggestion.diff.toFixed(1)} higher than current).`;
    }
    if (worstDelta >= 0) {
      return `You are ahead across key metrics. Keep ${FORMATIONS[myForm]?.name || myForm} and preserve pressure with ${myBoost === 'None' ? 'No Boost' : BOOSTS[myBoost]?.label}.`;
    }
    if (controlDelta === worstDelta) {
      return `Control gap detected: you are ${Math.abs(controlDelta).toFixed(1)} behind. Run Smart Coach to find the highest-win formation from your current bench.`;
    }
    if (defenseDelta === worstDelta) {
      return `Defense is trailing by ${Math.abs(defenseDelta).toFixed(1)}. Home location and lineup optimization can reduce opponent xG before kickoff.`;
    }
    return `Attack is trailing by ${Math.abs(attackDelta).toFixed(1)}. Run Smart Coach to identify the best attacking lineup from available players.`;
  }, [attackDelta, controlDelta, defenseDelta, myBoost, myForm, topSuggestion]);

  return (
    <div className="min-h-screen bg-[#0a0d12] text-[#e8edf5] font-sans pb-10">
      <div className="mx-auto max-w-[1240px] px-4 py-6 md:px-8 md:py-8 space-y-6">
        <header className="flex flex-col gap-4 border-b border-[#1e2a3a] pb-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="font-['Barlow_Condensed'] text-4xl font-black tracking-wide text-white md:text-5xl">
              <span className="text-[#00e676]">OINK</span> SOCCER CALCULATOR
            </h1>
            <p className="mt-1 text-sm font-medium text-[#6b7a94]">{catalogSeason ? `Season ${catalogSeason}` : 'Season Unknown'}</p>
          </div>
          <div className="flex items-center gap-3 self-start md:self-center">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-xs font-semibold text-[#9aa5bb]">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00e676]/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#00e676]" />
              </span>
              {walletBadgeLabel}
            </div>
            <WalletConnector
              onSync={handleSyncWalletAssets}
              isSyncing={walletSyncing}
              syncMeta={walletSyncMeta}
            />
          </div>
        </header>

        <nav className="flex flex-wrap items-center gap-2 rounded-xl border border-[#1e2a3a] bg-[#111620] px-4 py-3 md:gap-3">
          {stepItems.map((step, idx) => {
            const isDone = step.key <= 3 && stepCompletion[step.key];
            const isActive = currentStep === step.key;
            return (
              <React.Fragment key={step.key}>
                <button
                  type="button"
                  onClick={() => stepIsClickable(step.key) && scrollToStep(step.key)}
                  disabled={!stepIsClickable(step.key)}
                  className={`inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] transition ${
                    isActive
                      ? 'text-white'
                      : isDone
                        ? 'text-[#00e676]'
                        : 'text-[#6b7a94]'
                  } ${stepIsClickable(step.key) ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                >
                  <span
                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold ${
                      isDone
                        ? 'border-[#00e676] bg-[#00e676] text-black'
                        : isActive
                          ? 'border-[#00e676] text-[#00e676]'
                          : 'border-[#1e2a3a] text-[#6b7a94]'
                    }`}
                  >
                    {isDone ? '✓' : step.key}
                  </span>
                  <span className={isActive ? 'border-b-2 border-[#00e676] pb-0.5' : ''}>{step.label}</span>
                </button>
                {idx < stepItems.length - 1 && <span className="text-[#1e2a3a]">›</span>}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.7fr_1fr]">
          <section className="space-y-5">
            <div ref={step1Ref} className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-['Barlow_Condensed'] text-xs font-bold uppercase tracking-[0.15em] text-[#6b7a94]">Step 1 · My Squad</h2>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#00e676]">▲ My Team</div>
                  <select
                    value={myForm}
                    onChange={(e) => handleFormChange('my', e.target.value)}
                    className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#00e676]"
                  >
                    {Object.keys(FORMATIONS).map((k) => (
                      <option key={k} value={k}>{FORMATIONS[k].name}</option>
                    ))}
                  </select>
                  <div className="space-y-3">
                    {myTeam.map((p) => (
                      <PlayerRow
                        key={p.id}
                        player={p}
                        onEdit={() => handleEditPlayer(p, 'myTeam')}
                        onDelete={() => handleRemove(p.id, 'myTeam')}
                        isEditing={editingId === p.id}
                        onInjuryChange={(sev) => handleInjuryChange(p, sev, 'myTeam')}
                        isActive
                        onSwap={() => handleSwap(p)}
                      />
                    ))}
                    {myTeam.length === 0 && (
                      <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No active lineup yet. Sync wallets or add manual players.</div>
                    )}
                  </div>
                </div>
                <div className="hidden flex-col items-center gap-2 pt-10 md:flex">
                  <div className="h-8 w-px bg-[#1e2a3a]" />
                  <div className="font-['Barlow_Condensed'] text-2xl font-black text-[#6b7a94]">VS</div>
                  <div className="h-8 w-px bg-[#1e2a3a]" />
                </div>
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[#ffab00]">▼ Opponent</div>
                  <select
                    value={oppForm}
                    onChange={(e) => handleFormChange('opp', e.target.value)}
                    className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#ffab00]"
                  >
                    {Object.keys(FORMATIONS).map((k) => (
                      <option key={k} value={k}>{FORMATIONS[k].name}</option>
                    ))}
                  </select>
                  <div ref={step2Ref} className="rounded-lg border border-[#1e2a3a] bg-[#161c28] p-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#9aa5bb]">Step 2 · Import Opponent</div>
                    <p className="mb-2 text-xs text-[#6b7a94]">Paste your opponent's Lost Pigs team URL or teamId.</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={teamUrlInput}
                        onChange={(e) => setTeamUrlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleImportTeamUrl();
                          }
                        }}
                        placeholder="https://www.thelostpigs.com/oink-soccer/team?teamId=..."
                        className="min-w-0 flex-1 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-xs text-[#e8edf5] placeholder:text-[#6b7a94] outline-none focus:border-[#2979ff]"
                        disabled={importingTeamUrl}
                      />
                      <button
                        onClick={() => void handleImportTeamUrl()}
                        disabled={importingTeamUrl}
                        className="inline-flex items-center gap-1 rounded-md bg-[#2979ff] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700"
                      >
                        {importingTeamUrl ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
                        {importingTeamUrl ? 'Loading' : 'Import'}
                      </button>
                    </div>
                    {uploadStatus && (
                      <div className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${
                        uploadStatus.tone === 'success'
                          ? 'border-[#00e676]/40 bg-[#00e676]/10 text-[#9af7cb]'
                          : uploadStatus.tone === 'error'
                            ? 'border-[#ff4444]/50 bg-[#ff4444]/10 text-[#ff9e9e]'
                            : 'border-[#2979ff]/40 bg-[#2979ff]/10 text-[#9fc6ff]'
                      }`}>
                        {uploadStatus.message}
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    {opponentTeam.map((p) => (
                      <PlayerRow
                        key={p.id}
                        player={p}
                        onEdit={() => handleEditPlayer(p, 'opponent')}
                        onDelete={() => handleRemove(p.id, 'opponent')}
                        isEditing={editingId === p.id}
                        onInjuryChange={(sev) => handleInjuryChange(p, sev, 'opponent')}
                      />
                    ))}
                    {opponentTeam.length === 0 && (
                      <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No opponent lineup imported yet.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div ref={step3Ref} className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-['Barlow_Condensed'] text-xs font-bold uppercase tracking-[0.15em] text-[#6b7a94]">Step 3 · Match Conditions</h2>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-[#1e2a3a] bg-[#161c28] p-4">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">📍 Location</div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleHomeAwayToggle('home')}
                      className={`rounded-md border px-3 py-2 text-left text-sm ${homeAdvantage === 'home' ? 'border-[#00e676] text-[#00e676]' : 'border-[#1e2a3a] text-[#9aa5bb]'}`}
                    >
                      🏠 Home (+5% ATT / +3% DEF)
                    </button>
                    <button
                      onClick={() => handleHomeAwayToggle('away')}
                      className={`rounded-md border px-3 py-2 text-left text-sm ${homeAdvantage === 'away' ? 'border-[#00e676] text-[#00e676]' : 'border-[#1e2a3a] text-[#9aa5bb]'}`}
                    >
                      ✈️ Away (-3% ATT / -2% DEF)
                    </button>
                  </div>
                </div>
                <div className="rounded-lg border border-[#1e2a3a] bg-[#161c28] p-4">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">⚡ Active Boost</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.keys(BOOSTS).map((key) => (
                      <button
                        key={key}
                        onClick={() => handleBoostChange(key)}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                          myBoost === key
                            ? key === 'None'
                              ? 'border-[#6b7a94] bg-[#111620] text-[#e8edf5]'
                              : 'border-[#ffab00] bg-[#ffab00] text-black'
                            : 'border-[#1e2a3a] bg-[#111620] text-[#9aa5bb]'
                        }`}
                      >
                        {key === 'MagicTruffle' ? 'Magic (1-5%)' : key === 'GoldenTruffle' ? 'Golden (3-7%)' : key === 'IridiumTruffle' ? 'Iridium (10%)' : key === 'HalftimeOrange' ? 'Half-time (3-7%)' : 'No Boost'}
                      </button>
                    ))}
                  </div>
                  {myBoost !== 'None' && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-[11px] text-[#9aa5bb]">Applications</span>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        value={myBoostApps}
                        onChange={(e) => handleBoostAppsChange(e.target.value)}
                        className="h-1 w-24 accent-[#ffab00]"
                      />
                      <span className="text-xs font-semibold text-[#ffab00]">{myBoostApps}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div ref={step4Ref} className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-4 text-xs font-bold uppercase tracking-[0.15em] text-[#6b7a94]">Step 4 · Stat Comparison</div>
              <div className="space-y-4">
                <ComparisonStat title="Team Control" mine={myStats.Control} opp={oppStats.Control} />
                <ComparisonStat title="Team Defense" mine={myStats.Defense} opp={oppStats.Defense} />
                <ComparisonStat title="Eff. Attack" mine={myStats.Attack} opp={oppStats.Attack} />
              </div>
              <div className="mt-4 rounded-lg border border-[#00e676]/30 bg-[#00e676]/5 p-3 text-sm text-[#9bd7bd]">
                ⚠️ <span className="font-semibold text-[#c3ffe4]">Match Insight:</span> {annotation}
              </div>
              {formationMismatch && (
                <div className="mt-3 rounded-lg border border-[#ff4444]/40 bg-[#ff4444]/10 p-3 text-xs text-[#ffb3b3]">
                  {formationMismatch}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-['Barlow_Condensed'] text-xs font-bold uppercase tracking-[0.15em] text-[#6b7a94]">My Squad Bench</h3>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-md border border-[#1e2a3a] bg-[#161c28] p-0.5">
                    {['All', 'FW', 'MF', 'DF', 'GK'].map((pos) => (
                      <button
                        key={pos}
                        onClick={() => setBenchFilter(pos)}
                        className={`rounded px-2 py-1 text-[10px] font-semibold ${benchFilter === pos ? 'bg-[#111620] text-white' : 'text-[#6b7a94]'}`}
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                  <button onClick={toggleSort} className="rounded-md border border-[#1e2a3a] bg-[#161c28] p-1.5 text-[#9aa5bb]">
                    {benchSort === 'ovr_desc' ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />}
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {benchPlayers.map((p) => (
                  <PlayerRow
                    key={p.id}
                    player={p}
                    onEdit={() => handleEditPlayer(p, 'mySquad')}
                    onDelete={() => handleRemove(p.id, 'mySquad')}
                    isEditing={editingId === p.id}
                    onInjuryChange={(sev) => handleInjuryChange(p, sev, 'mySquad')}
                    isBench
                    onSwap={() => handleSwap(p)}
                  />
                ))}
                {benchPlayers.length === 0 && (
                  <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No bench players match your filter.</div>
                )}
              </div>
            </div>

            <div id="player-form" className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <button
                onClick={() => setShowManualForm(!showManualForm)}
                className="mb-4 flex w-full items-center justify-between text-sm font-semibold text-[#9aa5bb]"
              >
                <span className="inline-flex items-center gap-2">
                  {editingId ? <Pencil size={14} className="text-[#ffab00]" /> : <Plus size={14} className="text-[#00e676]" />}
                  {editingId ? 'Edit Player' : 'Manual Entry'}
                </span>
                {showManualForm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showManualForm && (
                <div className="space-y-4">
                  {editingId && (
                    <div className="flex justify-end">
                      <button onClick={handleCancelEdit} className="inline-flex items-center gap-1 rounded bg-[#161c28] px-2 py-1 text-xs text-[#9aa5bb]">
                        <RotateCcw size={12} /> Cancel Edit
                      </button>
                    </div>
                  )}

                  {!editingId && (
                    <div className="flex rounded-md border border-[#1e2a3a] bg-[#161c28] p-1">
                      <button
                        onClick={() => setFormTarget('mySquad')}
                        className={`flex-1 rounded py-1.5 text-xs font-semibold ${formTarget === 'mySquad' ? 'bg-[#00e676] text-black' : 'text-[#9aa5bb]'}`}
                      >
                        My Squad
                      </button>
                      <button
                        onClick={() => setFormTarget('opponent')}
                        className={`flex-1 rounded py-1.5 text-xs font-semibold ${formTarget === 'opponent' ? 'bg-[#ffab00] text-black' : 'text-[#9aa5bb]'}`}
                      >
                        Opponent
                      </button>
                    </div>
                  )}

                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Name</label>
                    <input
                      type="text"
                      placeholder="Player Name"
                      className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-white outline-none focus:border-[#00e676]"
                      value={newPlayer.name}
                      onChange={(e) => setNewPlayer({ ...newPlayer, name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Position</label>
                    <div className="grid grid-cols-4 gap-2">
                      {Object.keys(POSITIONS).map((k) => (
                        <button
                          key={k}
                          onClick={() => setNewPlayer({ ...newPlayer, pos: k })}
                          className={`rounded border py-2 text-xs font-semibold ${newPlayer.pos === k ? 'border-[#00e676] bg-[#00e676]/10 text-[#00e676]' : 'border-[#1e2a3a] bg-[#161c28] text-[#9aa5bb]'}`}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {['ATT', 'CTL', 'SPD', 'DEF'].map((s) => (
                      <div key={s}>
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">{s}</label>
                        <input
                          type="number"
                          className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-[#00e676]"
                          value={newPlayer.stats[s]}
                          onChange={(e) => handleStatChange(s, e.target.value)}
                        />
                      </div>
                    ))}
                    {newPlayer.pos === 'GK' && (
                      <div className="col-span-2">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">GKP</label>
                        <input
                          type="number"
                          className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-2 py-1.5 text-sm font-mono text-white outline-none focus:border-[#00e676]"
                          value={newPlayer.stats.GKP}
                          onChange={(e) => handleStatChange('GKP', e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">Injury Status</label>
                    <div className="grid grid-cols-4 gap-2">
                      {Object.keys(INJURIES).map((sev) => (
                        <button
                          key={sev}
                          onClick={() => setNewPlayer({ ...newPlayer, injury: sev === 'None' ? null : sev })}
                          className={`rounded border py-2 text-[10px] font-bold ${
                            (newPlayer.injury === sev || (!newPlayer.injury && sev === 'None'))
                              ? `${INJURIES[sev].color} border-transparent text-white`
                              : 'border-[#1e2a3a] bg-[#161c28] text-[#9aa5bb]'
                          }`}
                        >
                          {sev === 'None' ? 'Healthy' : sev}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={handleSavePlayer}
                    className={`inline-flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold ${editingId ? 'bg-[#ffab00] text-black' : 'bg-[#00e676] text-black'}`}
                  >
                    {editingId ? <Save size={15} /> : <Plus size={15} />}
                    {editingId ? 'Update Player' : 'Add Player'}
                  </button>
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:h-fit">
            <div className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5 text-center">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">Win Probability</div>
              <div className="mt-2 font-['Barlow_Condensed'] text-7xl font-black leading-none text-[#00e676]">{simulation.win}%</div>
              <div className="mt-2 text-xs text-[#6b7a94]">Based on {(Number(simulation.myxG) + Number(simulation.oppxG)).toFixed(2)} simulated goals</div>
              <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center rounded-lg border border-[#1e2a3a] bg-[#161c28] px-3 py-2">
                <div>
                  <div className="font-['Barlow_Condensed'] text-3xl font-bold text-[#00e676]">{simulation.myxG}</div>
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[#6b7a94]">Your Goals</div>
                </div>
                <div className="text-xl text-[#6b7a94]">:</div>
                <div>
                  <div className="font-['Barlow_Condensed'] text-3xl font-bold text-[#ffab00]">{simulation.oppxG}</div>
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[#6b7a94]">Opp Goals</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-3 text-sm font-semibold text-[#e8edf5]">📊 Outcome Forecast</div>
              <div className="space-y-2">
                <OutcomeBar label="Win" value={forecastWin} color="#00e676" textClass="text-[#00e676]" />
                <OutcomeBar label="Draw" value={forecastDraw} color="#6b7a94" textClass="text-[#9aa5bb]" />
                <OutcomeBar label="Loss" value={forecastLoss} color="#ff4444" textClass="text-[#ff4444]" />
              </div>
            </div>

            <div className="rounded-xl border border-[#1e2a3a] bg-[#111620] p-5">
              <div className="mb-1 text-sm font-semibold text-[#e8edf5]">⚡ Smart Coach</div>
              <p className="mb-3 text-xs text-[#6b7a94]">Lineup suggestions for this matchup</p>
              <div className="space-y-2">
                {Object.values(suggestions).sort((a, b) => b.win - a.win).slice(0, 2).map((sugg) => (
                  <button
                    key={sugg.formation}
                    onClick={() => applySuggestion(sugg)}
                    className="w-full rounded-md border border-[#1e2a3a] border-l-[3px] border-l-[#00e676] bg-[#161c28] p-3 text-left text-xs text-[#9aa5bb]"
                  >
                    <div className="font-semibold text-[#e8edf5]">{FORMATIONS[sugg.formation].name}</div>
                    <div><strong className="text-[#00e676]">{sugg.win.toFixed(1)}% win</strong> ({sugg.diff >= 0 ? '+' : ''}{sugg.diff.toFixed(1)} vs current)</div>
                  </button>
                ))}
                {Object.keys(suggestions).length === 0 && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#161c28] p-3 text-xs text-[#9aa5bb]">
                    Run Smart Coach to generate lineup recommendations.
                  </div>
                )}
              </div>
              <button
                onClick={analyzeLineups}
                disabled={analyzing || mySquad.length <= 5}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-xs font-semibold text-[#e8edf5] hover:border-[#00e676]/70 hover:text-[#00e676] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Analyze Full Bench
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// --- Components ---

function ComparisonStat({ title, mine, opp }) {
  const delta = Number((mine - opp).toFixed(1));
  const deltaPositive = delta >= 0;

  return (
    <div>
      <div className="mb-1 flex items-end justify-between gap-3">
        <div className="inline-flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#6b7a94]">{title}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${deltaPositive ? 'border-[#00e676]/40 bg-[#00e676]/10 text-[#00e676]' : 'border-[#ff4444]/40 bg-[#ff4444]/10 text-[#ff4444]'}`}>
            {deltaPositive ? '+' : ''}{delta} vs Opp
          </span>
        </div>
        <div className="flex items-end gap-1">
          <span className="font-['Barlow_Condensed'] text-2xl font-bold text-[#00e676]">{mine.toFixed(1)}</span>
          <span className="font-['Barlow_Condensed'] text-lg font-semibold text-[#9aa5bb]">/ {opp.toFixed(1)}</span>
        </div>
      </div>
      <div className="relative h-1.5 rounded bg-[#161c28]">
        <div className="absolute left-0 top-0 h-1.5 rounded bg-[#00e676]" style={{ width: `${Math.max(0, Math.min(100, mine))}%` }} />
        <div className="absolute top-[-2px] h-2.5 w-1 rounded bg-[#ffab00]" style={{ left: `${Math.max(0, Math.min(100, opp))}%` }} />
      </div>
    </div>
  );
}

function OutcomeBar({ label, value, color, textClass }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-10 text-[11px] font-bold uppercase tracking-[0.08em] text-[#6b7a94]">{label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded bg-[#161c28]">
        <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }} />
      </div>
      <div className={`w-12 text-right font-['Barlow_Condensed'] text-base font-bold ${textClass}`}>{value.toFixed(1)}%</div>
    </div>
  );
}

function AssetAvatar({ player }) {
  const [imageSrc, setImageSrc] = useState(player.imageUrl || null);

  useEffect(() => {
    let cancelled = false;
    if (player.imageUrl) {
      setImageSrc(player.imageUrl);
      return undefined;
    }
    if (!player.assetId) {
      setImageSrc(null);
      return undefined;
    }

    const controller = new AbortController();
    resolvePlayerImage({ assetId: player.assetId, imageUrl: player.imageUrl }, controller.signal).then((resolved) => {
      if (!cancelled) {
        setImageSrc(resolved || null);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [player.assetId, player.imageUrl, player.id]);

  const badgeClass = player.pos === 'GK'
    ? 'bg-[#b8860b] text-white'
    : player.pos === 'DF'
      ? 'bg-[#1e5fa8] text-white'
      : player.pos === 'MF'
        ? 'bg-[#1a7a3a] text-white'
        : 'bg-[#cc3333] text-white';

  return (
    <div className="relative h-[52px] w-[52px] shrink-0">
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={player.name}
          className="h-full w-full rounded-[9px] border border-[#253040] bg-[#161c28] object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-[9px] border border-[#253040] bg-[#161c28] text-[10px] font-bold text-[#9aa5bb]">
          NFT
        </div>
      )}
      <div
        className={`absolute -bottom-1 -right-1 rounded-[4px] px-1.5 py-0.5 font-['Barlow_Condensed'] text-[10px] font-bold leading-none ${badgeClass}`}
        style={{ border: '1.5px solid #111620' }}
      >
        {player.pos}
      </div>
    </div>
  );
}

function StatCell({ label, baseValue, boostedValue, isLast }) {
  const base = Number(baseValue ?? 0);
  const boosted = Number(boostedValue ?? base);
  const delta = boosted - base;
  const isUp = delta > 0;
  const isDown = delta < 0;
  const separator = delta === 0 ? '—' : '→';
  const boostedClass = isUp ? 'text-[#00e676]' : isDown ? 'text-[#ff4444]' : 'text-[#6b7a94]';

  return (
    <div className={`relative px-4 py-2.5 ${isLast ? '' : 'border-r border-[#1e2a3a]'}`}>
      {isUp && <div className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full bg-[#00e676] shadow-[0_0_6px_#00e676]" />}
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7a94]">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-['Barlow_Condensed'] text-[22px] font-bold leading-none text-[#e8edf5]">{base}</span>
        <span className={`text-xs ${delta === 0 ? 'text-[#1e2a3a]' : 'text-[#253040]'}`}>{separator}</span>
        <span className={`font-['Barlow_Condensed'] text-base font-bold leading-none ${boostedClass}`}>{boosted}</span>
      </div>
    </div>
  );
}

function PlayerRow({ player, onEdit, onDelete, isEditing, onInjuryChange, isActive, isBench, onSwap }) {
  const [injuryMenuOpen, setInjuryMenuOpen] = useState(false);

  const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1.0;
  const scores = {
    CTL: getControlScore(player.stats, player.pos, injuryMod),
    ATT: getAttackScore(player.stats, player.pos, injuryMod),
    DEF: getDefenseScore(player.stats, player.pos, injuryMod),
  };

  const handleInjurySelect = (sev) => {
    onInjuryChange(sev === 'None' ? null : sev);
    setInjuryMenuOpen(false);
  };

  const source = player.source || 'manual';
  const sourceBadgeClass = source === 'wallet'
    ? 'bg-[rgba(41,121,255,0.12)] text-[#5b9cff] border-[rgba(41,121,255,0.3)]'
    : source === 'team-url'
      ? 'bg-[rgba(0,229,204,0.1)] text-[#00e5cc] border-[rgba(0,229,204,0.3)]'
      : 'bg-[#1a2133] text-[#9aa5bb] border-[#253040]';
  const sourceLabel = source === 'wallet'
    ? 'Wallet'
    : source === 'team-url'
      ? 'Team URL'
      : source === 'upload'
        ? 'Upload'
        : 'Manual';

  const statCells = player.pos === 'GK'
    ? [
      { key: 'ctl', label: 'Control', base: player.stats.CTL, boosted: scores.CTL },
      { key: 'gkp', label: 'GK Power', base: player.stats.GKP, boosted: scores.DEF },
    ]
    : [
      { key: 'ctl', label: 'Control', base: player.stats.CTL, boosted: scores.CTL },
      { key: 'att', label: 'Attack', base: player.stats.ATT, boosted: scores.ATT },
      { key: 'def', label: 'Defense', base: player.stats.DEF, boosted: scores.DEF },
    ];

  const canSwap = typeof onSwap === 'function' && (isActive || isBench);

  return (
    <div className={`relative overflow-hidden rounded-xl border bg-[#111620] transition-colors ${isEditing ? 'border-[#ffab00]' : 'border-[#1e2a3a] hover:border-[#253040]'} ${injuryMenuOpen ? 'z-50' : 'z-0'}`}>
      <div
        className={`flex items-center gap-3.5 px-4 pb-3 pt-3.5 ${canSwap ? 'cursor-pointer' : ''}`}
        onClick={canSwap ? onSwap : undefined}
      >
        <AssetAvatar player={player} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-[#e8edf5]">{player.name}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#9aa5bb]">
              <Zap size={11} /> {player.stats.SPD}
            </span>
            <span className={`rounded-[3px] border px-2 py-0.5 text-[10px] font-bold ${sourceBadgeClass}`}>{sourceLabel}</span>
            {player.injury && INJURIES[player.injury] && (
              <span className="rounded-[3px] border border-[rgba(255,68,68,0.35)] bg-[rgba(255,68,68,0.12)] px-2 py-0.5 text-[10px] font-bold text-[#ff4444]">
                {INJURIES[player.injury].label}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7a94]">OVR</div>
          <div className="font-['Barlow_Condensed'] text-[36px] font-black leading-none text-[#e8edf5]">{player.ovr}</div>
        </div>
      </div>

      <div className={`grid border-t border-[#1e2a3a] ${player.pos === 'GK' ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {statCells.map((cell, index) => (
          <StatCell
            key={cell.key}
            label={cell.label}
            baseValue={cell.base}
            boostedValue={cell.boosted}
            isLast={index === statCells.length - 1}
          />
        ))}
      </div>

      <div className="relative flex items-center justify-end gap-4 border-t border-[#1e2a3a] px-4 py-2">
        <button
          onClick={() => setInjuryMenuOpen(!injuryMenuOpen)}
          className="inline-flex items-center gap-1 text-xs font-medium text-[#6b7a94] transition-colors hover:text-[#e8edf5]"
        >
          <Plus size={13} /> Stats
        </button>
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1 text-xs font-medium text-[#6b7a94] transition-colors hover:text-[#e8edf5]"
        >
          <Pencil size={13} /> Edit
        </button>
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1 text-xs font-medium text-[#6b7a94] transition-colors hover:text-[#ff4444]"
        >
          <Trash2 size={13} /> Remove
        </button>

        {injuryMenuOpen && (
          <div className="absolute right-4 top-full mt-2 min-w-[150px] rounded-lg border border-[#1e2a3a] bg-[#111620] p-1 shadow-2xl ring-1 ring-white/10">
            <div className="mb-1 border-b border-[#1e2a3a] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#6b7a94]">Set Condition</div>
            {Object.keys(INJURIES).map((sev) => (
              <button
                key={sev}
                onClick={() => handleInjurySelect(sev)}
                className={`flex w-full items-center justify-between rounded px-2 py-2 text-xs hover:bg-[#161c28] ${player.injury === sev || (!player.injury && sev === 'None') ? 'bg-[#161c28]' : ''}`}
              >
                <span className={INJURIES[sev].text}>{INJURIES[sev].label}</span>
                {(player.injury === sev || (!player.injury && sev === 'None')) && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
