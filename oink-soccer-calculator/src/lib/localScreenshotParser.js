const FORMATION_CANDIDATES = [
  { key: 'Diamond', regex: /(DIAMOND|1\s*[-:]\s*2\s*[-:]\s*1)/i },
  { key: 'Pyramid', regex: /(PYRAMID|2\s*[-:]\s*1\s*[-:]\s*1)/i },
  { key: 'Y', regex: /(\bTHE\s*Y\b|1\s*[-:]\s*1\s*[-:]\s*2)/i },
  { key: 'Box', regex: /(\bBOX\b|2\s*[-:]\s*0\s*[-:]\s*2)/i },
];

const STAT_KEYS = ['DEF', 'CTL', 'ATT', 'SPD', 'GKP'];

const OCR_FIXUPS = [
  [/CT1/g, 'CTL'],
  [/CT\|/g, 'CTL'],
  [/SP0/g, 'SPD'],
  [/ATTI/g, 'ATT'],
  [/GKP\./g, 'GKP'],
  [/SPO/g, 'SPD'],
];

const OCR_OPTIONS = {
  tessedit_pageseg_mode: 6,
  preserve_interword_spaces: '1',
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:|.- ',
};

const normalizeText = (value = '') => {
  let text = value.toUpperCase();
  for (const [pattern, replacement] of OCR_FIXUPS) {
    text = text.replace(pattern, replacement);
  }
  return text;
};

const clampStat = (value) => Math.max(0, Math.min(100, value));

const normalizeToken = (value = '') => normalizeText(value).replace(/[^A-Z0-9]/g, '');

const parseNumberToken = (value = '') => {
  const digits = normalizeText(value).replace(/[OQ]/g, '0').replace(/[IL]/g, '1').replace(/[^0-9]/g, '');
  if (!digits) return null;
  let parsed = Number.parseInt(digits, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > 100 && digits.length >= 2) {
    parsed = Number.parseInt(digits.slice(-2), 10);
  }
  if (!Number.isFinite(parsed)) return null;
  return clampStat(parsed);
};

const statKeyFromToken = (token = '') => {
  if (!token) return null;
  const fixed = token.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S');
  if (fixed.includes('DEF')) return 'DEF';
  if (fixed.includes('CTL') || fixed.includes('CTI')) return 'CTL';
  if (fixed.includes('ATT') || fixed.includes('ATI')) return 'ATT';
  if (fixed.includes('SPD')) return 'SPD';
  if (fixed.includes('GKP') || fixed.includes('GKE')) return 'GKP';
  return null;
};

const cleanName = (value = '') =>
  normalizeText(value)
    .replace(/[^A-Z0-9.'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isLikelyNameLine = (line = '') => {
  const text = normalizeText(line).trim();
  if (!text) return false;
  if (text.includes(':') || text.includes('|')) return false;
  if (STAT_KEYS.some((key) => text.includes(key))) return false;
  if (text.includes('THE DIAMOND') || text.includes('THE PYRAMID') || text.includes('THE BOX') || text.includes('THE Y')) return false;
  if (!/[A-Z]/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  return text.length >= 3;
};

const hasEnoughStats = (stats = {}) => {
  const count = STAT_KEYS.filter((key) => Number.isFinite(stats[key])).length;
  return count >= 3 && Number.isFinite(stats.SPD);
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

const detectFormationKey = (fullText) => {
  const source = normalizeText(fullText);
  for (const candidate of FORMATION_CANDIDATES) {
    if (candidate.regex.test(source)) {
      return candidate.key;
    }
  }
  return 'Pyramid';
};

const parseRowsFromWords = (words = []) => {
  const rows = [];
  for (const word of words) {
    const text = word?.text?.trim();
    const bbox = word?.bbox;
    if (!text || !bbox) continue;

    const x0 = Number(bbox.x0);
    const x1 = Number(bbox.x1);
    const y0 = Number(bbox.y0);
    const y1 = Number(bbox.y1);
    if (![x0, x1, y0, y1].every(Number.isFinite)) continue;

    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let target = null;
    let bestDy = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      const dy = Math.abs(row.cy - cy);
      if (dy <= 12 && dy < bestDy) {
        bestDy = dy;
        target = row;
      }
    }

    if (!target) {
      target = { words: [], cy };
      rows.push(target);
    }

    target.words.push({ text, x0, x1, y0, y1, cx });
    target.cy = (target.cy * (target.words.length - 1) + cy) / target.words.length;
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

const extractStatsFromRows = (rows = []) => {
  const stats = {};

  for (const row of rows) {
    for (let i = 0; i < row.words.length; i += 1) {
      const key = statKeyFromToken(normalizeToken(row.words[i].text));
      if (!key) continue;

      let value = null;
      for (let j = i + 1; j < Math.min(row.words.length, i + 5); j += 1) {
        value = parseNumberToken(row.words[j].text);
        if (value !== null) break;
      }

      if (value === null) {
        const match = normalizeText(row.text).match(new RegExp(`${key}\\s*[:;.\\-]?\\s*(\\d{1,3})`));
        if (match) value = clampStat(Number.parseInt(match[1], 10));
      }

      if (value !== null) {
        stats[key] = value;
      }
    }
  }

  return stats;
};

const parseStatsFromText = (text = '') => {
  const source = normalizeText(text);
  const stats = {};
  for (const key of STAT_KEYS) {
    const match = source.match(new RegExp(`${key}\\s*[:;.\\-]?\\s*(\\d{1,3})`));
    if (!match) continue;
    const value = clampStat(Number.parseInt(match[1], 10));
    if (Number.isFinite(value)) {
      stats[key] = value;
    }
  }
  return stats;
};

const extractNameFromRows = (rows = []) => {
  for (const row of rows) {
    if (!isLikelyNameLine(row.text)) continue;
    const name = cleanName(row.text);
    if (name.length >= 3) return name;
  }
  return null;
};

const extractPosFromText = (text = '') => {
  const match = normalizeText(text).match(/\b(GK|DF|MF|FW)\b/);
  return match ? match[1] : null;
};

const normalizePlayer = (name, stats, explicitPos, index) => {
  if (!hasEnoughStats(stats)) return null;
  const pos = inferPosition(stats, explicitPos);
  const normalizedStats = {
    SPD: stats.SPD || 50,
    ATT: pos === 'GK' ? (stats.ATT || 0) : (stats.ATT || 50),
    CTL: stats.CTL || 50,
    DEF: stats.DEF || 50,
    GKP: pos === 'GK' ? (stats.GKP || 50) : (stats.GKP || 0),
  };
  return {
    name: name || `Opponent ${index + 1}`,
    pos,
    stats: normalizedStats,
  };
};

const dedupePlayers = (players = []) => {
  const seen = new Set();
  const deduped = [];
  for (const player of players) {
    if (!player) continue;
    const signature = `${player.name}-${player.pos}-${player.stats.SPD}-${player.stats.ATT}-${player.stats.CTL}-${player.stats.DEF}-${player.stats.GKP}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(player);
  }
  return deduped;
};

const parsePlayersFromWholeText = (text = '') => {
  const lines = normalizeText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const players = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const player = normalizePlayer(current.name, current.stats, current.pos, players.length);
    if (player) players.push(player);
  };

  for (const line of lines) {
    const hasStat = STAT_KEYS.some((key) => line.includes(key));
    const pos = extractPosFromText(line);

    if (isLikelyNameLine(line) && !hasStat && !pos) {
      flush();
      current = { name: cleanName(line), stats: {}, pos: null };
      continue;
    }

    if (hasStat || pos) {
      if (!current) current = { name: null, stats: {}, pos: null };
      current.stats = { ...current.stats, ...parseStatsFromText(line) };
      if (pos && !current.pos) current.pos = pos;
    }
  }

  flush();
  return dedupePlayers(players);
};

const toCanvasFromFile = async (file, maxWidth = 1800) => {
  if (typeof document === 'undefined') {
    throw new Error('Browser canvas APIs are unavailable.');
  }

  let source = null;
  let shouldClose = false;
  if (typeof createImageBitmap === 'function') {
    source = await createImageBitmap(file);
    shouldClose = true;
  } else {
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
    });
  }

  const scale = Math.min(1, maxWidth / source.width);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context.');

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, width, height);

  if (shouldClose && typeof source.close === 'function') {
    source.close();
  }

  return canvas;
};

const detectCardBoxesFromCanvas = (canvas, maskFn) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  const { width, height } = canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);

  for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    mask[i] = maskFn(r, g, b) ? 1 : 0;
  }

  const visited = new Uint8Array(pixelCount);
  const boxes = [];
  const minArea = Math.max(5000, Math.round(pixelCount * 0.0025));
  const maxArea = Math.round(pixelCount * 0.18);

  for (let start = 0; start < pixelCount; start += 1) {
    if (!mask[start] || visited[start]) continue;

    const stack = [start];
    visited[start] = 1;
    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (stack.length > 0) {
      const idx = stack.pop();
      const y = Math.floor(idx / width);
      const x = idx - (y * width);
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const left = idx - 1;
        if (mask[left] && !visited[left]) {
          visited[left] = 1;
          stack.push(left);
        }
      }
      if (x < width - 1) {
        const right = idx + 1;
        if (mask[right] && !visited[right]) {
          visited[right] = 1;
          stack.push(right);
        }
      }
      if (y > 0) {
        const up = idx - width;
        if (mask[up] && !visited[up]) {
          visited[up] = 1;
          stack.push(up);
        }
      }
      if (y < height - 1) {
        const down = idx + width;
        if (mask[down] && !visited[down]) {
          visited[down] = 1;
          stack.push(down);
        }
      }
    }

    if (area < minArea || area > maxArea) continue;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const ratio = boxWidth / Math.max(1, boxHeight);
    if (ratio < 0.2 || ratio > 1.2) continue;
    if (boxHeight < 120 || boxWidth < 70) continue;

    const padX = Math.round(boxWidth * 0.08);
    const padTop = Math.round(boxHeight * 0.12);
    const padBottom = Math.round(boxHeight * 0.15);

    boxes.push({
      x0: Math.max(0, minX - padX),
      x1: Math.min(width - 1, maxX + padX),
      y0: Math.max(0, minY - padTop),
      y1: Math.min(height - 1, maxY + padBottom),
    });
  }

  return boxes;
};

const mergeBoxes = (boxes = []) => {
  const working = [...boxes];
  const out = [];

  while (working.length > 0) {
    let current = working.pop();
    let merged = true;

    while (merged) {
      merged = false;
      for (let i = working.length - 1; i >= 0; i -= 1) {
        const next = working[i];
        const overlapX = Math.max(0, Math.min(current.x1, next.x1) - Math.max(current.x0, next.x0));
        const overlapY = Math.max(0, Math.min(current.y1, next.y1) - Math.max(current.y0, next.y0));
        const overlapArea = overlapX * overlapY;
        const nearX = Math.abs(((current.x0 + current.x1) / 2) - ((next.x0 + next.x1) / 2)) < 40;
        const nearY = Math.abs(((current.y0 + current.y1) / 2) - ((next.y0 + next.y1) / 2)) < 50;

        if (overlapArea > 0 || (nearX && nearY)) {
          current = {
            x0: Math.min(current.x0, next.x0),
            y0: Math.min(current.y0, next.y0),
            x1: Math.max(current.x1, next.x1),
            y1: Math.max(current.y1, next.y1),
          };
          working.splice(i, 1);
          merged = true;
        }
      }
    }

    out.push(current);
  }

  return out
    .filter((box) => (box.x1 - box.x0 + 1) > 80 && (box.y1 - box.y0 + 1) > 120)
    .sort((a, b) => ((a.y0 - b.y0) || (a.x0 - b.x0)));
};

const getCardBoxesFromCanvas = (canvas) => {
  const strictMask = (r, g, b) =>
    r > 95 && g > 80 && b < 120 && (r + g) > 230 && (r - b) > 30 && (g - b) > 25;
  const looseMask = (r, g, b) =>
    r > 75 && g > 65 && b < 140 && (r + g) > 200 && (r - b) > 15;

  const strict = mergeBoxes(detectCardBoxesFromCanvas(canvas, strictMask));
  if (strict.length >= 4) return strict.slice(0, 7);
  const loose = mergeBoxes(detectCardBoxesFromCanvas(canvas, looseMask));
  return (loose.length > strict.length ? loose : strict).slice(0, 7);
};

const cropCanvas = (sourceCanvas, box) => {
  const width = box.x1 - box.x0 + 1;
  const height = box.y1 - box.y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, box.x0, box.y0, width, height, 0, 0, width, height);
  return canvas;
};

const makeHighContrastCanvas = (canvas) => {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(canvas, 0, 0);
  const imageData = ctx.getImageData(0, 0, out.width, out.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
    const boosted = ((gray - 128) * 2.0) + 128;
    const value = boosted > 152 ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return out;
};

const parsePlayerFromCardOcr = (ocrData, index) => {
  const rows = parseRowsFromWords(Array.isArray(ocrData?.words) ? ocrData.words : []);
  const text = normalizeText(ocrData?.text || '');
  const name = extractNameFromRows(rows) || (() => {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.find((item) => isLikelyNameLine(item));
    return line ? cleanName(line) : null;
  })();

  const stats = {
    ...parseStatsFromText(text),
    ...extractStatsFromRows(rows),
  };
  const explicitPos = extractPosFromText(text);
  return normalizePlayer(name, stats, explicitPos, index);
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
      const canvas = await toCanvasFromFile(file);
      const fullOcr = await recognize(canvas, 'eng', OCR_OPTIONS);
      const fullText = fullOcr?.data?.text || '';
      formationVotes.push(detectFormationKey(fullText));

      const cardBoxes = getCardBoxesFromCanvas(canvas);
      const cardPlayers = [];

      for (let i = 0; i < cardBoxes.length; i += 1) {
        const cardCanvas = cropCanvas(canvas, cardBoxes[i]);
        if (!cardCanvas) continue;

        let ocrResult = await recognize(cardCanvas, 'eng', OCR_OPTIONS);
        let player = parsePlayerFromCardOcr(ocrResult?.data, i);

        if (!player) {
          const contrast = makeHighContrastCanvas(cardCanvas);
          if (contrast) {
            ocrResult = await recognize(contrast, 'eng', OCR_OPTIONS);
            player = parsePlayerFromCardOcr(ocrResult?.data, i);
          }
        }

        if (player) {
          cardPlayers.push(player);
        }
      }

      const fallbackPlayers = parsePlayersFromWholeText(fullText);
      const merged = dedupePlayers([...cardPlayers, ...fallbackPlayers]);
      if (merged.length === 0) {
        failedFiles += 1;
      } else {
        allPlayers.push(...merged);
      }
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
