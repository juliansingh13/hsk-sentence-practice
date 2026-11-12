import { parseAnkiExport, guessMapping, buildWords } from './anki.js';
import { escapeHtml } from './highlight.js';
import { checkMessages, chatMessages, normalizeCheck, callDeepSeek, safeJson } from './prompts.js';
import { renderResult, msgHtml } from './render.js';
import { initGrammar } from './grammar.js';
import { chineseToPinyin, toneNumbersToMarks } from './pinyin.js';

const STORE_KEY = 'hskw.v1';
const $ = (id) => document.getElementById(id);

// ---------- state ----------
function defaultState() {
  return {
    deck: null, // { name, words: [{hanzi,pinyin,meaning,example}], importedAt }
    settings: { perDay: 7, apiKey: '', passphrase: '' },
    progress: { blockStart: 0, blockDate: today(), completed: false, wordPos: 0 },
    history: {}, // key -> [{ text, result, ts }]
    grammar: { active: {}, stats: {}, generated: [], seen: {}, log: [] },
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
  for (const v of ['study', 'grammar', 'settings']) {
    $('view-' + v).hidden = view !== v;
    $('nav-' + v).classList.toggle('active', view === v);
  }
  if (view === 'study') renderStudy();
  if (view === 'settings') renderSettings();
  if (view === 'grammar') grammar.render();
  try { sessionStorage.setItem('hskw.view', view); } catch {}
  window.scrollTo(0, 0);
}
$('nav-study').onclick = () => (state.deck ? show('study') : show('settings'));
$('nav-grammar').onclick = () => show('grammar');
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
let pending = null; // { parsed, name }

function renderSettings() {
  const d = state.deck;
  $('current-deck').innerHTML = d
    ? `Current list: <strong>${escapeHtml(d.name)}</strong> · ${d.words.length} words`
    : 'No list loaded yet.';
  $('per-day').value = state.settings.perDay;
  $('passphrase').value = state.settings.passphrase || '';
  $('api-key').value = state.settings.apiKey || '';
  document.querySelector('.passphrase-box').open = !!state.settings.passphrase;
  $('intro').hidden = !!state.deck;
  $('plan-panel').hidden = false;
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
    o.textContent = `${i + 1}. ${w.hanzi}${w.pinyin ? '  ·  ' + toneNumbersToMarks(w.pinyin) : ''}`;
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
  const fields = ['hanzi', 'pinyin', 'meaning', 'example', 'examplePinyin', 'exampleTranslation', 'order'];
  for (const f of fields) {
    const sel = $('map-' + f);
    const none = f === 'hanzi' ? '— choose —' : f === 'order' ? 'File order' : '— none —';
    sel.innerHTML = `<option value="-1">${none}</option>` +
      parsed.columns.map((c, k) => `<option value="${k}">${escapeHtml(c)}: ${escapeHtml(toneNumbersToMarks((parsed.rows[0][k] || '').slice(0, 24)))}</option>`).join('');
    sel.value = String(map[f] ?? -1);
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
  for (const [f, k] of Object.entries(map)) if (k >= 0 && f !== 'order') fieldOf[k] = f;
  const names = { hanzi: 'Word', pinyin: 'Pinyin', meaning: 'Meaning', example: 'Example', examplePinyin: 'Ex. pinyin', exampleTranslation: 'Ex. translation' };
  const rows = parsed.rows.slice(skip ? 1 : 0, (skip ? 1 : 0) + 4);
  let html = '<tr>' + parsed.columns.map((c, k) =>
    `<th class="${fieldOf[k] ? 'mapped' : ''}">${fieldOf[k] ? names[fieldOf[k]] : escapeHtml(c)}</th>`).join('') + '</tr>';
  html += rows.map(r => '<tr>' + r.map((v, k) => {
    const field = fieldOf[k];
    const displayed = field === 'pinyin' || field === 'examplePinyin' || field === 'example'
      ? toneNumbersToMarks(v)
      : v;
    return `<td>${escapeHtml(displayed.length > 80 ? displayed.slice(0, 80) + '…' : displayed)}</td>`;
  }).join('') + '</tr>').join('');
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
  const pass = $('passphrase').value.trim();
  const apiKey = $('api-key').value.trim();
  const newDeck = !!pending?.words?.length;
  if (newDeck) {
    $('mapping').hidden = true;
    const changed = !state.deck || JSON.stringify(state.deck.words) !== JSON.stringify(pending.words);
    state.deck = { name: pending.name, words: pending.words, importedAt: Date.now() };
    if (changed) state.history = {};
    pending = null;
  }
  state.settings.passphrase = pass;
  state.settings.apiKey = apiKey;
  if (!state.deck) { save(); $('settings-status').textContent = 'Key saved. Load a vocabulary list for the Words section; the Grammar section works without one.'; return; }
  const p = state.progress;
  if (newDeck || start !== p.blockStart || per !== state.settings.perDay) {
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
  const blob = new Blob([JSON.stringify({ ...state, settings: shareable }, null, 1)], { type: 'application/json' });
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
    if (!data || typeof data !== 'object' || !(data.deck?.words || data.grammar)) throw new Error('Not a backup file.');
    const keep = { apiKey: state.settings.apiKey, passphrase: state.settings.passphrase };
    state = { ...defaultState(), ...data };
    state.grammar = { ...defaultState().grammar, ...(data.grammar || {}) };
    state.settings = { ...defaultState().settings, ...(data.settings || {}), ...keep };
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

let startView = null;
try { startView = sessionStorage.getItem('hskw.view'); } catch {}
if (startView === 'grammar') show('grammar');
else if (startView === 'settings') show('settings');
else show(state.deck ? 'study' : 'settings');
