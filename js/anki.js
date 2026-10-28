// Parsing of Anki "Notes in Plain Text" exports (and generic TSV/CSV files).
// Pure functions, no DOM access, so they can be tested in Node.

const SEPARATORS = {
  tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':',
};

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// Turn an Anki field (possibly HTML) into plain text, keeping line breaks.
export function cleanField(s) {
  if (!s) return '';
  let t = s
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h\d)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  t = decodeEntities(t)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return t;
}

// Delimited-text parser with RFC-4180-style quoting ("" escapes, newlines inside quotes).
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let atFieldStart = true;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (atFieldStart && c === '"') { inQuotes = true; atFieldStart = false; i++; continue; }
    if (c === delim) { row.push(field); field = ''; atFieldStart = true; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field); rows.push(row);
      row = []; field = ''; atFieldStart = true; i++; continue;
    }
    field += c; atFieldStart = false; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function detectDelimiter(sample) {
  const lines = sample.split('\n').filter(l => l.trim()).slice(0, 30);
  let best = '\t', bestScore = -1;
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.map(l => l.split(d).length - 1);
    const nonzero = counts.filter(c => c > 0).length;
    const score = nonzero * 10 + (d === '\t' ? 5 : 0);
    if (nonzero > 0 && score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// Returns { rows: string[][] (cleaned), columns: string[], meta }
export function parseAnkiExport(raw) {
  let text = raw.replace(/^﻿/, '');
  const meta = {};
  const lines = text.split('\n');
  let headerCount = 0;
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    const m = line.match(/^#([^:]+):(.*)$/);
    if (m) meta[m[1].trim().toLowerCase()] = m[2].replace(/\r$/, '');
    headerCount++;
  }
  const body = lines.slice(headerCount).join('\n');
  const delim = meta.separator
    ? (SEPARATORS[meta.separator.trim().toLowerCase()] ?? meta.separator)
    : detectDelimiter(body.slice(0, 20000));
  const rawRows = parseDelimited(body, delim);
  const width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);
  const rows = rawRows.map(r => {
    const out = [];
    for (let k = 0; k < width; k++) out.push(cleanField(r[k] ?? ''));
    return out;
  });

  let columns;
  if (meta.columns) {
    columns = meta.columns.split(delim).map(s => s.trim());
  } else {
    columns = [];
  }
  // Mark Anki bookkeeping columns.
  const special = {};
  for (const key of ['guid column', 'notetype column', 'deck column', 'tags column']) {
    if (meta[key]) special[parseInt(meta[key], 10) - 1] = key.replace(' column', '');
  }
  for (let k = 0; k < width; k++) {
    if (!columns[k]) columns[k] = special[k] ? `(${special[k]})` : `Column ${k + 1}`;
  }
  return { rows, columns, meta, delimiter: delim, special };
}

const CJK = /[㐀-鿿豈-﫿]/g;
const TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i;
const PINYIN_LINE = /^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙ\s'’·\-,.0-5]+$/;

function columnStats(rows, k) {
  const sample = rows.slice(0, 80).map(r => r[k] || '');
  const nonEmpty = sample.filter(s => s);
  if (!nonEmpty.length) return { empty: true };
  const avgLen = nonEmpty.reduce((a, s) => a + s.length, 0) / nonEmpty.length;
  const cjkRatio = nonEmpty.reduce((a, s) => a + ((s.match(CJK) || []).length / s.length), 0) / nonEmpty.length;
  const pinyinFrac = nonEmpty.filter(s => PINYIN_LINE.test(s) && (TONE.test(s) || /[a-z][1-5]\b/i.test(s))).length / nonEmpty.length;
  const latinFrac = nonEmpty.filter(s => /[a-z]/i.test(s) && (s.match(CJK) || []).length === 0).length / nonEmpty.length;
  return { empty: false, avgLen, cjkRatio, pinyinFrac, latinFrac, fill: nonEmpty.length / sample.length };
}

// Guess which column holds which field. Returns indices (or -1).
export function guessMapping(parsed) {
  const { rows, columns, special } = parsed;
  const width = columns.length;
  const stats = [];
  for (let k = 0; k < width; k++) stats.push(special[k] ? { empty: true } : columnStats(rows, k));
  const byName = (re) => columns.findIndex((c, k) => !special[k] && re.test(c));

  const map = {
    hanzi: byName(/^(hanzi|simplified|chinese|word|vocab|汉字|简体|词语?)$/i),
    pinyin: byName(/pinyin|拼音/i),
    meaning: byName(/meaning|english|definition|translation|gloss|意思|释义/i),
    example: byName(/example|sentence|例句/i),
  };
  const used = () => new Set(Object.values(map).filter(v => v >= 0));

  if (map.pinyin < 0) {
    let best = -1, bestV = 0.5;
    stats.forEach((s, k) => { if (!s.empty && !used().has(k) && s.pinyinFrac > bestV) { best = k; bestV = s.pinyinFrac; } });
    map.pinyin = best;
  }
  if (map.hanzi < 0) {
    let best = -1, bestLen = Infinity;
    stats.forEach((s, k) => {
      if (!s.empty && !used().has(k) && s.cjkRatio > 0.6 && s.avgLen < bestLen) { best = k; bestLen = s.avgLen; }
    });
    map.hanzi = best;
  }
  if (map.example < 0) {
    let best = -1, bestLen = 0;
    const hz = map.hanzi >= 0 ? stats[map.hanzi].avgLen : 0;
    stats.forEach((s, k) => {
      if (!s.empty && !used().has(k) && s.cjkRatio > 0.2 && s.avgLen > hz + 3 && s.avgLen > bestLen) { best = k; bestLen = s.avgLen; }
    });
    map.example = best;
  }
  if (map.meaning < 0) {
    let best = -1, bestV = 0.4;
    stats.forEach((s, k) => { if (!s.empty && !used().has(k) && s.latinFrac > bestV) { best = k; bestV = s.latinFrac; } });
    map.meaning = best;
  }
  return map;
}

export function buildWords(rows, map, skipFirstRow = false) {
  const src = skipFirstRow ? rows.slice(1) : rows;
  const get = (r, k) => (k >= 0 ? (r[k] || '') : '');
  return src
    .map(r => ({
      hanzi: get(r, map.hanzi),
      pinyin: get(r, map.pinyin),
      meaning: get(r, map.meaning),
      example: get(r, map.example),
    }))
    .filter(w => w.hanzi);
}
