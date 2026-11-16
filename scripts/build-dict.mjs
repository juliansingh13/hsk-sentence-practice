// Build data/cedict.txt for the hover dictionary from CC-CEDICT.
//
//   node scripts/build-dict.mjs                 # downloads the latest CC-CEDICT from MDBG
//   node scripts/build-dict.mjs cedict_ts.u8    # or reads a local copy (plain or .gz)
//
// Output: one line per simplified word, sorted:
//   hanzi \t pinyin \t gloss [\t pinyin \t gloss ...]
// Pinyin uses tone marks (chōuyān); the gloss is the first few senses, shortened.
// To save space, a word's pinyin is left empty when it equals the first readings of its
// characters joined (most words), or "^" when it is that with a capital first letter (中国 Zhōngguó).
// js/hover-dict.js rebuilds it the same way.
// Only words of 1–5 Chinese characters are kept: the hover lookup never tries longer windows.
// The script also updates DICT_VERSION in js/hover-dict.js so browsers fetch the new file.
//
// CC-CEDICT is © MDBG, licensed CC BY-SA 4.0: https://cc-cedict.org/wiki/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toneNumbersToMarks, joinPinyin } from '../js/pinyin.js';

const SOURCE_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const MAX_CHARS = 5;        // must match MAX_WORD in js/hover-dict.js
// Single characters keep more readings and senses; words get a short gloss to keep the file small.
const LIMITS = { char: { readings: 3, senses: 3, gloss: 110 }, word: { readings: 2, senses: 2, gloss: 64 } };
const MAX_SENSE_LEN = 60;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'data', 'cedict.txt');
const moduleFile = path.join(root, 'js', 'hover-dict.js');

async function readSource(arg) {
  let buf;
  if (arg) {
    buf = fs.readFileSync(arg);
  } else {
    console.log(`Downloading ${SOURCE_URL}`);
    const r = await fetch(SOURCE_URL);
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

const CJK = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff〇]+$/u;
const HAN = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff〇]';

// "ni3 hao3" -> "nǐhǎo", "Xi1 an1" -> "Xī'ān", "lu:4" -> "lǜ", "yi1 dian3 r5" -> "yīdiǎnr"
export function cedictPinyin(numbered) {
  const sylls = numbered.trim().split(/\s+/).map(s => s.replace(/u:/g, 'ü').replace(/U:/g, 'Ü'));
  return joinPinyin(sylls.map(s => toneNumbersToMarks(s).replace(/5$/, '')));
}

// Proper nouns that are rarely what a learner is hovering: counties, districts, townships.
// (Prefecture-level cities such as 苏州 and people such as 孔子 are kept.)
const ADMIN = /\b(county|district|township|banner|subdistrict)\b/i;

const DROP_SENSE = [
  /^surname\b/i,
  /^(?!erhua)(\S+ )?variant of\b/i,       // "old variant of", "unofficial variant of"… (erhua kept)
  /^used in (sur|place |personal )?names\b/i,
  /^(old |archaic )?(form|spelling) of\b/i,
  /^CL:/,
  /^also (pr\.|written)\b/i,
  /^Taiwan pr\./i,
];

function cleanSense(s) {
  s = s
    .replace(new RegExp(`${HAN}+\\|(${HAN}+)`, 'gu'), '$1') // 說|说 -> 说
    .replace(/\[[A-Za-z0-9:·, ]+\]/g, '')                     // drop [shuo1] references
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > MAX_SENSE_LEN) s = s.slice(0, MAX_SENSE_LEN - 1).replace(/[\s,;(]+\S*$/, '') + '…';
  return s;
}

const MINOR = /^\((bound form|literary|archaic|old|dialect|classical)\)|^used in\b|^see\b|^erhua variant/i;
const weight = (senses) => senses.reduce((n, s) => n + (MINOR.test(s) ? 0.4 : 1), 0);

// First few senses, stopping before the gloss gets long (always at least one).
function gloss(senses, lim) {
  let out = '';
  for (const s of senses.slice(0, lim.senses)) {
    const next = out ? out + '; ' + s : s;
    if (out && next.length > lim.gloss) break;
    out = next;
  }
  return out;
}

function build(text) {
  const words = new Map(); // simp -> [{ py, lower, senses: [] }]
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/);
    if (!m) continue;
    total++;
    const [, , simp, numbered, defs] = m;
    if (!CJK.test(simp) || [...simp].length > MAX_CHARS) continue;
    const senses = defs.split('/').map(s => s.trim()).filter(s => s && !DROP_SENSE.some(re => re.test(s))).map(cleanSense).filter(Boolean);
    if (!senses.length) continue;
    const py = cedictPinyin(numbered);
    const lower = py.toLowerCase();
    const readings = words.get(simp) || [];
    const same = readings.find(r => r.lower === lower);
    if (same) {
      if (same.py !== same.lower && py === lower) same.py = py; // prefer the common-noun spelling
      for (const s of senses) if (!same.senses.includes(s)) same.senses.push(s);
    } else {
      readings.push({ py, lower, senses });
    }
    words.set(simp, readings);
  }
  // Cross-references ("see 西安市"): dropped when the reading has real senses, otherwise replaced
  // by the target's meaning (done before pruning, which may remove the target).
  const isRef = (s) => /^see (also )?\S+$/.test(s);
  for (const readings of words.values()) {
    for (const r of readings) {
      if (!r.senses.every(isRef)) { r.senses = r.senses.filter(s => !isRef(s)); continue; }
      const target = words.get(r.senses[0].match(/(\S+)$/)[1])?.[0];
      const real = target?.senses.filter(s => !isRef(s));
      if (real?.length) r.senses = real;
    }
  }
  let pruned = 0;
  for (const [simp, readings] of words) {
    if ([...simp].length > 1 && readings.every(r => r.py !== r.lower)) {
      const all = readings.flatMap(r => r.senses).join(' / ');
      if (ADMIN.test(all)) { words.delete(simp); pruned++; }
    }
  }
  const final = new Map();
  for (const [simp, readings] of words) {
    // Common readings (lowercase pinyin) before proper nouns; otherwise keep CC-CEDICT order.
    // Then readings with more substantive senses first (说 shuō before shuì, 行 xíng before háng).
    const lim = [...simp].length === 1 ? LIMITS.char : LIMITS.word;
    const sorted = readings.map((r, i) => ({ r, i, proper: r.py !== r.lower, weight: weight(r.senses) }))
      .sort((a, b) => a.proper - b.proper || b.weight - a.weight || a.i - b.i)
      .slice(0, lim.readings);
    final.set(simp, sorted.map(({ r }) => ({ py: r.py, gloss: gloss(r.senses, lim) })));
  }
  const charPy = (c) => final.get(c)?.[0].py.toLowerCase();
  let derived = 0;
  const lines = [];
  for (const [simp, readings] of final) {
    const chars = [...simp];
    const guess = chars.length > 1 && chars.every(charPy) ? joinPinyin(chars.map(charPy)) : null;
    const enc = readings.map(r => {
      let py = r.py;
      if (guess && py === guess) py = '';
      else if (guess && py === guess[0].toUpperCase() + guess.slice(1)) py = '^';
      if (py === '' || py === '^') derived++;
      return py + '\t' + r.gloss;
    });
    lines.push(simp + '\t' + enc.join('\t'));
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { out: lines.join('\n') + '\n', total, kept: lines.length, pruned, derived };
}

const src = await readSource(process.argv[2]);
const { out, total, kept, pruned, derived } = build(src);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);
const version = crypto.createHash('sha1').update(out).digest('hex').slice(0, 10);
const js = fs.readFileSync(moduleFile, 'utf8');
fs.writeFileSync(moduleFile, js.replace(/const DICT_VERSION = '[^']*';/, `const DICT_VERSION = '${version}';`));
const raw = Buffer.byteLength(out);
const gz = zlib.gzipSync(out, { level: 9 }).length;
const br = zlib.brotliCompressSync(out).length;
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`${total} CC-CEDICT entries -> ${kept} words in data/cedict.txt (version ${version})`);
console.log(`${pruned} county/district names pruned, ${derived} readings use derived pinyin`);
console.log(`size ${mb(raw)}, gzip ${mb(gz)}, brotli ${mb(br)}`);
