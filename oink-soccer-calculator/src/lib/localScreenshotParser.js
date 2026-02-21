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
  [/SPDO/g, 'SPD'],
];

const STAT_KEYS = ['DEF', 'CTL', 'ATT', 'SPD', 'GKP'];

const normalizeText = (value = '') => {
  let text = value.toUpperCase();
  for (const [pattern, replacement] of OCR_FIXUPS) {
    text = text.replace(pattern, replacement);
  }
  return text;
};

const clampStat = (value) => Math.max(0, Math.min(100, value));

const normalizeToken = (token = '') => normalizeText(token).replace(/[^A-Z0-9]/g, '');

const statKeyFromToken = (token = '') => {
  if (!token) return null;
  const fixed = token.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S');
  if (fixed.includes('DEF')) return 'DEF';
  if (fixed.includes('CTL') || fixed.includes('CTI')) return 'CTL';
  if (fixed.includes('ATT') || fixed.includes('ATI')) return 'ATT';
  if (fixed.includes('SPD') || fixed.includes('SPO')) return 'SPD';
  if (fixed.includes('GKP') || fixed.includes('GKE')) return 'GKP';
  return null;
};

const parseNumberToken = (token = '') => {
  const digits = normalizeText(token).replace(/[OQ]/g, '0').replace(/[IL]/g, '1').replace(/[^0-9]/g, '');
  if (!digits) return null;
  let value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value)) return null;
  if (value > 100 && digits.length >= 2) {
    value = Number.parseInt(digits.slice(-2), 10);
  }
  if (!Number.isFinite(value)) return null;
  return clampStat(value);
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

const cleanName = (line = '') => {
  return normalizeText(line)
    .replace(/[^A-Z0-9.'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const isLikelyNameLine = (line = '') => {
  if (!line) return false;
  const text = normalizeText(line).trim();
  if (!text) return false;
  if (text.includes(':') || text.includes('|')) return false;
  if (STAT_KEYS.some((key) => text.includes(key))) return false;
  if (text.includes('THE DIAMOND') || text.includes('THE PYRAMID') || text.includes('THE BOX') || text.includes('THE Y')) return false;
  if (text.includes('CONNECT WALLET') || text.includes('SYNC')) return false;
  if (!/[A-Z]/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  return text.length >= 3;
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
  const count = STAT_KEYS.filter((key) => Number.isFinite(stats[key])).length;
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

const parseRowsFromWords = (words = []) => {
  const rows = [];
  for (const word of words) {
    const text = word?.text?.trim();
    const box = word?.bbox;
    if (!text || !box) continue;
    const x0 = Number(box.x0);
    const x1 = Number(box.x1);
    const y0 = Number(box.y0);
    const y1 = Number(box.y1);
    if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    let bestRow = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const delta = Math.abs(cy - row.cy);
      if (delta <= 12 && delta < bestDelta) {
        bestDelta = delta;
        bestRow = row;
      }
    }

    if (!bestRow) {
      bestRow = { words: [], cy };
      rows.push(bestRow);
    }

    bestRow.words.push({ text, cx, x0, x1, y0, y1 });
    bestRow.cy = (bestRow.cy * (bestRow.words.length - 1) + cy) / bestRow.words.length;
  }

  for (const row of rows) {
    row.words.sort((a, b) => a.cx - b.cx);
    row.text = row.words.map((word) => word.text).join(' ').trim();
    row.minX = Math.min(...row.words.map((word) => word.x0));
    row.maxX = Math.max(...row.words.map((word) => word.x1));
    row.cx = (row.minX + row.maxX) / 2;
  }

  rows.sort((a, b) => a.cy - b.cy);
  return rows;
};

const extractStatRowsFromRows = (rows = []) => {
  const statRows = [];

  for (const row of rows) {
    for (let i = 0; i < row.words.length; i += 1) {
      const word = row.words[i];
      const key = statKeyFromToken(normalizeToken(word.text));
      if (!key) continue;

      let value = null;
      for (let j = i + 1; j < Math.min(i + 5, row.words.length); j += 1) {
        const n = parseNumberToken(row.words[j].text);
        if (n === null) continue;
        value = n;
        break;
      }

      if (value === null) {
        const match = normalizeText(row.text).match(new RegExp(`${key}\\s*[:;.\\-]?\\s*(\\d{1,3})`));
        if (match) {
          value = clampStat(Number.parseInt(match[1], 10));
        }
      }

      if (value !== null) {
        statRows.push({ key, value, x: word.cx, y: row.cy });
      }
    }
  }

  return statRows;
};

const extractPosMarkersFromRows = (rows = []) => {
  const markers = [];
  for (const row of rows) {
    for (const word of row.words) {
      const token = normalizeToken(word.text);
      if (token === 'GK' || token === 'DF' || token === 'MF' || token === 'FW') {
        markers.push({ pos: token, x: word.cx, y: row.cy });
      }
    }
  }
  return markers;
};

const extractNameCandidatesFromRows = (rows = []) => {
  const names = [];
  for (const row of rows) {
    if (!isLikelyNameLine(row.text)) continue;
    const name = cleanName(row.text);
    if (!name) continue;
    names.push({ name, x: row.cx, y: row.cy });
  }
  return names;
};

const buildCardGroupsFromStatRows = (statRows = []) => {
  const sorted = [...statRows].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const groups = [];

  for (const statRow of sorted) {
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const group of groups) {
      const dx = Math.abs(statRow.x - group.cx);
      const dy = Math.abs(statRow.y - group.lastY);
      if (dx > 140 || dy > 140) continue;
      const score = dx + (dy * 0.6);
      if (score < bestScore) {
        bestScore = score;
        best = group;
      }
    }

    if (!best) {
      best = {
        rows: [],
        stats: {},
        cx: statRow.x,
        minY: statRow.y,
        maxY: statRow.y,
        lastY: statRow.y,
        explicitPos: null,
        name: null,
      };
      groups.push(best);
    }

    best.rows.push(statRow);
    best.stats[statRow.key] = statRow.value;
    best.cx = (best.cx * (best.rows.length - 1) + statRow.x) / best.rows.length;
    best.minY = Math.min(best.minY, statRow.y);
    best.maxY = Math.max(best.maxY, statRow.y);
    best.lastY = statRow.y;
  }

  return groups.filter((group) => hasEnoughStats(group.stats));
};

const assignPositionsToGroups = (groups = [], posMarkers = []) => {
  for (const marker of posMarkers) {
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      if (Math.abs(marker.x - group.cx) > 150) continue;
      if (marker.y < group.minY - 60 || marker.y > group.maxY + 220) continue;
      const score = Math.abs(marker.x - group.cx) + Math.abs(marker.y - (group.maxY + 70)) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = group;
      }
    }
    if (best) {
      best.explicitPos = marker.pos;
    }
  }
};

const assignNamesToGroups = (groups = [], nameCandidates = []) => {
  for (const group of groups) {
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of nameCandidates) {
      if (candidate.y >= group.minY) continue;
      const dy = group.minY - candidate.y;
      if (dy > 240) continue;
      const dx = Math.abs(candidate.x - group.cx);
      if (dx > 220) continue;
      const score = dy + (dx * 0.7) - (candidate.name.length * 0.15);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) {
      group.name = best.name;
    }
  }
};

const toPlayerFromGroup = (group, index) => {
  const pos = inferPosition(group.stats, group.explicitPos);
  const stats = {
    SPD: group.stats.SPD || 50,
    ATT: pos === 'GK' ? (group.stats.ATT || 0) : (group.stats.ATT || 50),
    CTL: group.stats.CTL || 50,
    DEF: group.stats.DEF || 50,
    GKP: pos === 'GK' ? (group.stats.GKP || 50) : (group.stats.GKP || 0),
  };
  return {
    name: group.name || `Opponent ${index + 1}`,
    pos,
    stats,
  };
};

const parsePlayersBySequentialLines = (lines = []) => {
  const players = [];
  const seen = new Set();
  let current = null;
  let autoIndex = 1;

  const flush = () => {
    if (!current || !hasEnoughStats(current.stats)) return;
    const pos = inferPosition(current.stats, current.pos);
    const stats = {
      SPD: current.stats.SPD || 50,
      ATT: pos === 'GK' ? (current.stats.ATT || 0) : (current.stats.ATT || 50),
      CTL: current.stats.CTL || 50,
      DEF: current.stats.DEF || 50,
      GKP: pos === 'GK' ? (current.stats.GKP || 50) : (current.stats.GKP || 0),
    };
    const name = current.name || `Opponent ${autoIndex}`;
    const signature = `${name}-${pos}-${stats.SPD}-${stats.ATT}-${stats.CTL}-${stats.DEF}-${stats.GKP}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      players.push({ name, pos, stats });
      autoIndex += 1;
    }
  };

  for (const line of lines) {
    const text = normalizeText(line);
    const statMatches = [...text.matchAll(/\b(DEF|CTL|ATT|SPD|GKP)\b\s*[:;.\-]?\s*(\d{1,3})/g)];
    const posMatch = text.match(/\b(GK|DF|MF|FW)\b/);

    if (isLikelyNameLine(text) && statMatches.length === 0 && !posMatch) {
      flush();
      current = { name: cleanName(text), stats: {}, pos: null };
      continue;
    }

    if (statMatches.length > 0 || posMatch) {
      if (!current) current = { name: null, stats: {}, pos: null };
      if (posMatch && !current.pos) current.pos = posMatch[1];
      for (const match of statMatches) {
        current.stats[match[1]] = clampStat(Number.parseInt(match[2], 10));
      }
      continue;
    }

    if (current && text.length === 0) {
      flush();
      current = null;
    }
  }

  flush();
  return players;
};

const dedupePlayers = (players = []) => {
  const deduped = [];
  const seen = new Set();
  for (const player of players) {
    const signature = `${player.name}-${player.pos}-${player.stats.SPD}-${player.stats.ATT}-${player.stats.CTL}-${player.stats.DEF}-${player.stats.GKP}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(player);
  }
  return deduped;
};

const parsePlayersFromOcrData = (ocrData) => {
  const linePlayers = parsePlayersBySequentialLines(normalizeOcrLines(ocrData));

  const words = Array.isArray(ocrData?.words) ? ocrData.words : [];
  if (words.length === 0) {
    return linePlayers;
  }

  const rows = parseRowsFromWords(words);
  const statRows = extractStatRowsFromRows(rows);
  const groups = buildCardGroupsFromStatRows(statRows);
  assignPositionsToGroups(groups, extractPosMarkersFromRows(rows));
  assignNamesToGroups(groups, extractNameCandidatesFromRows(rows));

  const groupedPlayers = groups
    .sort((a, b) => (a.minY - b.minY) || (a.cx - b.cx))
    .map((group, idx) => toPlayerFromGroup(group, idx));

  const merged = dedupePlayers([...groupedPlayers, ...linePlayers]);
  if (merged.length === 0) return linePlayers;
  return merged;
};

const buildHighContrastBlob = async (file) => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return null;
  }

  const bitmap = await createImageBitmap(file);
  const targetWidth = Math.min(2200, Math.round(bitmap.width * 1.6));
  const scale = targetWidth / bitmap.width;
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return null;
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
    const boosted = (gray - 128) * 1.9 + 128;
    const value = boosted > 150 ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/png');
  });
  return blob;
};

const resolveRecognize = async () => {
  const mod = await import('tesseract.js');
  const recognize = mod?.recognize || mod?.default?.recognize;
  if (typeof recognize !== 'function') {
    throw new Error('Tesseract failed to load.');
  }
  return recognize;
};

const OCR_OPTIONS = {
  tessedit_pageseg_mode: 6,
  preserve_interword_spaces: '1',
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:|.- ',
};

export const parseOpponentScreenshotsLocally = async (files, onProgress) => {
  const recognize = await resolveRecognize();
  const allPlayers = [];
  const formationVotes = [];
  let processed = 0;
  let failedFiles = 0;

  for (const file of files) {
    try {
      const firstPass = await recognize(file, 'eng', OCR_OPTIONS);
      let mergedText = firstPass?.data?.text || '';
      let players = parsePlayersFromOcrData(firstPass?.data || mergedText);

      if (players.length === 0) {
        const highContrastBlob = await buildHighContrastBlob(file);
        if (highContrastBlob) {
          const secondPass = await recognize(highContrastBlob, 'eng', OCR_OPTIONS);
          const secondText = secondPass?.data?.text || '';
          mergedText = `${mergedText}\n${secondText}`;
          players = parsePlayersFromOcrData(secondPass?.data || secondText);
        }
      }

      if (players.length === 0) {
        failedFiles += 1;
      } else {
        allPlayers.push(...players);
      }

      formationVotes.push(detectFormationKey(mergedText));
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

  const deduped = dedupePlayers(allPlayers);
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
