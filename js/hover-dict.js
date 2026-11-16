// Hover dictionary: rest the pointer on a Chinese character (or tap it) to see the word's
// pinyin and meaning. One set of delegated listeners; no per-character spans.
// Data: CC-CEDICT (CC BY-SA 4.0), built into data/cedict.txt by scripts/build-dict.mjs and
// loaded lazily the first time the pointer finds Chinese text.
import { toneNumbersToMarks, joinPinyin } from './pinyin.js';

const DICT_VERSION = '40edd1f304';            // updated by scripts/build-dict.mjs
const DICT_URL = `data/cedict.txt?v=${DICT_VERSION}`;
const CACHE_NAME = 'hskw-dict';
const MAX_WORD = 5;                    // longest window tried; matches MAX_CHARS in the build script
const HOVER_DELAY = 350;
const HIDE_GRACE = 120;                // lets the pointer cross gaps between lines without flicker
const TAP_SLOP = 10;

const IS_HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3007]/;
const SKIP_SELECTOR = 'textarea, input, select, [contenteditable=""], [contenteditable="true"], .hd-popup';

let getWords = () => [];
let dict = null;            // Map simp -> "py\tgloss[\tpy\tgloss...]"
let dictPromise = null;
let dictFailed = false;
let deckIndex = null, deckIndexSource = null;

let popup = null;
let current = null;         // { node, offset, word, char, rect }
let showTimer = 0, hideTimer = 0, rafId = 0;
let lastMove = null;
let touchStart = null;

export function initHoverDict(opts = {}) {
  if (opts.getWords) getWords = opts.getWords;
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true });
  document.addEventListener('pointercancel', () => { touchStart = null; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // Clicks often re-render the clicked text (chips, search results); drop a popup whose text is gone.
  document.addEventListener('click', () => setTimeout(() => { if (current && !current.node.isConnected) hide(); }, 0));
}

// ---------- dictionary ----------
function loadDict() {
  if (dictPromise) return dictPromise;
  dictPromise = (async () => {
    let text = null;
    let cache = null;
    try { cache = await caches.open(CACHE_NAME); } catch {}
    if (cache) {
      try { const hit = await cache.match(DICT_URL); if (hit) text = await hit.text(); } catch {}
    }
    if (text == null) {
      const r = await fetch(DICT_URL);
      if (!r.ok) throw new Error(`Dictionary download failed (${r.status})`);
      if (cache) {
        try {
          await cache.put(DICT_URL, r.clone());
          for (const req of await cache.keys()) if (!req.url.endsWith(DICT_URL)) cache.delete(req);
        } catch {}
      }
      text = await r.text();
    }
    const map = new Map();
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      const tab = text.indexOf('\t', start);
      if (tab > start && tab < end) map.set(text.slice(start, tab), text.slice(tab + 1, end));
      start = end + 1;
    }
    dict = map;
    return map;
  })();
  dictPromise.catch(() => { dictFailed = true; dictPromise = null; });
  return dictPromise;
}

function dictEntry(word) {
  const raw = dict?.get(word);
  if (!raw) return null;
  const parts = raw.split('\t');
  const readings = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    let pinyin = parts[i];
    // Empty / "^": the first readings of the characters joined (see scripts/build-dict.mjs).
    if (pinyin === '' || pinyin === '^') {
      const d = joinPinyin([...word].map(c => (dict.get(c) || '').split('\t', 1)[0].toLowerCase()));
      pinyin = pinyin === '^' ? d.charAt(0).toUpperCase() + d.slice(1) : d;
    }
    readings.push({ pinyin, gloss: parts[i + 1] });
  }
  return readings;
}

// Deck words, keyed by hanzi. Entries like "爱人 / 愛人" or "一点（儿）" are indexed under each form.
function deckLookup(word) {
  const list = getWords() || [];
  if (deckIndexSource !== list) {
    deckIndex = new Map();
    deckIndexSource = list;
    list.forEach((w, i) => {
      const h = String(w?.hanzi || '').trim();
      if (!h) return;
      const forms = new Set([h, h.replace(/[（(][^）)]*[）)]/g, ''), h.replace(/[（()）]/g, '')]);
      for (const f of [...forms]) for (const part of f.split(/[\/／,，;；|、\s]+/)) if (part) forms.add(part);
      for (const f of forms) if (f && !deckIndex.has(f)) deckIndex.set(f, i);
    });
  }
  const i = deckIndex.get(word);
  return i == null ? null : { index: i, word: list[i] };
}

const known = (w) => !!(deckLookup(w) || dict?.has(w));

// Longest word containing position h; for equal lengths, the one that starts earliest.
export function segment(text, h, isWord = known) {
  for (let len = MAX_WORD; len >= 2; len--) {
    for (let s = Math.max(0, h - len + 1); s <= h; s++) {
      if (s + len > text.length) break;
      const cand = text.slice(s, s + len);
      if (IS_HAN.test(cand[0]) && isWord(cand)) return { word: cand, start: s };
    }
  }
  return { word: text[h], start: h };
}

// ---------- hit testing ----------
function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

let charRange = null;
function charRectAt(node, i, x, y) {
  charRange ||= document.createRange();
  charRange.setStart(node, i);
  charRange.setEnd(node, i + 1);
  for (const r of charRange.getClientRects()) {
    if (x >= r.left - 0.5 && x <= r.right + 0.5 && y >= r.top - 0.5 && y <= r.bottom + 0.5) return r;
  }
  return null;
}

function skipped(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !el || !!el.closest(SKIP_SELECTOR);
}

// The Chinese character under (x, y), or null when the pointer is not on a glyph.
function hitTest(x, y) {
  const c = caretAt(x, y);
  if (c && c.node?.nodeType === 3 && !skipped(c.node)) {
    const t = c.node.data;
    // The caret sits at the nearest boundary, so the glyph is on either side of it.
    for (const i of [c.offset, c.offset - 1]) {
      if (i < 0 || i >= t.length || !IS_HAN.test(t[i])) continue;
      const rect = charRectAt(c.node, i, x, y);
      if (rect) return { node: c.node, offset: i, rect };
    }
  }
  // Fallback for text the caret APIs skip (e.g. inside some buttons): scan the small element under the pointer.
  const el = document.elementFromPoint(x, y);
  if (!el || skipped(el) || el.textContent.length > 120) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      if (!IS_HAN.test(t[i])) continue;
      const rect = charRectAt(n, i, x, y);
      if (rect) return { node: n, offset: i, rect };
    }
  }
  return null;
}

// Text of the inline run around the hit, so words split by <mark>/<strong> are still found.
// <sup> correction numbers are left out; inline-block/flex elements (chips, buttons) are their own runs.
function contextOf(node, offset) {
  let block = node.parentElement;
  while (block.parentElement && block !== document.body && getComputedStyle(block).display === 'inline') block = block.parentElement;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let el = n.parentElement; el && el !== block; el = el.parentElement) {
        if (el.tagName === 'SUP' || getComputedStyle(el).display !== 'inline') return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '', pos = -1;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) pos = text.length + offset;
    text += n.data;
  }
  if (pos < 0) return { text: node.data, pos: offset };
  // Only the neighbourhood matters for segmentation.
  const from = Math.max(0, pos - MAX_WORD + 1);
  return { text: text.slice(from, pos + MAX_WORD), pos: pos - from };
}

// ---------- pointer handling ----------
function onPointerMove(e) {
  if (e.pointerType === 'touch') return;
  lastMove = { x: e.clientX, y: e.clientY };
  if (!rafId) rafId = requestAnimationFrame(processMove);
}

function processMove() {
  rafId = 0;
  if (!lastMove) return;
  const hit = hitTest(lastMove.x, lastMove.y);
  if (!hit) {
    clearTimeout(showTimer); showTimer = 0;
    if (popup && !popup.hidden && !hideTimer) hideTimer = setTimeout(hide, HIDE_GRACE);
    return;
  }
  clearTimeout(hideTimer); hideTimer = 0;
  if (!dict && !dictFailed) loadDict().catch(() => {});
  if (current && current.node === hit.node && current.offset === hit.offset && popup && !popup.hidden) return;
  if (popup && !popup.hidden) { showFor(hit); return; }   // already open: follow the pointer
  clearTimeout(showTimer);
  const pending = hit;
  showTimer = setTimeout(() => {
    showTimer = 0;
    // Re-check that the pointer is still on the same glyph after the delay.
    const again = lastMove && hitTest(lastMove.x, lastMove.y);
    if (again && again.node === pending.node && again.offset === pending.offset) showFor(again);
  }, HOVER_DELAY);
}

function onPointerDown(e) {
  if (e.pointerType !== 'touch') { if (popup && !popup.hidden) hide(); return; }
  touchStart = { x: e.clientX, y: e.clientY, t: Date.now() };
}

function onPointerUp(e) {
  if (e.pointerType !== 'touch' || !touchStart) return;
  const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
  const long = Date.now() - touchStart.t > 600;
  touchStart = null;
  if (moved > TAP_SLOP || long) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) { hide(); return; }
  if (!dict && !dictFailed) loadDict().catch(() => {});
  showFor(hit);
}

// ---------- popup ----------
function ensurePopup() {
  if (popup) return popup;
  popup = document.createElement('div');
  popup.className = 'hd-popup';
  popup.setAttribute('role', 'tooltip');
  popup.hidden = true;
  document.body.appendChild(popup);
  return popup;
}

function hide() {
  clearTimeout(showTimer); clearTimeout(hideTimer);
  showTimer = hideTimer = 0;
  current = null;
  if (popup) popup.hidden = true;
}

function showFor(hit) {
  const { text, pos } = contextOf(hit.node, hit.offset);
  const char = text[pos];
  const { word } = segment(text, pos);
  current = { node: hit.node, offset: hit.offset, rect: hit.rect, word, char };
  render();
  if (!dict && dictPromise) {
    const same = current;
    dictPromise.then(() => {
      if (current !== same) return;
      // Segmentation may change once the full dictionary is in.
      const again = contextOf(same.node, same.offset);
      same.word = segment(again.text, again.pos).word;
      render();
    }, () => { if (current === same) render(); });
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const norm = (py) => String(py || '').toLowerCase().replace(/[\s'’·-]/g, '');

function shortGloss(gloss, senses) {
  return String(gloss || '').split('; ').slice(0, senses).join('; ');
}

function render() {
  const p = ensurePopup();
  const { word, char } = current;
  const deck = deckLookup(word);
  const readings = dictEntry(word);
  p.replaceChildren();

  p.appendChild(el('div', 'hd-word', word));
  if (deck) {
    const w = deck.word;
    if (w.pinyin) p.appendChild(el('div', 'hd-pinyin', toneNumbersToMarks(w.pinyin)));
    if (w.meaning) p.appendChild(el('div', 'hd-gloss', w.meaning));
  } else if (readings) {
    for (const r of readings) {
      const row = el('div', 'hd-reading');
      row.appendChild(el('div', 'hd-pinyin', r.pinyin));
      row.appendChild(el('div', 'hd-gloss', r.gloss));
      p.appendChild(row);
    }
  } else if (!dict && !dictFailed) {
    p.appendChild(el('div', 'hd-muted', 'Loading…'));
  } else {
    p.appendChild(el('div', 'hd-muted', dictFailed ? 'Dictionary could not be loaded.' : 'Not in the dictionary.'));
  }
  if (deck) p.appendChild(el('div', 'hd-deck', `#${deck.index + 1} in your deck`));

  if ([...word].length > 1) {
    const cDeck = deckLookup(char);
    // The character's reading that occurs in the word's pinyin (行 in 银行 -> háng), else its first.
    const wordPy = norm(deck?.word.pinyin ? toneNumbersToMarks(deck.word.pinyin) : readings?.[0].pinyin);
    const cDict = dictEntry(char);
    const cRead = cDict && (cDict.find(r => wordPy.includes(norm(r.pinyin))) || cDict[0]);
    const py = cDeck?.word.pinyin ? toneNumbersToMarks(cDeck.word.pinyin) : cRead?.pinyin;
    const gloss = cDeck?.word.meaning || (cRead && shortGloss(cRead.gloss, 2));
    if (py || gloss || dict) {
      const row = el('div', 'hd-char');
      row.appendChild(el('span', 'hd-char-hanzi', char));
      if (py) row.appendChild(el('span', 'hd-char-pinyin', py));
      if (gloss) row.appendChild(el('span', 'hd-char-gloss', gloss));
      p.appendChild(row);
    }
  }

  p.hidden = false;
  position();
}

function position() {
  const p = popup;
  const r = current.rect;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const margin = 8, gap = 6;
  p.style.left = '0px'; p.style.top = '0px';
  const { width, height } = p.getBoundingClientRect();
  const below = vh - r.bottom - gap - margin, above = r.top - gap - margin;
  const top = height <= below || below >= above ? r.bottom + gap : r.top - gap - height;
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - 24), vw - width - margin);
  p.style.left = `${Math.max(margin, left)}px`;
  p.style.top = `${Math.max(margin, Math.min(top, vh - height - margin))}px`;
}
