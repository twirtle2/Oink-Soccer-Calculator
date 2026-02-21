const FORMATION_CANDIDATES = [
  { key: 'Diamond', regex: /(DIAMOND|1\s*[-:]\s*2\s*[-:]\s*1)/i },
  { key: 'Pyramid', regex: /(PYRAMID|2\s*[-:]\s*1\s*[-:]\s*1)/i },
  { key: 'Y', regex: /(\bTHE\s*Y\b|1\s*[-:]\s*1\s*[-:]\s*2)/i },
  { key: 'Box', regex: /(\bBOX\b|2\s*[-:]\s*0\s*[-:]\s*2)/i },
];

const OCR_FIXUPS = [
  [/CT1/g, 'CTL'],
  [/CT\|/g, 'CTL'],
  [/SP0/g, 'SPD'],
  [/ATTI/g, 'ATT'],
  [/GKP\./g, 'GKP'],
];

const normalizeText = (value = '') => {
  let text = value.toUpperCase();
  for (const [pattern, replacement] of OCR_FIXUPS) {
    text = text.replace(pattern, replacement);
  }
  return text;
};

const detectFormationKey = (fullText) => {
  const source = normalizeText(fullText);
  for (const candidate of FORMATION_CANDIDATES) {
    if (candidate.regex.test(source)) {
      return candidate.key;
    }
  }
  return 'Pyramid';
};

const extractStatPairs = (line) => {
  const matches = [...line.matchAll(/\b(DEF|CTL|ATT|SPD|GKP)\b\s*[:;.\-]?\s*(\d{1,3})/g)];
  return matches
    .map((match) => ({
      key: match[1],
      val: Math.max(0, Math.min(100, Number.parseInt(match[2], 10))),
    }))
    .filter((entry) => Number.isFinite(entry.val));
};

const isLikelyNameLine = (line) => {
  if (!line) return false;
  if (line.includes(':')) return false;
  if (line.includes('|')) return false;
  if (line.includes('THE DIAMOND') || line.includes('THE PYRAMID') || line.includes('THE BOX') || line.includes('THE Y')) return false;
  if (line.includes('CONNECT WALLET') || line.includes('SYNC')) return false;
  if (!/[A-Z]/.test(line)) return false;
  return line.length >= 3;
};

const cleanName = (line) => {
  return line
    .replace(/[^A-Z0-9.'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const inferPosition = (stats = {}, explicitPos = null) => {
  if (explicitPos && ['GK', 'DF', 'MF', 'FW'].includes(explicitPos)) {
    return explicitPos;
  }
  if ((stats.GKP || 0) >= 55) return 'GK';
  const att = stats.ATT || 0;
  const ctl = stats.CTL || 0;
  const def = stats.DEF || 0;
  if (att >= ctl && att >= def) return 'FW';
  if (def >= ctl && def >= att) return 'DF';
  return 'MF';
};

const hasEnoughStats = (stats = {}) => {
  const count = ['SPD', 'ATT', 'CTL', 'DEF', 'GKP'].filter((key) => Number.isFinite(stats[key])).length;
  return count >= 3 && Number.isFinite(stats.SPD);
};

const normalizeOcrLines = (dataOrText) => {
  if (!dataOrText) return [];
  if (typeof dataOrText === 'string') {
    return normalizeText(dataOrText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  const rawLines = [];
  if (Array.isArray(dataOrText.lines)) {
    for (const line of dataOrText.lines) {
      if (line?.text) rawLines.push(line.text);
    }
  }
  if (typeof dataOrText.text === 'string' && rawLines.length === 0) {
    rawLines.push(...dataOrText.text.split(/\r?\n/));
  }
  return rawLines.map((line) => normalizeText(line).trim()).filter(Boolean);
};

const finalizeCandidate = (candidate, players, seen, autoIndex) => {
  if (!candidate || !hasEnoughStats(candidate.stats)) {
    return autoIndex;
  }

  const pos = inferPosition(candidate.stats, candidate.pos);
  const normalizedStats = {
    SPD: candidate.stats.SPD || 50,
    ATT: pos === 'GK' ? (candidate.stats.ATT || 0) : (candidate.stats.ATT || 50),
    CTL: candidate.stats.CTL || 50,
    DEF: candidate.stats.DEF || 50,
    GKP: pos === 'GK' ? (candidate.stats.GKP || 50) : (candidate.stats.GKP || 0),
  };
  const name = candidate.name || `Opponent ${autoIndex}`;

  const signature = `${name}-${pos}-${normalizedStats.SPD}-${normalizedStats.ATT}-${normalizedStats.CTL}-${normalizedStats.DEF}-${normalizedStats.GKP}`;
  if (seen.has(signature)) {
    return autoIndex;
  }
  seen.add(signature);

  players.push({
    name,
    pos,
    stats: normalizedStats,
  });
  return autoIndex + 1;
};

const parsePlayersFromOcrData = (ocrData) => {
  const lines = normalizeOcrLines(ocrData);
  const players = [];
  const seen = new Set();

  let current = null;
  let autoIndex = 1;
  let consecutiveNonDataLines = 0;

  for (const line of lines) {
    const posMatch = line.match(/\b(GK|DF|MF|FW)\b/);
    const statPairs = extractStatPairs(line);
    const isName = isLikelyNameLine(line);

    if (isName && statPairs.length === 0 && !posMatch) {
      consecutiveNonDataLines += 1;
      autoIndex = finalizeCandidate(current, players, seen, autoIndex);
      current = { name: cleanName(line), stats: {}, pos: null };
      continue;
    }

    if (statPairs.length > 0 || posMatch) {
      consecutiveNonDataLines = 0;
      if (!current) current = { name: null, stats: {}, pos: null };
      if (posMatch && !current.pos) current.pos = posMatch[1];
      for (const { key, val } of statPairs) {
        current.stats[key] = val;
      }
      continue;
    }

    consecutiveNonDataLines += 1;
    if (consecutiveNonDataLines >= 2) {
      autoIndex = finalizeCandidate(current, players, seen, autoIndex);
      current = null;
      consecutiveNonDataLines = 0;
    }
  }

  autoIndex = finalizeCandidate(current, players, seen, autoIndex);

  // Fallback pass: if names are mostly missing, keep parsed stats but ensure unique auto names.
  const unnamedCount = players.filter((player) => player.name.startsWith('Opponent ')).length;
  if (players.length > 0 && unnamedCount === players.length) {
    players.forEach((player, idx) => {
      player.name = `Opponent ${idx + 1}`;
    });
  }

  return players;
};

const resolveRecognize = async () => {
  const mod = await import('tesseract.js');
  const recognize = mod?.recognize || mod?.default?.recognize;
  if (typeof recognize !== 'function') {
    throw new Error('Tesseract failed to load.');
  }
  return recognize;
};

export const parseOpponentScreenshotsLocally = async (files, onProgress) => {
  const recognize = await resolveRecognize();
  const allPlayers = [];
  const formationVotes = [];
  let processed = 0;
  let failedFiles = 0;

  for (const file of files) {
    try {
      const result = await recognize(file, 'eng');
      const text = result?.data?.text || '';
      const players = parsePlayersFromOcrData(result?.data || text);
      if (players.length > 0) {
        allPlayers.push(...players);
      }
      formationVotes.push(detectFormationKey(text));
    } catch (error) {
      console.error('Local OCR failed for file:', file?.name, error);
      failedFiles += 1;
    } finally {
      processed += 1;
      if (typeof onProgress === 'function') {
        onProgress(processed, files.length);
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const player of allPlayers) {
    const signature = `${player.name}-${player.pos}-${player.stats.SPD}-${player.stats.ATT}-${player.stats.CTL}-${player.stats.DEF}-${player.stats.GKP}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(player);
  }

  const formationTally = formationVotes.reduce((acc, key) => {
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const detectedFormationKey =
    Object.entries(formationTally).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Pyramid';

  return {
    players: deduped,
    detectedFormationKey,
    failedFiles,
  };
};
