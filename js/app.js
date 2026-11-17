import { vocabMessages, normalizeVocab } from '../api/vocab.js';
import { escapeHtml } from './highlight.js';
import { checkMessages, chatMessages, normalizeCheck, callDeepSeek, safeJson } from './prompts.js';
import { renderResult, msgHtml } from './render.js';
import { initGrammar } from './grammar.js';
import { chineseToPinyin, toneNumbersToMarks } from './pinyin.js';
import { initHoverDict } from './hover-dict.js';
import { initChecker } from './checker.js';

let vocabulary = [];
const STORE_KEY = 'hskw.v1';
const $ = (id) => document.getElementById(id);

// ---------- state ----------
function defaultState() {
  return {
    deck: null, // legacy backups only; vocabulary is shared
    settings: { perDay: 7, apiKey: '', passphrase: '' },
    progress: { blockStart: 0, blockDate: today(), completed: false, wordPos: 0 },
    history: {}, // key -> [{ text, result, ts }]
    grammar: { active: {}, stats: {}, generated: [], seen: {}, log: [] },
    free: { mode: 'free', register: 'neutral', history: [] }, // Check page: newest first
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
const words = () => vocabulary;
function localVocab() { try { return JSON.parse(localStorage.getItem('hskw.localVocab') || '[]'); } catch { return []; } }
function storeLocalVocab(items) { localStorage.setItem('hskw.localVocab', JSON.stringify(items)); }
const perDay = () => Math.max(1, state.settings.perDay | 0);
function blockIndices() {
  const start = state.progress.blockStart;
  const end = Math.min(start + perDay(), words().length);
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
const historyKey = (i) => `vocab:${words()[i]?.ankiId}`;

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
  for (const v of ['study', 'grammar', 'check', 'vocab', 'settings']) {
    $('view-' + v).hidden = view !== v;
    $('nav-' + v).classList.toggle('active', view === v);
  }
  if (view === 'study') renderStudy();
  if (view === 'settings') renderSettings();
  if (view === 'vocab') renderVocab();
  if (view === 'grammar') grammar.render();
  if (view === 'check') checker.render();
  try { sessionStorage.setItem('hskw.view', view); } catch {}
  window.scrollTo(0, 0);
}
$('nav-study').onclick = () => show('study');
$('nav-vocab').onclick = () => show('vocab');
$('nav-grammar').onclick = () => show('grammar');
$('nav-check').onclick = () => show('check');
$('nav-settings').onclick = () => show('settings');

// ---------- study ----------
let lastResult = null; // result shown for the current word in this session

function renderStudy() {
  if (!words().length) { show('vocab'); return; }
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
  $('w-pinyin').textContent = toneNumbersToMarks(w.pinyin);
  $('w-meaning').textContent = w.meaning;
  $('w-meaning').hidden = true;
  $('w-meaning-toggle').hidden = !w.meaning;
  $('w-meaning-toggle').textContent = 'Show meaning';
  $('w-example-wrap').hidden = !w.example;
  $('w-example').textContent = toneNumbersToMarks(w.example);
  const examplePinyin = w.examplePinyin ? toneNumbersToMarks(w.examplePinyin) : chineseToPinyin(w.example);
  $('w-example-py').textContent = examplePinyin;
  $('w-example-py').hidden = !examplePinyin;
  $('w-example-tr').textContent = w.exampleTranslation || '';
  $('w-example-tr').hidden = !w.exampleTranslation;
  $('input-text').placeholder = `用「${w.hanzi}」造几个句子……`;

  $('prev-word').disabled = p.wordPos === 0;
  $('next-word').disabled = p.wordPos === idx.length - 1;

  const draftKey = 'hskw.draft.' + historyKey(wi);
  const ta = $('input-text');
  ta.value = sessionStorage.getItem(draftKey) || '';
  ta.oninput = () => { try { sessionStorage.setItem(draftKey, ta.value); } catch {} };

  $('status').hidden = true;
  // Reopening a word shows its latest attempt, so follow-up questions can continue.
  const hist = state.history[historyKey(wi)] || [];
  if ((!lastResult || lastResult.key !== historyKey(wi)) && hist.length) {
    const entry = hist[hist.length - 1];
    lastResult = { key: historyKey(wi), result: entry.result, entry, word: w };
  }
  $('result').innerHTML = lastResult && lastResult.key === historyKey(wi) ? renderResult(lastResult.result) : '';
  renderChat();
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
    `<div class="history-item"><div class="history-date">${new Date(h.ts).toLocaleString()}</div>${renderResult(h.result)}`
    + (h.chat?.length ? `<div class="chat-transcript"><div class="label">Questions</div><div class="chat-log">${h.chat.map(msgHtml).join('')}</div></div>` : '')
    + '</div>'
  ).join('');
}

// ---------- talking to DeepSeek ----------
// Own key: the browser calls DeepSeek directly. Otherwise the owner's passphrase unlocks the server's key.
function hasCredentials() {
  return !!(state.settings.apiKey || state.settings.passphrase);
}
async function postServer(path, payload) {
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch {
    throw new Error('Could not reach the server. Check your internet connection.');
  }
  const data = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok || data.error) throw new Error(data.error || `Server error ${r.status}`);
  return data;
}
async function runCheck(word, text) {
  if (state.settings.apiKey) {
    const content = await callDeepSeek({ key: state.settings.apiKey, messages: checkMessages(word, text), json: true });
    const parsed = safeJson(content);
    if (!parsed) throw new Error('The model returned an unreadable answer. Try again.');
    return normalizeCheck(parsed);
  }
  return postServer('/api/check', { passphrase: state.settings.passphrase, word, text });
}
async function runChat(word, entry) {
  if (state.settings.apiKey) {
    const reply = await callDeepSeek({
      key: state.settings.apiKey,
      messages: chatMessages(word, entry.text, entry.result, entry.chat),
      temperature: 0.4,
      maxTokens: 1500,
    });
    return reply.trim();
  }
  const data = await postServer('/api/chat', {
    passphrase: state.settings.passphrase, word, text: entry.text, result: entry.result, messages: entry.chat,
  });
  return data.reply;
}

async function check() {
  const idx = blockIndices();
  const wi = idx[state.progress.wordPos];
  const w = words()[wi];
  const text = $('input-text').value.trim();
  if (!text) return;
  if (!hasCredentials()) {
    setStatus('Add your DeepSeek API key in Settings first.', true);
    return;
  }
  const btn = $('check-btn');
  btn.disabled = true;
  setStatus('<span class="spinner"></span>Checking…', false, true);
  try {
    const data = await runCheck(w, text);
    const key = historyKey(wi);
    const entry = { text, result: data, ts: Date.now(), chat: [] };
    (state.history[key] ||= []).push(entry);
    if (state.history[key].length > 30) state.history[key].shift();
    save();
    lastResult = { key, result: data, entry, word: w };
    $('status').hidden = true;
    $('result').innerHTML = renderResult(data);
    renderChat();
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

// ---------- word search ----------
const fold = (t) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s'’·\-]/g, '').toLowerCase();

function searchWords(query, limit = 12) {
  const q = query.trim();
  if (!q) return [];
  const qf = fold(q).replace(/v/g, 'u');
  const ql = q.toLowerCase();
  const wordRe = new RegExp(`\\b${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const hits = [];
  words().forEach((w, i) => {
    let score = -1;
    if (w.hanzi === q) score = 0;
    else if (w.hanzi.startsWith(q)) score = 1;
    else if (w.hanzi.includes(q)) score = 2;
    else if (qf) {
      const pf = fold(w.pinyin);
      if (pf === qf) score = 3;
      else if (pf.startsWith(qf)) score = 4;
      else if (/[a-z]/i.test(q) && wordRe.test(w.meaning)) score = 5;
      else if (/[a-z]/i.test(q) && q.length > 2 && w.meaning.toLowerCase().includes(ql)) score = 6;
    }
    if (score >= 0) hits.push({ i, score });
  });
  hits.sort((a, b) => a.score - b.score || a.i - b.i);
  return hits.slice(0, limit).map(h => h.i);
}

function jumpToWord(i) {
  const p = state.progress;
  const n = perDay();
  let start = p.blockStart + Math.floor((i - p.blockStart) / n) * n;
  if (start < 0) start = 0;
  p.blockStart = start;
  p.wordPos = i - start;
  p.completed = false;
  p.blockDate = today();
  lastResult = null;
  save();
  closeSearch();
  renderStudy();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeSearch() {
  $('word-search').value = '';
  $('search-results').hidden = true;
  $('search-results').innerHTML = '';
}

function renderSearch() {
  const box = $('search-results');
  const q = $('word-search').value;
  if (!q.trim()) { box.hidden = true; box.innerHTML = ''; return; }
  const hits = searchWords(q);
  box.hidden = false;
  if (!hits.length) { box.innerHTML = '<div class="search-empty">No matching words</div>'; return; }
  box.innerHTML = hits.map(i => {
    const w = words()[i];
    return `<button type="button" class="search-hit" data-i="${i}">`
      + `<span class="sh-hanzi">${escapeHtml(w.hanzi)}</span>`
      + `<span class="sh-pinyin">${escapeHtml(toneNumbersToMarks(w.pinyin))}</span>`
      + `<span class="sh-meaning">${escapeHtml(w.meaning)}</span>`
      + `<span class="sh-pos">#${i + 1}</span></button>`;
  }).join('');
}

$('word-search').addEventListener('input', renderSearch);
$('word-search').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') { closeSearch(); e.target.blur(); }
  if (e.key === 'Enter') {
    const first = $('search-results').querySelector('.search-hit');
    if (first) jumpToWord(parseInt(first.dataset.i, 10));
  }
});
$('search-results').addEventListener('click', (e) => {
  const hit = e.target.closest('.search-hit');
  if (hit) jumpToWord(parseInt(hit.dataset.i, 10));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.wordsearch')) $('search-results').hidden = true;
});
$('word-search').addEventListener('focus', () => { if ($('word-search').value.trim()) renderSearch(); });

// ---------- follow-up chat ----------
function renderChat() {
  const active = !!(lastResult && lastResult.entry);
  $('chat').hidden = !active;
  $('chat-status').hidden = true;
  if (!active) return;
  $('chat-log').innerHTML = (lastResult.entry.chat || []).map(msgHtml).join('');
}
async function sendChat() {
  if (!lastResult?.entry) return;
  const input = $('chat-input');
  const q = input.value.trim();
  if (!q) return;
  const entry = lastResult.entry;
  entry.chat ||= [];
  entry.chat.push({ role: 'user', content: q });
  input.value = '';
  save();
  renderChat();
  const btn = $('chat-send');
  btn.disabled = true;
  const st = $('chat-status');
  st.hidden = false; st.className = 'status'; st.innerHTML = '<span class="spinner"></span>Thinking…';
  try {
    const reply = await runChat(lastResult.word || words()[blockIndices()[state.progress.wordPos]], entry);
    entry.chat.push({ role: 'assistant', content: reply });
    save();
    renderChat();
  } catch (e) {
    entry.chat.pop(); // let the user resend
    input.value = q;
    save();
    renderChat();
    st.hidden = false; st.className = 'status error'; st.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});

// ---------- settings ----------
function renderSettings() {
  $('current-deck').textContent = `${words().length} shared HSK words`;
  $('per-day').value = state.settings.perDay;
  $('passphrase').value = state.settings.passphrase || '';
  $('api-key').value = state.settings.apiKey || '';
  $('credential-mode').textContent = state.settings.apiKey ? 'Using your API key. Clear it and save to use the passphrase instead.' : state.settings.passphrase ? 'Using the owner passphrase.' : '';
  document.querySelector('.passphrase-box').open = !!state.settings.passphrase;
  fillStartSelect(words(), state.progress.blockStart);
  $('settings-status').textContent = '';
}
function fillStartSelect(list, selected) {
  const sel = $('start-select');
  sel.innerHTML = '';
  list.forEach((w, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `${w.ankiId}. ${w.hanzi} ? ${w.meaning}`;
    sel.appendChild(option);
  });
  sel.value = String(Math.min(selected, list.length - 1));
}
$('start-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const i = words().findIndex(w => w.ankiId === q || w.hanzi.includes(q) || w.pinyin.toLowerCase().includes(q));
  if (i >= 0) $('start-select').value = String(i);
});
const vocabColumns = [
  ['ankiId', 'ID'], ['hanzi', 'Word'], ['meaning', 'Translation'],
  ['pinyin', 'Pinyin'], ['example', 'Example'], ['partOfSpeech', 'Part of speech'],
  ['origin', 'Origin'], ['dateAdded', 'Date added'], ['traditional', 'Traditional'],
  ['examplePinyin', 'Example pinyin'], ['exampleTranslation', 'Example translation'],
  ['homophone', 'Homophone'], ['homograph', 'Homograph'],
];
const mandatoryVocabColumns = new Set(['ankiId', 'hanzi', 'meaning']);
let visibleVocabColumns;
try { visibleVocabColumns = new Set(JSON.parse(localStorage.getItem('hskw.vocabColumns'))); }
catch { visibleVocabColumns = new Set(['ankiId', 'hanzi', 'meaning', 'pinyin', 'example', 'partOfSpeech', 'origin', 'dateAdded']); }
mandatoryVocabColumns.forEach(key => visibleVocabColumns.add(key));
let vocabSort = 'ankiId', vocabDescending = false;
const selectedVocab = new Set();
function deletedVocabIds() {
  try { return new Set(JSON.parse(localStorage.getItem('hskw.deletedVocabIds') || '[]')); }
  catch { return new Set(); }
}
function renderDeleteButton() {
  $('vocab-delete').hidden = !selectedVocab.size;
  $('vocab-delete').textContent = `Delete selected (${selectedVocab.size})`;
  $('vocab-export-selected').hidden = !selectedVocab.size;
}
$('vocab-column-options').innerHTML = vocabColumns.map(([key, label]) => `<label><input type="checkbox" value="${key}" ${visibleVocabColumns.has(key) ? 'checked' : ''} ${mandatoryVocabColumns.has(key) ? 'disabled' : ''}> ${label}</label>`).join('');
$('vocab-column-options').onchange = event => {
  const input = event.target;
  if (input.checked) visibleVocabColumns.add(input.value);
  else visibleVocabColumns.delete(input.value);
  localStorage.setItem('hskw.vocabColumns', JSON.stringify([...visibleVocabColumns]));
  renderVocab();
};
function renderVocab() {
  const q = $('vocab-search').value.trim().toLowerCase();
  const filtered = words().map((w, i) => ({ ...w, index: i })).filter(w =>
    !q || [w.ankiId, w.hanzi, w.meaning, w.pinyin, w.example, w.origin].some(v => v.toLowerCase().includes(q)));
  filtered.sort((a, b) => {
    const x = vocabSort === 'ankiId' ? (Number(a.ankiId) || Infinity) - (Number(b.ankiId) || Infinity)
      : a[vocabSort].localeCompare(b[vocabSort], undefined, { numeric: true });
    return (vocabDescending ? -x : x) || a.index - b.index;
  });
  const columns = vocabColumns.filter(([key]) => visibleVocabColumns.has(key));
  const page = filtered.slice(0, 200);
  $('vocab-head').innerHTML = `<tr><th class="vocab-select-cell"><input id="vocab-select-all" type="checkbox" aria-label="Select all displayed words" ${page.length && page.every(w => selectedVocab.has(w.ankiId)) ? 'checked' : ''}></th>${columns.map(([key, label]) => `<th><button data-vocab-sort="${key}" type="button" aria-label="Sort by ${label}">${label}<span class="sort-indicator">${key === vocabSort ? (vocabDescending ? ' \u2193' : ' \u2191') : ''}</span></button></th>`).join('')}<th>Position</th><th class="vocab-info-cell"><span class="sr-only">Info</span></th></tr>`;
  $('vocab-count').textContent = `${filtered.length} of ${words().length} words`;
  $('vocab-body').innerHTML = page.map(w => `<tr><td class="vocab-select-cell"><input class="vocab-select" type="checkbox" value="${escapeHtml(w.ankiId)}" aria-label="Select ${escapeHtml(w.hanzi)}" ${selectedVocab.has(w.ankiId) ? 'checked' : ''}></td>${columns.map(([key]) => `<td>${escapeHtml(w[key] || '')}</td>`).join('')}<td><button class="ghost vocab-mark" data-index="${w.index}" type="button">${w.index === state.progress.blockStart ? 'Current' : 'Start here'}</button></td><td class="vocab-info-cell"><button class="vocab-info" data-index="${w.index}" type="button" aria-label="Details for ${escapeHtml(w.hanzi)}"><span aria-hidden="true">i</span></button></td></tr>`).join('');
  renderDeleteButton();
  $('vocab-limit').textContent = filtered.length > 200 ? 'Showing first 200 matches. Search to narrow the list.' : '';
}
$('vocab-search').addEventListener('input', renderVocab);
$('vocab-head').onchange = event => {
  if (event.target.id !== 'vocab-select-all') return;
  document.querySelectorAll('.vocab-select').forEach(input => {
    input.checked = event.target.checked;
    if (input.checked) selectedVocab.add(input.value); else selectedVocab.delete(input.value);
  });
  renderDeleteButton();
};
$('vocab-body').onchange = event => {
  if (!event.target.matches('.vocab-select')) return;
  if (event.target.checked) selectedVocab.add(event.target.value); else selectedVocab.delete(event.target.value);
  renderDeleteButton();
};
$('vocab-delete').onclick = () => {
  const deleted = deletedVocabIds();
  const removedLocal = new Set([...selectedVocab]);
  storeLocalVocab(localVocab().filter(w => !removedLocal.has(w.ankiId)));
  selectedVocab.forEach(id => deleted.add(id));
  localStorage.setItem('hskw.deletedVocabIds', JSON.stringify([...deleted]));
  const currentId = words()[state.progress.blockStart]?.ankiId;
  vocabulary = vocabulary.filter(w => !deleted.has(w.ankiId));
  state.progress.blockStart = Math.max(0, vocabulary.findIndex(w => w.ankiId === currentId));
  state.progress.wordPos = 0;
  state.progress.completed = false;
  selectedVocab.clear();
  save(); renderVocab();
};
$('vocab-head').onclick = event => {
  const button = event.target.closest('[data-vocab-sort]');
  if (!button) return;
  const key = button.dataset.vocabSort;
  vocabDescending = key === vocabSort ? !vocabDescending : false;
  vocabSort = key; renderVocab();
};
$('vocab-body').onclick = event => {
  const info = event.target.closest('.vocab-info');
  if (info) { openVocabEditor(Number(info.dataset.index)); return; }
  const button = event.target.closest('.vocab-mark');
  if (!button) return;
  state.progress = { blockStart: Number(button.dataset.index), blockDate: today(), completed: false, wordPos: 0 };
  save(); show('study');
};

const editFields = [
  ['hanzi', 'Word'], ['traditional', 'Traditional'], ['pinyin', 'Pinyin'],
  ['numberedPinyin', 'Numbered pinyin'], ['meaning', 'Translation'],
  ['partOfSpeech', 'Part of speech'], ['example', 'Example sentence'],
  ['exampleTraditional', 'Traditional example'], ['examplePinyin', 'Example pinyin'],
  ['exampleNumberedPinyin', 'Numbered example pinyin'], ['exampleTranslation', 'Example translation'],
  ['exampleCloze', 'Cloze sentence'], ['exampleTraditionalCloze', 'Traditional cloze sentence'],
  ['homophone', 'Homophone'], ['homograph', 'Homograph'], ['origin', 'Origin'],
  ['dateAdded', 'Date added'], ['audio', 'Audio'], ['exampleAudio', 'Example audio'], ['exampleImage', 'Example image'],
];
let editingVocabIndex = -1;
function openVocabEditor(index) {
  editingVocabIndex = index;
  const word = words()[index];
  $('vocab-edit-fields').innerHTML = `<label>ID<input value="${escapeHtml(word.ankiId)}" disabled></label>` +
    editFields.map(([key, label]) => `<label>${label}<textarea name="${key}" rows="${['meaning', 'example', 'exampleTranslation'].includes(key) ? 2 : 1}">${escapeHtml(word[key] || '')}</textarea></label>`).join('');
  $('vocab-editor').showModal();
}
$('vocab-edit-cancel').onclick = () => $('vocab-editor').close();
$('vocab-edit-form').onsubmit = event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const old = words()[editingVocabIndex];
  const updated = { ...old };
  for (const [key] of editFields) updated[key] = String(form.get(key) || '').trim();
  if (!updated.hanzi || !updated.meaning) { alert('Word and translation are required.'); return; }
  vocabulary[editingVocabIndex] = updated;
  if (updated.origin === 'Personal' || old.origin === 'Personal') {
    storeLocalVocab([...localVocab().filter(w => w.ankiId !== old.ankiId), updated]);
  } else {
    const edits = JSON.parse(localStorage.getItem('hskw.vocabEdits') || '{}');
    edits[old.ankiId] = updated;
    localStorage.setItem('hskw.vocabEdits', JSON.stringify(edits));
  }
  $('vocab-editor').close(); renderVocab();
};
async function exportAnki(wordsToExport, name) {
  if (!wordsToExport.length) { alert('No vocabulary to export.'); return; }
  try {
    const response = await fetch('/api/anki-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: wordsToExport }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Export failed (${response.status})`);
    }
    const blob = await response.blob();
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = `${name}-${today()}.apkg`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { alert(`Anki export failed: ${error.message}`); }
}
$('vocab-export-personal').onclick = () => exportAnki(words().filter(w => w.origin === 'Personal'), 'personal-vocabulary');
$('vocab-export-selected').onclick = () => exportAnki(words().filter(w => selectedVocab.has(w.ankiId)), 'selected-vocabulary');

$('save-settings').onclick = () => {
  const per = Math.min(100, Math.max(1, parseInt($('per-day').value, 10) || 7));
  const start = parseInt($('start-select').value, 10) || 0;
  const pass = $('passphrase').value.trim();
  const apiKey = $('api-key').value.trim();
  const p = state.progress;
  if (start !== p.blockStart || per !== state.settings.perDay) {
    state.progress = { blockStart: start, blockDate: today(), completed: false, wordPos: 0 };
  }
  state.settings.perDay = per;
  state.settings.passphrase = pass;
  state.settings.apiKey = apiKey;
  lastResult = null;
  save();
  show('study');
};

$('export-btn').onclick = () => {
  const { apiKey, passphrase, ...shareable } = state.settings;
  const blob = new Blob([JSON.stringify({ ...state, deck: null, deletedVocabIds: [...deletedVocabIds()], localVocab: localVocab(), vocabEdits: JSON.parse(localStorage.getItem('hskw.vocabEdits') || '{}'), settings: shareable }, null, 1)], { type: 'application/json' });
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
    if (!data || typeof data !== 'object' || !(data.progress || data.grammar || data.free)) throw new Error('Not a backup file.');
    const keep = { apiKey: state.settings.apiKey, passphrase: state.settings.passphrase };
    state = { ...defaultState(), ...data, deck: null };
    if (Array.isArray(data.localVocab)) storeLocalVocab(data.localVocab);
    if (data.vocabEdits && typeof data.vocabEdits === 'object') localStorage.setItem('hskw.vocabEdits', JSON.stringify(data.vocabEdits));
    if (Array.isArray(data.deletedVocabIds)) {
      localStorage.setItem('hskw.deletedVocabIds', JSON.stringify(data.deletedVocabIds));
      vocabulary = vocabulary.filter(w => !data.deletedVocabIds.includes(w.ankiId));
    }
    state.grammar = { ...defaultState().grammar, ...(data.grammar || {}) };
    state.settings = { ...defaultState().settings, ...(data.settings || {}), ...keep };
    checker.reset();
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

// Hover (or tap) any Chinese character for its word, pinyin and meaning. The dictionary loads on first use.
initHoverDict({ getWords: words });

const grammar = initGrammar({
  getState: () => state,
  save,
  hasCredentials,
  callModel: async ({ action, payload, messages, json, temperature, maxTokens }) => {
    if (state.settings.apiKey) return callDeepSeek({ key: state.settings.apiKey, messages, json, temperature, maxTokens });
    const data = await postServer('/api/grammar', { passphrase: state.settings.passphrase, action, ...payload });
    return data.content;
  },
  goSettings: () => show('settings'),
});

const checker = initChecker({
  getState: () => state,
  save,
  hasCredentials,
  ownKey: () => state.settings.apiKey,
  server: (path, payload) => postServer(path, { passphrase: state.settings.passphrase, ...payload }),
  goSettings: () => show('settings'),
});

let selectedExpression = '';
function hideSelectionAction() { $('selection-action').hidden = true; }
function updateSelectionAction() {
  const selection = window.getSelection();
  const text = selection?.toString().trim() || '';
  if (!text || text.length > 40 || !/[\u3400-\u9fff]/u.test(text) ||
      selection.anchorNode?.parentElement?.closest('input, textarea, select, [contenteditable], .selection-action')) {
    hideSelectionAction(); return;
  }
  selectedExpression = text;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const popup = $('selection-action');
  popup.hidden = false;
  popup.style.left = `${Math.min(window.innerWidth - 160, Math.max(8, rect.left))}px`;
  popup.style.top = `${Math.min(window.innerHeight - 48, rect.bottom + 8)}px`;
  $('selection-status').textContent = '';
}
document.addEventListener('mouseup', () => setTimeout(updateSelectionAction, 0));
document.addEventListener('keyup', event => { if (event.key === 'Escape') hideSelectionAction(); else updateSelectionAction(); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('.selection-action')) hideSelectionAction(); });
$('add-selection').onclick = async () => {
  const text = selectedExpression;
  const button = $('add-selection');
  button.disabled = true;
  $('selection-status').textContent = 'Creating?';
  try {
    if (!hasCredentials()) throw new Error('Add a DeepSeek key or passphrase in Settings first.');
    const data = state.settings.apiKey
      ? normalizeVocab(safeJson(await callDeepSeek({ key: state.settings.apiKey, messages: vocabMessages(text), json: true, maxTokens: 700 })), text)
      : normalizeVocab(await postServer('/api/vocab', { passphrase: state.settings.passphrase, text }), text);
    if (words().some(w => w.hanzi === text)) throw new Error('This expression is already in your vocabulary list.');
    const entry = { ...data, ankiId: `user-${Date.now()}`, noteId: '', origin: 'Personal', dateAdded: today() };
    storeLocalVocab([...localVocab(), entry]);
    vocabulary.push(entry);
    hideSelectionAction();
    if (!$('view-vocab').hidden) renderVocab();
  } catch (error) { $('selection-status').textContent = error.message; }
  finally { button.disabled = false; }
};

async function start() {
  try {
    const response = await fetch('data/vocab.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const edits = JSON.parse(localStorage.getItem('hskw.vocabEdits') || '{}');
    vocabulary = [...(await response.json()).map(w => edits[w.ankiId] || w), ...localVocab()].filter(w => !deletedVocabIds().has(w.ankiId));
    state.deck = null;
    if (state.progress.blockStart >= vocabulary.length) state.progress.blockStart = 0;
    let startView = null;
    try { startView = sessionStorage.getItem('hskw.view'); } catch {}
    show(['study', 'grammar', 'check', 'vocab', 'settings'].includes(startView) ? startView : 'study');
  } catch (error) {
    show('settings');
    $('settings-status').textContent = `Could not load vocabulary: ${error.message}`;
  }
}
start();
