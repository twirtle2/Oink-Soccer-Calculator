import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, Users, Zap, Activity, Pencil, Save, RotateCcw, Loader2, Bandage, X, TrendingUp, ChevronDown, ChevronUp, RefreshCw, ArrowDownWideNarrow, ArrowUpNarrowWide, Link2 } from 'lucide-react';
import { useWallet } from '@txnlab/use-wallet-react';
import WalletConnector from './components/WalletConnector';
import { loadCalculatorState, saveCalculatorState } from './lib/storage';
import { loadPlayableCatalog } from './lib/playableCatalog';
import { fetchHeldAssetIdsForAddresses } from './lib/indexer';
import { buildWalletPlayers, mergeWalletPlayers } from './lib/walletSync';
import {
  fetchLeagueTableTeams,
  fetchLeagueTeamsIndex,
  findTeamsByName,
  importOpponentFromTeamInput,
  resolveOwnedTeamLeagues,
} from './lib/lostPigsTeamImport';
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
  const [leagueIndex, setLeagueIndex] = useState(null);
  const [leagueIndexLoading, setLeagueIndexLoading] = useState(false);
  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [selectedLeagueName, setSelectedLeagueName] = useState('');
  const [leagueTeams, setLeagueTeams] = useState([]);
  const [leagueTeamsLoading, setLeagueTeamsLoading] = useState(false);
  const [detectedMyTeamIds, setDetectedMyTeamIds] = useState([]);
  const [opponentSearchInput, setOpponentSearchInput] = useState('');
  const [selectedOpponentTeamId, setSelectedOpponentTeamId] = useState('');
  const [catalogSeason, setCatalogSeason] = useState(null);
  const [walletSyncing, setWalletSyncing] = useState(false);

  const [mySquad, setMySquad] = useState(persistedState.mySquad || initialMyTeam); // Full roster
  const [myTeam, setMyTeam] = useState(persistedState.myTeam || initialMyTeam.slice(0, 5)); // Active 5
  const [opponentTeam, setOpponentTeam] = useState(persistedState.opponentTeam || initialOpponent);
  const [myForm, setMyForm] = useState(persistedState.myForm || 'Pyramid');
  const [oppForm, setOppForm] = useState(persistedState.oppForm || 'Pyramid');

  const [myBoost, setMyBoost] = useState(persistedState.myBoost || 'None');
  const [myBoostApps] = useState(persistedState.myBoostApps || 1);
  const [homeAdvantage, setHomeAdvantage] = useState(persistedState.homeAdvantage || 'home'); // 'home' or 'away'
  const [walletSyncMeta, setWalletSyncMeta] = useState(
    persistedState.walletSyncMeta || {
      lastSyncedAt: null,
      matchedCount: 0,
      unmatchedCount: 0,
      lastError: null,
    },
  );

  const [activeTab, setActiveTab] = useState('squad');
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
  const [injuryModalState, setInjuryModalState] = useState({
    open: false,
    playerId: null,
    teamType: null,
    selected: 'None',
  });

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

  const leagueOptions = useMemo(() => {
    const byLeague = leagueIndex?.byLeague || {};
    return Object.keys(byLeague)
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => ({ id, label: `League ${id}` }));
  }, [leagueIndex]);

  const filteredOpponentOptions = useMemo(() => {
    const blocked = new Set(detectedMyTeamIds);
    const candidates = (leagueTeams || []).filter((team) => !blocked.has(team.teamId));
    return findTeamsByName(candidates, opponentSearchInput).slice(0, 25);
  }, [detectedMyTeamIds, leagueTeams, opponentSearchInput]);

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

  useEffect(() => {
    let cancelled = false;
    setLeagueIndexLoading(true);

    void fetchLeagueTeamsIndex()
      .then((index) => {
        if (cancelled) return;
        setLeagueIndex(index);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load league teams.';
        setUploadStatus({ tone: 'error', message });
      })
      .finally(() => {
        if (!cancelled) {
          setLeagueIndexLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!leagueIndex) return;

    let cancelled = false;

    const detectMyLeague = async () => {
      if (connectedAddresses.length === 0) {
        if (!cancelled) {
          setDetectedMyTeamIds([]);
        }
        return;
      }

      try {
        const heldAssetIds = await fetchHeldAssetIdsForAddresses(connectedAddresses);
        if (cancelled) return;

        const resolved = resolveOwnedTeamLeagues(heldAssetIds, leagueIndex);
        setDetectedMyTeamIds(resolved.ownedTeamIds);

        if (!selectedLeagueId && resolved.preferredLeagueId) {
          setSelectedLeagueId(resolved.preferredLeagueId);
        }
      } catch (_) {
        if (!cancelled) {
          setDetectedMyTeamIds([]);
        }
      }
    };

    void detectMyLeague();

    return () => {
      cancelled = true;
    };
  }, [connectedAddresses, leagueIndex, selectedLeagueId]);

  useEffect(() => {
    if (!selectedLeagueId) {
      setLeagueTeams([]);
      setSelectedLeagueName('');
      return;
    }

    let cancelled = false;
    setLeagueTeamsLoading(true);

    void fetchLeagueTableTeams(selectedLeagueId)
      .then((payload) => {
        if (cancelled) return;
        setLeagueTeams(payload.teams);
        setSelectedLeagueName(payload.leagueName);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load league table teams.';
        setUploadStatus({ tone: 'error', message });
        setLeagueTeams([]);
        setSelectedLeagueName('');
      })
      .finally(() => {
        if (!cancelled) {
          setLeagueTeamsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLeagueId]);

  useEffect(() => {
    if (!selectedOpponentTeamId) return;
    if (filteredOpponentOptions.some((team) => team.teamId === selectedOpponentTeamId)) return;
    setSelectedOpponentTeamId('');
  }, [filteredOpponentOptions, selectedOpponentTeamId]);

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

  const importOpponentFromInput = useCallback(async (teamInput) => {
    if (importingTeamUrl) return;

    setImportingTeamUrl(true);
    setUploadStatus({ tone: 'info', message: 'Fetching opponent lineup from Lost Pigs API...' });

    try {
      const imported = await importOpponentFromTeamInput(teamInput);
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
        message: err instanceof Error ? err.message : 'Team import failed.',
      });
    } finally {
      setImportingTeamUrl(false);
    }
  }, [importingTeamUrl, oppForm, saveToDb]);

  const handleImportTeamUrl = useCallback(async () => {
    if (!teamUrlInput.trim()) {
      setUploadStatus({ tone: 'error', message: 'Enter a Lost Pigs team URL or teamId first.' });
      return;
    }
    await importOpponentFromInput(teamUrlInput.trim());
  }, [importOpponentFromInput, teamUrlInput]);

  const handleImportSelectedOpponent = useCallback(async () => {
    const candidateTeamId = selectedOpponentTeamId || filteredOpponentOptions[0]?.teamId;
    if (!candidateTeamId) {
      setUploadStatus({ tone: 'error', message: 'Select an opponent team first.' });
      return;
    }
    await importOpponentFromInput(candidateTeamId);
  }, [filteredOpponentOptions, importOpponentFromInput, selectedOpponentTeamId]);

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

  const handleHomeAwayToggle = (value) => {
    setHomeAdvantage(value);
    saveToDb({ homeAdvantage: value });
  }

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

  const handleStatChange = (k, v) => setNewPlayer(prev => ({ ...prev, stats: { ...prev.stats, [k]: parseInt(v) || 0 } }));

  const handleInjuryChange = useCallback((player, severity, teamType) => {
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
  }, [mySquad, myTeam, opponentTeam, saveToDb]);

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

  const benchPool = useMemo(() => {
    const activeIds = new Set(myTeam.map(p => p.id));
    return mySquad.filter(p => !activeIds.has(p.id));
  }, [mySquad, myTeam]);

  const benchPlayers = useMemo(() => {
    let players = [...benchPool];

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
  }, [benchPool, benchFilter, benchSort]);

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

  const tabItems = useMemo(() => ([
    { key: 'squad', icon: '👥', label: 'Squad' },
    { key: 'opponent', icon: '⚔️', label: 'Opponent' },
    { key: 'conditions', icon: '⚡', label: 'Conditions' },
    { key: 'simulation', icon: '📊', label: 'Simulation' },
    { key: 'bench', icon: '🪑', label: 'Bench' },
  ]), []);

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

  const openInjuryModal = useCallback((player, teamType) => {
    setInjuryModalState({
      open: true,
      playerId: player.id,
      teamType,
      selected: player.injury || 'None',
    });
  }, []);

  const closeInjuryModal = useCallback(() => {
    setInjuryModalState({
      open: false,
      playerId: null,
      teamType: null,
      selected: 'None',
    });
  }, []);

  const confirmInjuryModal = useCallback(() => {
    if (!injuryModalState.playerId || !injuryModalState.teamType) {
      closeInjuryModal();
      return;
    }
    const player = injuryModalState.teamType === 'opponent'
      ? opponentTeam.find((p) => p.id === injuryModalState.playerId)
      : mySquad.find((p) => p.id === injuryModalState.playerId);
    if (player) {
      handleInjuryChange(player, injuryModalState.selected, injuryModalState.teamType);
    }
    closeInjuryModal();
  }, [closeInjuryModal, handleInjuryChange, injuryModalState, mySquad, opponentTeam]);

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
    <div className="min-h-screen bg-[#0a0d12] text-[#e8edf5] font-sans pb-8">
      <header className="sticky top-0 z-[100] border-b border-[#1e2a3a] bg-[#111620]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 md:px-6">
          <div className="min-w-0">
            <div className="truncate font-['Barlow_Condensed'] text-xl font-black leading-none tracking-[0.04em] md:text-2xl">
              <span className="text-[#00e676]">OINK</span> SOCCER CALCULATOR
            </div>
            <div className="text-[11px] text-[#6b7a94]">Season {catalogSeason ?? 'Unknown'}</div>
          </div>
          <div className="flex items-center gap-2">
            <WalletConnector
              onSync={handleSyncWalletAssets}
              isSyncing={walletSyncing}
              syncMeta={walletSyncMeta}
            />
          </div>
        </div>
      </header>

      <nav className="sticky top-14 z-[99] border-b border-[#1e2a3a] bg-[#111620]">
        <div className="mx-auto max-w-[1200px] overflow-x-auto px-2 md:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max items-center gap-1">
            {tabItems.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative flex items-center gap-1.5 px-4 py-3 text-sm font-semibold transition ${
                    isActive ? 'text-[#e8edf5]' : 'text-[#6b7a94] hover:text-[#9aa5bb]'
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {tab.key === 'bench' && (
                    <span className="rounded-full border border-[#253040] bg-[#1a2233] px-1.5 py-0.5 text-[10px] leading-none text-[#9aa5bb]">
                      {benchPool.length}
                    </span>
                  )}
                  {isActive && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-t bg-[#00e676]" />}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <section className="border-b border-[#1e2a3a] bg-[linear-gradient(135deg,#161c28,rgba(0,230,118,0.05))]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-6 px-4 py-3 md:px-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#6b7a94]">Win Probability</div>
            <div className="font-['Barlow_Condensed'] text-[42px] font-black leading-none text-[#00e676]">{simulation.win}%</div>
            <div className="text-[11px] text-[#6b7a94]">Based on {(Number(simulation.myxG) + Number(simulation.oppxG)).toFixed(2)} simulated goals</div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#00e676]">{simulation.myxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">You</div>
            </div>
            <div className="pb-1 font-['Barlow_Condensed'] text-2xl text-[#6b7a94]">:</div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[28px] font-black leading-none text-[#ffab00]">{simulation.oppxG}</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Opp</div>
            </div>
          </div>

          <div className="hidden items-end gap-5 sm:flex">
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#00e676]">{forecastWin.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Win</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#9aa5bb]">{forecastDraw.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Draw</div>
            </div>
            <div className="text-center">
              <div className="font-['Barlow_Condensed'] text-[20px] font-bold text-[#ff4444]">{forecastLoss.toFixed(1)}%</div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-[#6b7a94]">Loss</div>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-[900px] px-4 py-5 md:px-6 md:py-6">
        {activeTab === 'squad' && (
          <section id="tab-squad" className="space-y-4">
            <div className="grid grid-cols-1 gap-3 rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4 md:grid-cols-[1fr_auto_1fr]">
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e676]">▲ My Team</div>
                <select
                  value={myForm}
                  onChange={(e) => handleFormChange('my', e.target.value)}
                  className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#00e676]"
                >
                  {Object.keys(FORMATIONS).map((k) => (
                    <option key={k} value={k}>{FORMATIONS[k].name}</option>
                  ))}
                </select>
              </div>
              <div className="hidden flex-col items-center justify-center md:flex">
                <div className="h-4 w-px bg-[#1e2a3a]" />
                <div className="font-['Barlow_Condensed'] text-xl font-black text-[#6b7a94]">VS</div>
                <div className="h-4 w-px bg-[#1e2a3a]" />
              </div>
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#ffab00]">▼ Opponent</div>
                <select
                  value={oppForm}
                  onChange={(e) => handleFormChange('opp', e.target.value)}
                  className="w-full rounded-md border border-[#1e2a3a] bg-[#161c28] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#ffab00]"
                >
                  {Object.keys(FORMATIONS).map((k) => (
                    <option key={k} value={k}>{FORMATIONS[k].name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              {myTeam.map((p) => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  teamType="myTeam"
                  onInjuryOpen={() => openInjuryModal(p, 'myTeam')}
                />
              ))}
              {myTeam.length === 0 && (
                <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No active lineup yet.</div>
              )}
            </div>

            <div id="player-form" className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <button
                onClick={() => setShowManualForm(!showManualForm)}
                className="mb-3 flex w-full items-center justify-between text-sm font-semibold text-[#9aa5bb]"
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
        )}

        {activeTab === 'opponent' && (
          <section id="tab-opponent" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="mb-1 text-sm font-bold">⟳ Import Opponent</div>
              <div className="mb-3 text-xs text-[#6b7a94]">Search opponents by team name in the same league as your club.</div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px,1fr,auto]">
                <select
                  value={selectedLeagueId}
                  onChange={(e) => {
                    setSelectedLeagueId(e.target.value);
                    setSelectedOpponentTeamId('');
                    setOpponentSearchInput('');
                  }}
                  disabled={importingTeamUrl || leagueIndexLoading}
                  className="rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                >
                  <option value="">{leagueIndexLoading ? 'Loading leagues...' : 'Select league'}</option>
                  {leagueOptions.map((league) => (
                    <option key={league.id} value={league.id}>{league.label}</option>
                  ))}
                </select>

                <input
                  type="text"
                  value={opponentSearchInput}
                  onChange={(e) => {
                    setOpponentSearchInput(e.target.value);
                    setSelectedOpponentTeamId('');
                  }}
                  placeholder={selectedLeagueId ? 'Search opponent by team name...' : 'Select a league first'}
                  className="min-w-0 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                  disabled={importingTeamUrl || !selectedLeagueId || leagueTeamsLoading}
                />

                <button
                  onClick={() => void handleImportSelectedOpponent()}
                  disabled={importingTeamUrl || !selectedLeagueId || leagueTeamsLoading || filteredOpponentOptions.length === 0}
                  className="rounded-md bg-[#2979ff] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700"
                >
                  {importingTeamUrl ? 'Loading...' : 'Import Selected'}
                </button>
              </div>

              <div className="mt-2 rounded-md border border-[#1e2a3a] bg-[#111620] p-2">
                <div className="mb-1 text-[11px] uppercase tracking-[0.1em] text-[#6b7a94]">
                  {selectedLeagueId
                    ? `Teams${selectedLeagueName ? ` • ${selectedLeagueName}` : ''}`
                    : 'Teams'}
                </div>

                {leagueTeamsLoading && (
                  <div className="text-xs text-[#9aa5bb]">Loading league teams...</div>
                )}

                {!leagueTeamsLoading && !selectedLeagueId && (
                  <div className="text-xs text-[#9aa5bb]">Choose a league to browse opponent teams.</div>
                )}

                {!leagueTeamsLoading && selectedLeagueId && filteredOpponentOptions.length === 0 && (
                  <div className="text-xs text-[#9aa5bb]">
                    {opponentSearchInput.trim() ? 'No teams match your search.' : 'No opponent teams available.'}
                  </div>
                )}

                {!leagueTeamsLoading && selectedLeagueId && filteredOpponentOptions.length > 0 && (
                  <div className="max-h-40 space-y-1 overflow-auto pr-1">
                    {filteredOpponentOptions.map((team) => (
                      <button
                        key={team.teamId}
                        onClick={() => setSelectedOpponentTeamId(team.teamId)}
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition ${
                          selectedOpponentTeamId === team.teamId
                            ? 'border-[#2979ff] bg-[#0f1f39] text-[#9fc6ff]'
                            : 'border-[#1e2a3a] bg-[#141a26] text-[#d0d7e5] hover:border-[#2f3f59]'
                        }`}
                      >
                        <div className="font-semibold">{team.teamName}</div>
                        <div className="text-[10px] text-[#7f8aa3]">{team.teamId}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 border-t border-[#1e2a3a] pt-3">
                <div className="mb-2 text-xs font-semibold text-[#9aa5bb]">Manual fallback: URL or teamId</div>
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
                    className="min-w-0 flex-1 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-sm text-[#e8edf5] outline-none focus:border-[#2979ff]"
                    disabled={importingTeamUrl}
                  />
                  <button
                    onClick={() => void handleImportTeamUrl()}
                    disabled={importingTeamUrl}
                    className="rounded-md bg-[#24344f] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700"
                  >
                    {importingTeamUrl ? 'Loading...' : 'Import URL'}
                  </button>
                </div>
              </div>

              {uploadStatus && (
                <div className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${
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

            {opponentTeam.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                teamType="opponent"
                onInjuryOpen={() => openInjuryModal(p, 'opponent')}
              />
            ))}
            {opponentTeam.length === 0 && (
              <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No opponent lineup imported yet.</div>
            )}
          </section>
        )}

        {activeTab === 'conditions' && (
          <section id="tab-conditions" className="space-y-4">
            <div className="grid grid-cols-1 gap-3 min-[500px]:grid-cols-2">
              <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">📍 Location</div>
                <div className="space-y-2">
                  <button
                    onClick={() => handleHomeAwayToggle('home')}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm ${homeAdvantage === 'home' ? 'border-[#00e676] bg-[#111620] text-[#00e676]' : 'border-[#1e2a3a] text-[#9aa5bb]'}`}
                  >
                    🏠 Home (+5% ATT / +3% DEF)
                  </button>
                  <button
                    onClick={() => handleHomeAwayToggle('away')}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm ${homeAdvantage === 'away' ? 'border-[#00e676] bg-[#111620] text-[#00e676]' : 'border-[#1e2a3a] text-[#9aa5bb]'}`}
                  >
                    ✈️ Away (-3% ATT / -2% DEF)
                  </button>
                </div>
              </div>

              <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6b7a94]">⚡ Active Boost</div>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(BOOSTS).map((key) => (
                    <button
                      key={key}
                      onClick={() => handleBoostChange(key)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                        myBoost === key
                          ? key === 'None'
                            ? 'border-[#253040] bg-[#161c28] text-[#e8edf5]'
                            : 'border-[#ffab00] bg-[#ffab00] text-black'
                          : 'border-[#1e2a3a] bg-[#111620] text-[#9aa5bb]'
                      }`}
                    >
                      {BOOSTS[key].label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <ComparisonStat title="Team Control" mine={myStats.Control} opp={oppStats.Control} />
              <div className="my-3" />
              <ComparisonStat title="Team Defense" mine={myStats.Defense} opp={oppStats.Defense} />
              <div className="my-3" />
              <ComparisonStat title="Eff. Attack" mine={myStats.Attack} opp={oppStats.Attack} />
            </div>

            <div className="rounded-lg border border-[rgba(0,230,118,0.18)] bg-[rgba(0,230,118,0.06)] px-4 py-3 text-sm text-[#9bd7bd]">
              ⚠️ <strong className="text-[#00e676]">Insight:</strong> {annotation}
            </div>
          </section>
        )}

        {activeTab === 'simulation' && (
          <section id="tab-result" className="space-y-4">
            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#161c28] p-4">
              <div className="mb-1 text-sm font-bold">⚡ Smart Coach</div>
              <div className="mb-3 text-xs text-[#6b7a94]">Lineup suggestions for this matchup</div>
              <div className="space-y-2">
                {Object.values(suggestions).sort((a, b) => b.win - a.win).slice(0, 3).map((sugg) => (
                  <button
                    key={sugg.formation}
                    onClick={() => applySuggestion(sugg)}
                    className="w-full rounded-md border border-[#1e2a3a] border-l-[3px] border-l-[#00e676] bg-[#111620] p-3 text-left text-xs text-[#9aa5bb]"
                  >
                    <strong className="text-[#00e676]">{FORMATIONS[sugg.formation].name}</strong> • {sugg.win.toFixed(1)}% ({sugg.diff >= 0 ? '+' : ''}{sugg.diff.toFixed(1)})
                  </button>
                ))}
                {Object.keys(suggestions).length === 0 && (
                  <div className="rounded-md border border-[#1e2a3a] bg-[#111620] p-3 text-xs text-[#9aa5bb]">
                    No suggestions yet. Analyze to generate matchup-specific recommendations.
                  </div>
                )}
              </div>
              <button
                onClick={analyzeLineups}
                disabled={analyzing || mySquad.length <= 5}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#1e2a3a] bg-[#111620] px-3 py-2 text-xs font-semibold text-[#e8edf5] hover:border-[#00e676]/70 hover:text-[#00e676] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Analyze Full Bench →
              </button>
            </div>

            <div className="rounded-[10px] border border-[#1e2a3a] bg-[#111620] p-4">
              <div className="mb-2 text-sm font-semibold">Outcome Forecast</div>
              <div className="space-y-2">
                <OutcomeBar label="Win" value={forecastWin} color="#00e676" textClass="text-[#00e676]" />
                <OutcomeBar label="Draw" value={forecastDraw} color="#6b7a94" textClass="text-[#9aa5bb]" />
                <OutcomeBar label="Loss" value={forecastLoss} color="#ff4444" textClass="text-[#ff4444]" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[#111620] p-3 text-center border border-[#1e2a3a]">
                <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">My Expected Goals</div>
                <div className="font-['Barlow_Condensed'] text-[28px] font-black text-[#00e676]">{simulation.myxG}</div>
                <div className="text-[11px] text-[#6b7a94]">You</div>
              </div>
              <div className="rounded-lg bg-[#111620] p-3 text-center border border-[#1e2a3a]">
                <div className="text-[10px] uppercase tracking-[0.1em] text-[#6b7a94]">Opponent xG</div>
                <div className="font-['Barlow_Condensed'] text-[28px] font-black text-[#ffab00]">{simulation.oppxG}</div>
                <div className="text-[11px] text-[#6b7a94]">Opponent</div>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'bench' && (
          <section id="tab-bench" className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {['All', 'GK', 'DF', 'MF', 'FW'].map((pos) => {
                const count = pos === 'All' ? benchPool.length : benchPool.filter((p) => p.pos === pos).length;
                return (
                  <button
                    key={pos}
                    onClick={() => setBenchFilter(pos)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${benchFilter === pos ? 'border-[#253040] bg-[#161c28] text-[#e8edf5]' : 'border-[#1e2a3a] bg-[#111620] text-[#9aa5bb]'}`}
                  >
                    {pos} ({count})
                  </button>
                );
              })}
              <button onClick={toggleSort} className="rounded-md border border-[#1e2a3a] bg-[#161c28] p-1.5 text-[#9aa5bb]">
                {benchSort === 'ovr_desc' ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />}
              </button>
            </div>

            {benchPlayers.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                teamType="mySquad"
                onInjuryOpen={() => openInjuryModal(p, 'mySquad')}
                onSwap={() => handleSwap(p)}
                isBench
              />
            ))}
            {benchPlayers.length === 0 && (
              <div className="rounded-md border border-dashed border-[#1e2a3a] p-4 text-sm text-[#6b7a94]">No bench players in this filter.</div>
            )}
          </section>
        )}
      </main>

      {injuryModalState.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-[320px] rounded-xl border border-[#253040] bg-[#161c28] p-6">
            <div className="text-[15px] font-bold">🩹 Injury Severity</div>
            <p className="mt-1 text-xs text-[#6b7a94]">Select how severely this player is injured if they play.</p>

            <div className="mt-4 space-y-2">
              {[
                { key: 'None', label: '⬜ No injury' },
                { key: 'Low', label: '🟡 Minor — 95% effectiveness' },
                { key: 'Mid', label: '🟠 Moderate — 90% effectiveness' },
                { key: 'High', label: '🔴 Severe — 85% effectiveness' },
              ].map((option) => (
                <button
                  key={option.key}
                  onClick={() => setInjuryModalState((prev) => ({ ...prev, selected: option.key }))}
                  className={`w-full rounded-[7px] border px-3 py-2 text-left text-sm ${injuryModalState.selected === option.key ? 'border-[#ffab00] bg-[rgba(255,171,0,0.08)] text-[#ffab00]' : 'border-[#1e2a3a] bg-[#111620] text-[#e8edf5]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={closeInjuryModal} className="rounded-md border border-[#1e2a3a] bg-transparent px-3 py-1.5 text-xs font-semibold text-[#9aa5bb]">Cancel</button>
              <button onClick={confirmInjuryModal} className="rounded-md bg-[#ffab00] px-3 py-1.5 text-xs font-bold text-black">Confirm</button>
            </div>
          </div>
        </div>
      )}
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
    <div className="relative h-[46px] w-[46px] shrink-0">
      {imageSrc ? (
        <img
          src={imageSrc}
          alt={player.name}
          className="h-full w-full rounded-[8px] border border-[#253040] bg-[#161c28] object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-[8px] border border-[#253040] bg-[#161c28] text-[10px] font-bold text-[#9aa5bb]">
          NFT
        </div>
      )}
      <div
        className={`absolute -bottom-1 -right-1 rounded-[3px] px-1 py-0.5 font-['Barlow_Condensed'] text-[9px] font-bold leading-none ${badgeClass}`}
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
    <div className={`relative px-[14px] py-2 ${isLast ? '' : 'border-r border-[#1e2a3a]'}`}>
      {isUp && <div className="absolute right-2 top-[7px] h-[5px] w-[5px] rounded-full bg-[#00e676] shadow-[0_0_5px_#00e676]" />}
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[#6b7a94]">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="font-['Barlow_Condensed'] text-[20px] font-bold leading-none text-[#e8edf5]">{base}</span>
        <span className="text-[10px] text-[#253040]">{separator}</span>
        <span className={`font-['Barlow_Condensed'] text-[14px] font-bold leading-none ${boostedClass}`}>{boosted}</span>
      </div>
    </div>
  );
}

function PlayerRow({ player, onInjuryOpen, onSwap, isBench }) {
  const injuryMod = player.injury && INJURIES[player.injury] ? INJURIES[player.injury].reduction : 1.0;
  const scores = {
    CTL: getControlScore(player.stats, player.pos, injuryMod),
    ATT: getAttackScore(player.stats, player.pos, injuryMod),
    DEF: getDefenseScore(player.stats, player.pos, injuryMod),
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

  const canSwap = typeof onSwap === 'function' && Boolean(isBench);

  return (
    <div className="mb-2.5 overflow-hidden rounded-[12px] border border-[#1e2a3a] bg-[#111620] transition-colors hover:border-[#253040]">
      <div
        className={`flex items-center gap-3 px-[14px] pb-[10px] pt-3 ${canSwap ? 'cursor-pointer' : ''}`}
        onClick={canSwap ? onSwap : undefined}
      >
        <AssetAvatar player={player} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-bold text-[#e8edf5]">{player.name}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#9aa5bb]">
              <Zap size={10} /> {player.stats.SPD}
            </span>
            <span className={`rounded-[3px] border px-[7px] py-0.5 text-[9px] font-bold ${sourceBadgeClass}`}>{sourceLabel}</span>
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

      <div className="flex items-center justify-end border-t border-[#1e2a3a] px-[14px] py-2">
        <button
          onClick={onInjuryOpen}
          className={`inline-flex items-center gap-1 rounded-[5px] border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
            player.injury
              ? 'border-[rgba(255,171,0,0.4)] bg-[rgba(255,171,0,0.08)] text-[#ffab00]'
              : 'border-[#1e2a3a] text-[#6b7a94] hover:border-[#ffab00] hover:text-[#ffab00]'
          }`}
        >
          🩹 {player.injury ? INJURIES[player.injury].label : 'Injury'}
        </button>
      </div>
    </div>
  );
}
