import { parseAnkiExport, guessMapping, buildWords } from './anki.js';
import { escapeHtml, highlightHtml } from './highlight.js';

const STORE_KEY = 'hskw.v1';
const $ = (id) => document.getElementById(id);

// ---------- state ----------
function defaultState() {
  return {
    deck: null, // { name, words: [{hanzi,pinyin,meaning,example}], importedAt }
    settings: { perDay: 7, passphrase: '' },
    progress: { blockStart: 0, blockDate: today(), completed: false, wordPos: 0 },
    history: {}, // key -> [{ text, result, ts }]
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return { ...defaultState(), ...s };
  } catch {}
  return defaultState();
}
let state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { alert('Could not save to browser storage: ' + e.message); }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const words = () => state.deck?.words || [];
const perDay = () => Math.max(1, state.settings.perDay | 0);
function blockIndices() {
  const start = state.progress.blockStart;
  const end = Math.min(start + perDay(), words().length);
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
const historyKey = (i) => `${i}|${words()[i]?.hanzi}`;

// Advance to the next block on a new calendar day, but only if the last block was finished.
function rollover() {
  const p = state.progress;
  const t = today();
  if (p.blockDate < t) {
    if (p.completed && p.blockStart + perDay() < words().length) {
      p.blockStart += perDay();
      p.wordPos = 0;
    }
    p.completed = false;
    p.blockDate = t;
    save();
  }
}

// ---------- views ----------
function show(view) {
  $('view-study').hidden = view !== 'study';
  $('view-settings').hidden = view !== 'settings';
  $('nav-study').classList.toggle('active', view === 'study');
  $('nav-settings').classList.toggle('active', view === 'settings');
  if (view === 'study') renderStudy();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$('nav-study').onclick = () => (state.deck ? show('study') : show('settings'));
$('nav-settings').onclick = () => show('settings');

// ---------- study ----------
let lastResult = null; // result shown for the current word in this session

function renderStudy() {
  if (!state.deck || !words().length) { show('settings'); return; }
  rollover();
  const idx = blockIndices();
  const p = state.progress;
  if (!idx.length) { p.blockStart = Math.max(0, words().length - perDay()); save(); return renderStudy(); }
  if (p.wordPos >= idx.length) p.wordPos = idx.length - 1;

  const first = idx[0] + 1, last = idx[idx.length - 1] + 1;
  const dayNum = Math.floor(p.blockStart / perDay()) + 1;
  $('day-title').textContent = `Day ${dayNum}`;
  $('day-sub').textContent = `Words ${first}–${last} of ${words().length}`;
  $('prev-day').disabled = p.blockStart === 0;
  $('next-day').disabled = p.blockStart + perDay() >= words().length;

  const chips = $('word-chips');
  chips.innerHTML = '';
  idx.forEach((wi, pos) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (pos === p.wordPos ? ' active' : '') + ((state.history[historyKey(wi)] || []).length ? ' done' : '');
    b.textContent = words()[wi].hanzi;
    b.onclick = () => { p.wordPos = pos; save(); lastResult = null; renderStudy(); };
    chips.appendChild(b);
  });

  const wi = idx[p.wordPos];
  const w = words()[wi];
  $('w-hanzi').textContent = w.hanzi;
  $('w-pinyin').textContent = w.pinyin;
  $('w-meaning').textContent = w.meaning;
  $('w-meaning').hidden = true;
  $('w-meaning-toggle').hidden = !w.meaning;
  $('w-meaning-toggle').textContent = 'Show meaning';
  $('w-example-wrap').hidden = !w.example;
  $('w-example').textContent = w.example;
  $('input-text').placeholder = `用「${w.hanzi}」造几个句子……`;

  $('prev-word').disabled = p.wordPos === 0;
  $('next-word').disabled = p.wordPos === idx.length - 1;

  const draftKey = 'hskw.draft.' + historyKey(wi);
  const ta = $('input-text');
  ta.value = sessionStorage.getItem(draftKey) || '';
  ta.oninput = () => { try { sessionStorage.setItem(draftKey, ta.value); } catch {} };

  $('status').hidden = true;
  $('result').innerHTML = lastResult && lastResult.key === historyKey(wi) ? renderResult(lastResult.result) : '';
  renderHistory(wi);

  $('done-btn').hidden = p.completed;
  $('done-msg').hidden = !p.completed;
  if (p.completed) {
    $('done-msg').innerHTML = 'Done. The next block opens tomorrow. <button class="ghost" id="skip-ahead" type="button">Start it now</button>';
    $('skip-ahead').onclick = () => moveBlock(1);
  }
}

function moveBlock(dir) {
  const p = state.progress;
  const next = p.blockStart + dir * perDay();
  if (next < 0 || next >= words().length) return;
  p.blockStart = next;
  p.wordPos = 0;
  p.completed = false;
  p.blockDate = today();
  lastResult = null;
  save();
  renderStudy();
}
$('prev-day').onclick = () => moveBlock(-1);
$('next-day').onclick = () => moveBlock(1);
$('prev-word').onclick = () => { state.progress.wordPos--; lastResult = null; save(); renderStudy(); };
$('next-word').onclick = () => { state.progress.wordPos++; lastResult = null; save(); renderStudy(); };
$('done-btn').onclick = () => { state.progress.completed = true; save(); renderStudy(); };
$('w-meaning-toggle').onclick = () => {
  const m = $('w-meaning');
  m.hidden = !m.hidden;
  $('w-meaning-toggle').textContent = m.hidden ? 'Show meaning' : 'Hide meaning';
};

const TYPE_LABEL = { target_word: 'Target word', grammar: 'Grammar', naturalness: 'Naturalness' };

function renderResult(r) {
  if (!r || !Array.isArray(r.sentences)) return '';
  let html = '<div class="result">';
  html += '<div class="legend"><span class="l-tw">Target word</span><span class="l-gr">Grammar</span><span class="l-nat">Naturalness</span></div>';
  if (r.overall || r.target_word_feedback) {
    html += '<div class="summary">';
    if (r.overall) html += `<p>${escapeHtml(r.overall)}</p>`;
    if (r.target_word_feedback) html += `<p class="tw-feedback"><strong>Target word:</strong> ${escapeHtml(r.target_word_feedback)}</p>`;
    html += '</div>';
  }
  r.sentences.forEach((s, si) => {
    const errs = s.errors || [];
    const labels = errs.map((_, i) => i + 1);
    const { html: sentHtml, positions } = highlightHtml(s.original, errs, labels);
    const hasTw = errs.some(e => e.type === 'target_word');
    const onlyNat = errs.length && errs.every(e => e.type === 'naturalness');
    let badge;
    if (!errs.length) badge = '<span class="badge ok">Correct</span>';
    else if (onlyNat) badge = '<span class="badge warn">Unnatural</span>';
    else badge = `<span class="badge bad">${errs.length} issue${errs.length > 1 ? 's' : ''}</span>`;
    if (!s.target_word_used && !hasTw) badge += ' <span class="badge warn">Word not used</span>';

    html += `<div class="sentence" data-s="${si}">`;
    html += `<div class="sentence-head"><div class="sentence-text">${sentHtml}</div><div>${badge}</div></div>`;
    if (errs.length) {
      html += '<ol class="errors">';
      errs.forEach((e, i) => {
        const fix = e.span || e.suggestion
          ? `<div class="fix">${e.span ? `<span class="from">${escapeHtml(e.span)}</span>` : ''}${e.span && e.suggestion ? ' → ' : ''}${e.suggestion ? `<span class="to">${escapeHtml(e.suggestion)}</span>` : ''}</div>`
          : '';
        const unloc = e.span && !positions[i] ? '<div class="unlocated">(could not mark this in the sentence)</div>' : '';
        html += `<li data-err="${i}"><span class="num t-${escapeHtml(e.type)}">${labels[i]}</span><div>`
          + `<div class="err-type">${TYPE_LABEL[e.type] || e.type}</div>${fix}<div class="explain">${escapeHtml(e.explanation)}</div>${unloc}</div></li>`;
      });
      html += '</ol>';
    }
    const showCorr = s.corrected && s.corrected !== s.original;
    const showNat = s.natural && s.natural !== s.corrected && s.natural !== s.original;
    if (showCorr || showNat) {
      html += '<div class="versions">';
      if (showCorr) html += `<div><span class="vlabel">Corrected</span>${escapeHtml(s.corrected)}</div>`;
      if (showNat) html += `<div><span class="vlabel">Natural</span>${escapeHtml(s.natural)}</div>`;
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// Clicking an explanation flashes its highlight, and vice versa.
document.addEventListener('click', (ev) => {
  const li = ev.target.closest('.errors li');
  const mk = ev.target.closest('mark.err');
  const box = ev.target.closest('.sentence');
  if (!box || (!li && !mk)) return;
  const n = (li || mk).dataset.err;
  const target = li ? box.querySelector(`mark[data-err="${n}"]`) : box.querySelector(`.errors li[data-err="${n}"]`);
  if (!target) return;
  if (mk) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 900);
});

function renderHistory(wi) {
  const list = state.history[historyKey(wi)] || [];
  const past = lastResult && lastResult.key === historyKey(wi) ? list.slice(0, -1) : list;
  $('history').hidden = !past.length;
  $('history-summary').textContent = `Previous attempts (${past.length})`;
  $('history-list').innerHTML = past.slice().reverse().map(h =>
    `<div class="history-item"><div class="history-date">${new Date(h.ts).toLocaleString()}</div>${renderResult(h.result)}</div>`
  ).join('');
}

async function check() {
  const idx = blockIndices();
  const wi = idx[state.progress.wordPos];
  const w = words()[wi];
  const text = $('input-text').value.trim();
  if (!text) return;
  if (!state.settings.passphrase) {
    setStatus('Set your passphrase in Settings first.', true);
    return;
  }
  const btn = $('check-btn');
  btn.disabled = true;
  setStatus('<span class="spinner"></span>Checking…', false, true);
  try {
    const r = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: state.settings.passphrase, word: w, text }),
    });
    const data = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok || data.error) throw new Error(data.error || `Server error ${r.status}`);
    const key = historyKey(wi);
    (state.history[key] ||= []).push({ text, result: data, ts: Date.now() });
    if (state.history[key].length > 30) state.history[key].shift();
    save();
    lastResult = { key, result: data };
    $('status').hidden = true;
    $('result').innerHTML = renderResult(data);
    renderHistory(wi);
    document.querySelectorAll('.chip')[state.progress.wordPos]?.classList.add('done');
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setStatus(escapeHtml(e.message || String(e)), true);
  } finally {
    btn.disabled = false;
  }
}
function setStatus(html, isError, raw) {
  const s = $('status');
  s.hidden = false;
  s.className = 'status' + (isError ? ' error' : '');
  s.innerHTML = raw ? html : html;
}
$('check-btn').onclick = check;
$('input-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
});

// ---------- settings ----------
let pending = null; // { parsed, name }

function renderSettings() {
  const d = state.deck;
  $('current-deck').innerHTML = d
    ? `Current list: <strong>${escapeHtml(d.name)}</strong> · ${d.words.length} words`
    : 'No list loaded yet.';
  $('per-day').value = state.settings.perDay;
  $('passphrase').value = state.settings.passphrase || '';
  $('plan-panel').hidden = !d && !pending;
  fillStartSelect(currentWordList(), state.progress.blockStart);
  $('settings-status').textContent = '';
}

function currentWordList() {
  if (pending?.words) return pending.words;
  return words();
}

function fillStartSelect(list, selected) {
  const sel = $('start-select');
  const frag = document.createDocumentFragment();
  list.forEach((w, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i + 1}. ${w.hanzi}${w.pinyin ? '  ·  ' + w.pinyin : ''}`;
    frag.appendChild(o);
  });
  sel.innerHTML = '';
  sel.appendChild(frag);
  if (list.length) sel.value = String(Math.min(selected, list.length - 1));
}

$('start-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
  const qs = strip(q);
  const list = currentWordList();
  const i = list.findIndex(w => w.hanzi === q) >= 0
    ? list.findIndex(w => w.hanzi === q)
    : list.findIndex(w => w.hanzi.includes(q) || strip(w.pinyin).startsWith(qs));
  if (i >= 0) $('start-select').value = String(i);
});

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const parsed = parseAnkiExport(text);
  if (!parsed.rows.length) { alert('No rows found in this file.'); return; }
  const map = guessMapping(parsed);
  pending = { parsed, name: file.name, map };
  setupMapping();
  e.target.value = '';
});

function setupMapping() {
  const { parsed, map } = pending;
  $('mapping').hidden = false;
  $('mapping-info').textContent = `${parsed.rows.length} rows, ${parsed.columns.length} columns. Check that each field points to the right column.`;
  const fields = ['hanzi', 'pinyin', 'meaning', 'example'];
  for (const f of fields) {
    const sel = $('map-' + f);
    sel.innerHTML = `<option value="-1">${f === 'hanzi' ? '— choose —' : '— none —'}</option>` +
      parsed.columns.map((c, k) => `<option value="${k}">${escapeHtml(c)}: ${escapeHtml((parsed.rows[0][k] || '').slice(0, 24))}</option>`).join('');
    sel.value = String(map[f]);
    sel.onchange = () => { map[f] = parseInt(sel.value, 10); updatePreview(); };
  }
  // Guess whether the first row is a header (no CJK in the word column).
  const first = parsed.rows[0][map.hanzi] || '';
  $('skip-first').checked = map.hanzi >= 0 && !/[㐀-鿿]/.test(first) && parsed.rows.length > 1;
  $('skip-first').onchange = updatePreview;
  updatePreview();
}

function updatePreview() {
  const { parsed, map } = pending;
  const skip = $('skip-first').checked;
  pending.words = map.hanzi >= 0 ? buildWords(parsed.rows, map, skip) : [];
  const fieldOf = {};
  for (const [f, k] of Object.entries(map)) if (k >= 0) fieldOf[k] = f;
  const names = { hanzi: 'Word', pinyin: 'Pinyin', meaning: 'Meaning', example: 'Example' };
  const rows = parsed.rows.slice(skip ? 1 : 0, (skip ? 1 : 0) + 4);
  let html = '<tr>' + parsed.columns.map((c, k) =>
    `<th class="${fieldOf[k] ? 'mapped' : ''}">${fieldOf[k] ? names[fieldOf[k]] : escapeHtml(c)}</th>`).join('') + '</tr>';
  html += rows.map(r => '<tr>' + r.map(v => `<td>${escapeHtml(v.length > 80 ? v.slice(0, 80) + '…' : v)}</td>`).join('') + '</tr>').join('');
  $('preview').innerHTML = html;
  $('use-deck').disabled = !pending.words.length;
  $('plan-panel').hidden = false;
  fillStartSelect(pending.words, 0);
}

$('use-deck').onclick = () => {
  if (!pending?.words?.length) return;
  $('mapping').hidden = true;
  $('current-deck').innerHTML = `New list: <strong>${escapeHtml(pending.name)}</strong> · ${pending.words.length} words (press “Save and start” below)`;
  $('start-select').focus();
};

$('save-settings').onclick = () => {
  const per = Math.min(100, Math.max(1, parseInt($('per-day').value, 10) || 7));
  const start = parseInt($('start-select').value, 10) || 0;
  const pass = $('passphrase').value;
  const newDeck = !!pending?.words?.length;
  if (newDeck) {
    $('mapping').hidden = true;
    const changed = !state.deck || JSON.stringify(state.deck.words) !== JSON.stringify(pending.words);
    state.deck = { name: pending.name, words: pending.words, importedAt: Date.now() };
    if (changed) state.history = {};
    pending = null;
  }
  if (!state.deck) { $('settings-status').textContent = 'Load a vocabulary list first.'; return; }
  const p = state.progress;
  if (newDeck || start !== p.blockStart || per !== state.settings.perDay) {
    state.progress = { blockStart: start, blockDate: today(), completed: false, wordPos: 0 };
  }
  state.settings.perDay = per;
  state.settings.passphrase = pass;
  lastResult = null;
  save();
  show('study');
};

$('export-btn').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hsk-sentences-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('import-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !data.deck || !Array.isArray(data.deck.words)) throw new Error('Not a backup file.');
    state = { ...defaultState(), ...data };
    save();
    $('settings-status').textContent = 'Backup imported.';
    renderSettings();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('view-study').hidden) renderStudy();
});

show(state.deck ? 'study' : 'settings');
