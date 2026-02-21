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

const extractStat = (line, key) => {
  const match = line.match(new RegExp(`${key}\\s*[:;\\-]?\\s*(\\d{1,3})`));
  if (!match) {
    return null;
  }
  const val = Number.parseInt(match[1], 10);
  if (!Number.isFinite(val)) {
    return null;
  }
  return Math.max(0, Math.min(100, val));
};

const isLikelyNameLine = (line) => {
  if (!line) return false;
  if (line.includes(':')) return false;
  if (line.includes('|')) return false;
  if (line.includes('THE DIAMOND') || line.includes('THE PYRAMID') || line.includes('THE BOX') || line.includes('THE Y')) return false;
  if (!/[A-Z]/.test(line)) return false;
  return line.length >= 3;
};

const cleanName = (line) => {
  return line
    .replace(/[^A-Z0-9.'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const parsePlayersFromOcrText = (rawText) => {
  const text = normalizeText(rawText);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const players = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const posMatch = line.match(/\b(GK|DF|MF|FW)\b\s*[\|/\\]?\s*(\d{2,3})?/);
    if (!posMatch) {
      continue;
    }

    const pos = posMatch[1];
    let name = null;
    const stats = {};
    const start = Math.max(0, i - 12);

    for (let j = i - 1; j >= start; j -= 1) {
      const prev = lines[j];
      if (!stats.DEF) stats.DEF = extractStat(prev, 'DEF');
      if (!stats.CTL) stats.CTL = extractStat(prev, 'CTL');
      if (!stats.ATT) stats.ATT = extractStat(prev, 'ATT');
      if (!stats.SPD) stats.SPD = extractStat(prev, 'SPD');
      if (!stats.GKP) stats.GKP = extractStat(prev, 'GKP');

      if (!name && isLikelyNameLine(prev)) {
        name = cleanName(prev);
      }
    }

    if (!name) {
      continue;
    }

    if (!stats.SPD || (!stats.ATT && pos !== 'GK') || (!stats.GKP && pos === 'GK')) {
      continue;
    }

    const normalizedStats = {
      SPD: stats.SPD || 50,
      ATT: pos === 'GK' ? (stats.ATT || 0) : (stats.ATT || 50),
      CTL: stats.CTL || 50,
      DEF: stats.DEF || 50,
      GKP: pos === 'GK' ? (stats.GKP || 50) : (stats.GKP || 0),
    };

    const signature = `${name}-${pos}-${normalizedStats.SPD}-${normalizedStats.ATT}-${normalizedStats.CTL}-${normalizedStats.DEF}-${normalizedStats.GKP}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    players.push({
      name,
      pos,
      stats: normalizedStats,
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
      const players = parsePlayersFromOcrText(text);
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
