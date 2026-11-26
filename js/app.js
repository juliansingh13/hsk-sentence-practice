import { vocabMessages, normalizeVocab } from './vocab.js';
import { escapeHtml } from './highlight.js';
import { checkMessages, chatMessages, normalizeCheck, callDeepSeek, safeJson } from './prompts.js';
import { renderResult, msgHtml } from './render.js';
import { initGrammar } from './grammar.js';
import { chineseToPinyin, toneNumbersToMarks } from './pinyin.js';
import { initHoverDict } from './hover-dict.js';
import { initChecker } from './checker.js';
import { STRUCTURES, GROUPS } from './grammar-data.js';
import { grammarCheckMessages } from './grammar-prompts.js';
import { storyMessages } from './story-prompt.js';

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
    wordGrammar: { enabled: false, levels: [1, 2, 3, 4, 5, 6], structureId: null },
    dailyStories: {},
    similarWords: { notes: {}, hidden: {} },
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
if (state.settings.includeHsk === undefined) state.settings.includeHsk = !!localStorage.getItem(STORE_KEY);
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
function wordGrammar() { return state.wordGrammar ||= { enabled: false, levels: [1, 2, 3, 4, 5, 6], structureId: null }; }
function selectedWordGrammar() { return STRUCTURES.find(s => s.id === wordGrammar().structureId) || null; }
function newWordGrammar() {
  const pool = STRUCTURES.filter(s => wordGrammar().levels.includes(s.lvl) && s.id !== wordGrammar().structureId);
  if (!pool.length) return;
  wordGrammar().structureId = pool[Math.floor(Math.random() * pool.length)].id;
  save(); renderWordGrammarControls();
}
function renderWordGrammarControls() {
  const config = wordGrammar();
  $('word-grammar-enabled').checked = config.enabled;
  $('word-grammar-options').hidden = !config.enabled;
  const structure = selectedWordGrammar();
  $('word-grammar-current').innerHTML = structure ? `<strong>${escapeHtml(structure.p)}</strong> <span>HSK ${structure.lvl} · ${escapeHtml(structure.m[0] || '')}</span>` : 'Choose a grammar point to begin.';
  for (const checkbox of document.querySelectorAll('[data-word-grammar-level]')) checkbox.checked = config.levels.includes(Number(checkbox.value));
}
function renderWordGrammarResult(entry) {
  if (!entry?.grammarStructureId) return '';
  const structure = STRUCTURES.find(s => s.id === entry.grammarStructureId);
  if (!structure) return '';
  const result = entry.grammarResult;
  const used = result?.sentences?.some(sentence => sentence.target_word_used);
  const errors = result?.sentences?.flatMap(sentence => sentence.errors || []) || [];
  const score = entry.grammarError ? 'Check unavailable' : !used ? 'Not used' : errors.some(error => error.type === 'target_word') ? 'Needs work' : 'Used correctly';
  return `<section class="word-grammar-feedback"><h3>Grammar practice <span class="badge ${score === 'Used correctly' ? 'ok' : 'warn'}">${score}</span></h3><p>${escapeHtml(structure.p)} · HSK ${structure.lvl}</p>${entry.grammarError ? `<p>${escapeHtml(entry.grammarError)}</p>` : renderResult(result, { target_word: 'Structure', notUsed: 'Structure not used' })}</section>`;
}
$('word-grammar-enabled').onchange = event => {
  wordGrammar().enabled = event.target.checked;
  if (event.target.checked && !selectedWordGrammar()) newWordGrammar();
  save(); renderWordGrammarControls();
};
$('word-grammar-new').onclick = newWordGrammar;
document.querySelector('.word-grammar-levels').onchange = event => {
  if (!event.target.matches('[data-word-grammar-level]')) return;
  const level = Number(event.target.value);
  const levels = wordGrammar().levels;
  wordGrammar().levels = event.target.checked ? [...new Set([...levels, level])].sort() : levels.filter(n => n !== level);
  save();
};
$('word-grammar-choose').onclick = () => { renderWordGrammarPicker(); $('word-grammar-dialog').showModal(); };
function renderWordGrammarPicker() {
  const levels = wordGrammar().levels;
  $('word-grammar-picker-levels').innerHTML = [1, 2, 3, 4, 5, 6].map(level => `<button type="button" class="ghost${levels.includes(level) ? ' active' : ''}" data-picker-level="${level}">HSK ${level}</button>`).join('');
  const query = $('word-grammar-search').value.trim().toLowerCase();
  $('word-grammar-picker-list').innerHTML = STRUCTURES.filter(s => levels.includes(s.lvl) && (!query || `${s.p} ${s.py} ${s.m.join(' ')} ${GROUPS[s.g] || ''}`.toLowerCase().includes(query))).map(s => `<button type="button" class="grammar-pick${s.id === wordGrammar().structureId ? ' active' : ''}" data-pick-structure="${escapeHtml(s.id)}"><strong>${escapeHtml(s.p)}</strong><span>HSK ${s.lvl} · ${escapeHtml(GROUPS[s.g] || '')}</span><small>${escapeHtml(s.m[0] || '')}</small></button>`).join('') || '<p>No grammar points match these filters.</p>';
}
$('word-grammar-search').oninput = renderWordGrammarPicker;
$('word-grammar-picker-levels').onclick = event => {
  const button = event.target.closest('[data-picker-level]');
  if (!button) return;
  const level = Number(button.dataset.pickerLevel);
  const levels = wordGrammar().levels;
  wordGrammar().levels = levels.includes(level) ? levels.filter(n => n !== level) : [...levels, level].sort();
  save(); renderWordGrammarPicker(); renderWordGrammarControls();
};
$('word-grammar-picker-list').onclick = event => {
  const button = event.target.closest('[data-pick-structure]');
  if (!button) return;
  wordGrammar().structureId = button.dataset.pickStructure;
  wordGrammar().enabled = true;
  save(); renderWordGrammarControls(); $('word-grammar-dialog').close();
};
$('word-grammar-dialog-close').onclick = () => $('word-grammar-dialog').close();

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
  renderDailyStory();
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
  $('w-similar').hidden = true;
  $('w-similar-toggle').textContent = 'Show similar words';
  renderSimilarWords(wi);
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
  $('word-grammar-result').innerHTML = lastResult?.key === historyKey(wi) ? renderWordGrammarResult(lastResult.entry) : '';
  renderWordGrammarControls();
  renderChat();
  renderHistory(wi);

  $('done-btn').hidden = p.completed;
  $('done-msg').hidden = !p.completed;
  if (p.completed) {
    $('done-msg').innerHTML = 'Done. The next block opens tomorrow. <button class="ghost" id="skip-ahead" type="button">Start it now</button>';
    $('skip-ahead').onclick = () => moveBlock(1);
  }
}

let storyOpen = false;
let storyLoading = false;
let draftStoryAdvanced = null;
function storyKey() { return blockIndices().map(i => String(words()[i]?.ankiId)).join('|'); }
function storyExtras() { return (state.storyExtras ||= {})[storyKey()] ||= []; }
function storyPrefs() { return (state.storyPrefs ||= {})[storyKey()] ||= { length: 'medium', level: 4, translation: false, highlight: false, grammar: [], characterMode: false }; }
function renderStoryGrammar() {
  const query = $('story-grammar-search').value.trim().toLowerCase();
  const selected = new Set((draftStoryAdvanced || storyPrefs()).grammar || []);
  const list = STRUCTURES.filter(s => selected.has(s.id) || !query || `${s.p} ${s.py} ${s.m.join(' ')}`.toLowerCase().includes(query)).slice(0, 100);
  $('story-grammar-options').innerHTML = list.map(s => `<label class="story-grammar-choice"><input type="checkbox" value="${escapeHtml(s.id)}" ${selected.has(s.id) ? 'checked' : ''}><span>${escapeHtml(s.p)}</span><small>HSK ${s.lvl} · ${escapeHtml(s.m[0] || '')}</small></label>`).join('');
}
function storyHighlightedHtml(sentence, terms, relatedTerms = []) {
  const text = String(sentence || '');
  if (!terms.length && !relatedTerms.length) return escapeHtml(text);
  let html = '';
  for (let i = 0; i < text.length;) {
    const match = terms.find(term => text.startsWith(term, i));
    const related = !match && relatedTerms.find(term => text.startsWith(term, i));
    if (match) { html += `<mark class="story-word-mark">${escapeHtml(match)}</mark>`; i += match.length; }
    else if (related) { html += `<mark class="story-related-mark">${escapeHtml(related)}</mark>`; i += related.length; }
    else { html += escapeHtml(text[i]); i++; }
  }
  return html;
}
function renderDailyStory() {
  const story = (state.dailyStories ||= {})[storyKey()];
  const prefs = storyPrefs();
  $('daily-story').hidden = !storyOpen;
  $('study-layout').hidden = storyOpen;
  $('daily-story-open').textContent = storyOpen ? 'Viewing story' : "Read today's story";
  $('daily-story-open').disabled = storyLoading;
  $('daily-story-new').disabled = storyLoading;
  $('daily-story-length').value = prefs.length;
  $('daily-story-level').value = String(prefs.level);
  $('daily-story-translation').checked = prefs.translation;
  $('daily-story-highlight').checked = !!prefs.highlight;
  $('story-character-mode').checked = !!(draftStoryAdvanced || prefs).characterMode;
  $('story-apply').disabled = storyLoading;
  renderStoryGrammar();
  $('daily-story-word').disabled = storyLoading;
  $('daily-story-add').querySelector('button').disabled = storyLoading;
  const dailyIds = new Set(blockIndices().map(i => String(words()[i]?.ankiId)));
  const extraIds = new Set(storyExtras());
  if (!storyLoading) renderStorySuggestions();
  $('daily-story-extra').innerHTML = storyExtras().map(id => {
    const word = words().find(w => String(w.ankiId) === id);
    return word ? `<span class="story-extra-chip">${escapeHtml(word.hanzi)} <button type="button" data-story-remove="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(word.hanzi)} and regenerate">×</button></span>` : '';
  }).join('');
  $('daily-story-status').textContent = storyLoading ? 'Writing a story with today\'s words…' : storyOpen && !story ? 'Generate a story to begin.' : '';
  const lines = typeof story === 'string' ? story.split(/(?<=[。！？])\s*/).filter(Boolean).map(zh => ({ zh, en: '' })) : story?.sentences || [];
  const selectedIds = new Set([...blockIndices().map(i => String(words()[i]?.ankiId)), ...storyExtras()]);
  const chosen = words().filter(w => selectedIds.has(String(w.ankiId))).map(w => w.hanzi).filter(Boolean);
  const terms = prefs.highlight ? [...new Set(chosen)].sort((a, b) => b.length - a.length) : [];
  const characters = new Set(chosen.flatMap(word => [...word].filter(char => /[\u3400-\u9fff]/u.test(char))));
  const relatedTerms = prefs.highlight && prefs.characterMode ? [...new Set(words().map(w => w.hanzi).filter(word => word && !terms.includes(word) && [...word].some(char => characters.has(char))))].sort((a, b) => b.length - a.length) : [];
  $('daily-story-text').innerHTML = lines.map(line => `<p class="story-sentence"><span>${storyHighlightedHtml(line.zh, terms, relatedTerms)}</span>${prefs.translation && line.en ? `<span class="story-english">${escapeHtml(line.en)}</span>` : ''}</p>`).join('');
}
async function generateDailyStory() {
  if (storyLoading) return;
  if (!hasCredentials()) { show('settings'); $('settings-status').textContent = 'Add a DeepSeek key or passphrase to generate a story.'; return; }
  const key = storyKey();
  const previous = state.dailyStories?.[key];
  const prefs = { ...storyPrefs() };
  const dailyIds = new Set(blockIndices().map(i => String(words()[i]?.ankiId)));
  const selected = [...blockIndices().map(i => words()[i]), ...words().filter(w => storyExtras().includes(String(w.ankiId)) && !dailyIds.has(String(w.ankiId)))];
  const dailyWords = selected.map(w => ({ hanzi: w.hanzi, pinyin: w.pinyin, meaning: w.meaning }));
  storyLoading = true; renderDailyStory();
  try {
    const previousStory = previous?.sentences?.map(s => s.zh).join('') || previous || '';
    const grammar = STRUCTURES.filter(s => (prefs.grammar || []).includes(s.id)).map(s => ({ pattern: s.p, meaning: s.m[0] || '' }));
    const messages = storyMessages({ words: dailyWords, length: prefs.length, hskLevel: prefs.level, previousStory, grammar, characterMode: !!prefs.characterMode });
    const text = state.settings.apiKey
      ? await callDeepSeek({ key: state.settings.apiKey, messages, json: true, temperature: 0.9, maxTokens: 2400 })
      : (await postServer('/api/story', { passphrase: state.settings.passphrase, words: dailyWords, length: prefs.length, level: prefs.level, previousStory, grammar, characterMode: !!prefs.characterMode })).content;
    const parsed = safeJson(text);
    if (!Array.isArray(parsed?.sentences) || !parsed.sentences.length) throw new Error('The story could not be read.');
    state.dailyStories[key] = { sentences: parsed.sentences.filter(s => s && typeof s.zh === 'string').map(s => ({ zh: s.zh, en: String(s.en || '') })) }; save();
  } catch (error) { $('daily-story-status').textContent = `Could not generate story: ${error.message}`; }
  finally { storyLoading = false; renderDailyStory(); }
}
$('daily-story-open').onclick = () => { storyOpen = true; renderDailyStory(); if (!state.dailyStories?.[storyKey()]) generateDailyStory(); };
$('daily-story-new').onclick = generateDailyStory;
$('daily-story-length').onchange = event => { storyPrefs().length = event.target.value; save(); generateDailyStory(); };
$('daily-story-level').onchange = event => { storyPrefs().level = Number(event.target.value); save(); generateDailyStory(); };
$('daily-story-translation').onchange = event => { storyPrefs().translation = event.target.checked; save(); renderDailyStory(); };
$('daily-story-highlight').onchange = event => { storyPrefs().highlight = event.target.checked; save(); renderDailyStory(); };
$('story-grammar-search').oninput = renderStoryGrammar;
$('story-grammar-options').onchange = event => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  draftStoryAdvanced ||= { grammar: [...(storyPrefs().grammar || [])], characterMode: !!storyPrefs().characterMode };
  const selected = new Set(draftStoryAdvanced.grammar);
  if (input.checked) selected.add(input.value); else selected.delete(input.value);
  draftStoryAdvanced.grammar = [...selected]; renderStoryGrammar();
};
$('story-character-mode').onchange = event => {
  draftStoryAdvanced ||= { grammar: [...(storyPrefs().grammar || [])], characterMode: !!storyPrefs().characterMode };
  draftStoryAdvanced.characterMode = event.target.checked;
};
$('story-advanced').ontoggle = event => {
  if (event.target.open) draftStoryAdvanced = { grammar: [...(storyPrefs().grammar || [])], characterMode: !!storyPrefs().characterMode };
  else draftStoryAdvanced = null;
  renderStoryGrammar();
};
$('story-apply').onclick = () => {
  if (storyLoading) return;
  const draft = draftStoryAdvanced || { grammar: [...(storyPrefs().grammar || [])], characterMode: !!storyPrefs().characterMode };
  storyPrefs().grammar = draft.grammar;
  storyPrefs().characterMode = draft.characterMode;
  save(); generateDailyStory();
};
$('daily-story-close').onclick = () => { storyOpen = false; renderDailyStory(); };
function renderStorySuggestions() {
  const query = $('daily-story-word').value.trim().toLowerCase();
  const box = $('daily-story-word-options');
  const dailyIds = new Set(blockIndices().map(i => String(words()[i]?.ankiId)));
  const extraIds = new Set(storyExtras());
  const matches = query ? words().filter(w => !dailyIds.has(String(w.ankiId)) && !extraIds.has(String(w.ankiId)) && `${w.hanzi} ${w.pinyin} ${w.meaning}`.toLowerCase().includes(query)).slice(0, 8) : [];
  box.innerHTML = matches.map(w => `<button type="button" class="story-suggestion" data-story-word="${escapeHtml(String(w.ankiId))}"><strong>${escapeHtml(w.hanzi)}</strong><span>${escapeHtml(w.meaning)}</span></button>`).join('');
  box.hidden = !matches.length || !storyOpen;
}
$('daily-story-word').oninput = renderStorySuggestions;
$('daily-story-word-options').onclick = event => {
  const button = event.target.closest('[data-story-word]');
  if (!button) return;
  const word = words().find(w => String(w.ankiId) === button.dataset.storyWord);
  if (word) { $('daily-story-word').value = word.hanzi; $('daily-story-word-options').hidden = true; }
};
document.addEventListener('click', event => { if (!event.target.closest('.daily-story-search')) $('daily-story-word-options').hidden = true; });
$('daily-story-add').onsubmit = event => {
  event.preventDefault();
  const value = $('daily-story-word').value.trim();
  const dailyIds = new Set(blockIndices().map(i => String(words()[i]?.ankiId)));
  const word = words().find(w => w.hanzi === value && !dailyIds.has(String(w.ankiId)) && !storyExtras().includes(String(w.ankiId)));
  if (!word) { $('daily-story-status').textContent = 'Choose an unused word from your vocabulary.'; return; }
  storyExtras().push(String(word.ankiId)); save();
  $('daily-story-word').value = '';
  renderDailyStory(); generateDailyStory();
};
$('daily-story-extra').onclick = event => {
  const button = event.target.closest('[data-story-remove]');
  if (!button || storyLoading) return;
  state.storyExtras[storyKey()] = storyExtras().filter(id => id !== button.dataset.storyRemove);
  save(); renderDailyStory(); generateDailyStory();
};

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
function similarStore() {
  state.similarWords ||= { notes: {}, hidden: {}, added: {} };
  state.similarWords.notes ||= {};
  state.similarWords.hidden ||= {};
  state.similarWords.added ||= {};
  return state.similarWords;
}
function meaningTerms(value) {
  return [...new Set(String(value || '').toLowerCase().split(/[,;/\n]|\bor\b/)
    .map(part => part.replace(/\([^)]*\)/g, '').replace(/[^a-z -]/g, ' ').trim())
    .filter(part => part.length > 2 && !/^(to|a|an|the|be|of|for|one|someone|something)$/.test(part)))];
}
function renderSimilarWords(wi) {
  const current = words()[wi];
  const box = $('w-similar');
  const own = meaningTerms(current.meaning);
  const saved = similarStore();
  const matches = words().map((word, index) => {
    if (index === wi || word.hanzi === current.hanzi) return null;
    const shared = own.filter(term => meaningTerms(word.meaning).includes(term));
    const key = [String(current.ankiId), String(word.ankiId)].sort().join('|');
    return shared.length || saved.added[key] ? { word, index, shared, key } : null;
  }).filter(Boolean).sort((a, b) => Number(b.index < wi) - Number(a.index < wi) || b.shared.length - a.shared.length);
  const visible = matches.filter(match => !saved.hidden[match.key]).slice(0, 6);
  const dismissed = matches.filter(match => saved.hidden[match.key]);
  box.innerHTML = '<div class="label">Similar words in your vocabulary</div>' + visible.map(({word, index, shared, key}) =>
    `<div class="similar-word"><button type="button" class="similar-open" data-similar-index="${index}">${escapeHtml(word.hanzi)}</button><span>${escapeHtml(word.meaning)}</span><small>${index < wi ? 'Studied earlier' : 'Coming later'}${shared.length ? ` | Shared: ${escapeHtml(shared.join(', '))}` : ' | Added by you'}</small><p class="similar-explanation" data-similar-explanation="${escapeHtml(key)}">${escapeHtml(saved.notes[key] || (hasCredentials() ? 'Loading usage difference...' : 'Add a DeepSeek key or passphrase in Settings to see the usage difference.'))}</p><button type="button" class="similar-hide" data-similar-hide="${escapeHtml(key)}" aria-label="Dismiss ${escapeHtml(word.hanzi)}">Dismiss</button></div>`).join('') + (dismissed.length ? `<details class="similar-dismissed"><summary>Dismissed suggestions (${dismissed.length})</summary>${dismissed.map(({word, key}) => `<div><span>${escapeHtml(word.hanzi)} - ${escapeHtml(word.meaning)}</span><button type="button" data-similar-restore="${escapeHtml(key)}">Restore</button></div>`).join('')}</details>` : '') + '<form id="similar-add-form" class="similar-add"><label for="similar-add-word">Suggest another word from your vocabulary</label><div class="similar-add-row"><div class="similar-search"><input id="similar-add-word" type="search" autocomplete="off" placeholder="Search Chinese word" required><div id="similar-word-options" class="daily-story-suggestions" hidden></div></div><button type="submit">Add word</button></div><span id="similar-add-status" role="status"></span></form>' ;
  if (!box.hidden && hasCredentials()) for (const match of visible) if (!saved.notes[match.key]) loadSimilarExplanation(current, match);
}
const pendingSimilar = new Set();
async function loadSimilarExplanation(current, { word, key }) {
  if (pendingSimilar.has(key)) return;
  pendingSimilar.add(key);
  try {
    const messages = [
      { role: 'system', content: 'You are a Mandarin teacher. Explain the practical usage distinction between two Chinese words in one concise English sentence. Mention when to use each word. Use the supplied meanings and examples as context. If the distinction is uncertain, say so. Return plain text only.' },
      { role: 'user', content: JSON.stringify({ first: { hanzi: current.hanzi, pinyin: current.pinyin, meaning: current.meaning, example: current.example }, second: { hanzi: word.hanzi, pinyin: word.pinyin, meaning: word.meaning, example: word.example } }) },
    ];
    const answer = state.settings.apiKey
      ? await callDeepSeek({ key: state.settings.apiKey, messages, maxTokens: 130 })
      : (await postServer('/api/similar', { passphrase: state.settings.passphrase, first: current, second: word })).content;
    const explanation = String(answer || '').trim().slice(0, 500);
    if (!explanation) throw new Error('No explanation returned.');
    similarStore().notes[key] = explanation;
    save();
    const target = [...document.querySelectorAll('[data-similar-explanation]')].find(el => el.dataset.similarExplanation === key);
    if (target) target.textContent = explanation;
  } catch {
    const target = [...document.querySelectorAll('[data-similar-explanation]')].find(el => el.dataset.similarExplanation === key);
    if (target) target.textContent = 'Could not load the usage difference. Reopen this word to retry.';
  } finally { pendingSimilar.delete(key); }
}
$('w-similar').addEventListener('click', event => {
  const hide = event.target.closest('[data-similar-hide]');
  if (hide) { similarStore().hidden[hide.dataset.similarHide] = true; save(); renderSimilarWords(blockIndices()[state.progress.wordPos]); return; }
  const restore = event.target.closest('[data-similar-restore]');
  if (restore) { delete similarStore().hidden[restore.dataset.similarRestore]; save(); renderSimilarWords(blockIndices()[state.progress.wordPos]); return; }
  const open = event.target.closest('[data-similar-index]');
  if (!open) return;
  const index = Number(open.dataset.similarIndex);
  if (index < 0 || index >= words().length) return;
  state.progress.blockStart = Math.floor(index / perDay()) * perDay();
  state.progress.wordPos = index - state.progress.blockStart;
  save(); renderStudy();
});
function renderSimilarSuggestions() {
  const input = $('similar-add-word');
  if (!input) return;
  const query = input.value.trim().toLowerCase();
  const box = $('similar-word-options');
  const current = words()[blockIndices()[state.progress.wordPos]];
  const matches = query ? words().filter(w => w.ankiId !== current.ankiId && `${w.hanzi} ${w.pinyin} ${w.meaning}`.toLowerCase().includes(query)).slice(0, 8) : [];
  box.innerHTML = matches.map(w => `<button type="button" class="story-suggestion" data-similar-word="${escapeHtml(String(w.ankiId))}"><strong>${escapeHtml(w.hanzi)}</strong><span>${escapeHtml(w.meaning)}</span></button>`).join('');
  box.hidden = !matches.length;
}
$('w-similar').addEventListener('input', event => { if (event.target.id === 'similar-add-word') renderSimilarSuggestions(); });
$('w-similar').addEventListener('click', event => {
  const button = event.target.closest('[data-similar-word]');
  if (!button) return;
  const word = words().find(w => String(w.ankiId) === button.dataset.similarWord);
  if (word) { $('similar-add-word').value = word.hanzi; $('similar-word-options').hidden = true; }
});
document.addEventListener('click', event => { if (!event.target.closest('.similar-search') && $('similar-word-options')) $('similar-word-options').hidden = true; });
$('w-similar').addEventListener('submit', event => {
  if (event.target.id !== 'similar-add-form') return;
  event.preventDefault();
  const current = words()[blockIndices()[state.progress.wordPos]];
  const value = $('similar-add-word').value.trim();
  const match = words().find(word => word.hanzi === value && word.ankiId !== current.ankiId);
  if (!match) { $('similar-add-status').textContent = 'Choose a word in your vocabulary.'; return; }
  const key = [String(current.ankiId), String(match.ankiId)].sort().join('|');
  similarStore().added[key] = true;
  delete similarStore().hidden[key];
  save(); renderSimilarWords(blockIndices()[state.progress.wordPos]);
});
$('w-meaning-toggle').onclick = () => {
  const m = $('w-meaning');
  m.hidden = !m.hidden;
  $('w-meaning-toggle').textContent = m.hidden ? 'Show meaning' : 'Hide meaning';
};
$('w-similar-toggle').onclick = () => {
  const box = $('w-similar');
  box.hidden = !box.hidden;
  $('w-similar-toggle').textContent = box.hidden ? 'Show similar words' : 'Hide similar words';
  if (!box.hidden) renderSimilarWords(blockIndices()[state.progress.wordPos]);
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
    `<div class="history-item"><div class="history-date">${new Date(h.ts).toLocaleString()}</div>${renderResult(h.result)}${renderWordGrammarResult(h)}`
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
async function runWordGrammarCheck(structure, text) {
  if (state.settings.apiKey) {
    const content = await callDeepSeek({ key: state.settings.apiKey, messages: grammarCheckMessages(structure, { mode: 'write' }, text), json: true });
    const parsed = safeJson(content);
    if (!parsed) throw new Error('The grammar check returned an unreadable answer.');
    return normalizeCheck(parsed);
  }
  const response = await postServer('/api/grammar', { passphrase: state.settings.passphrase, action: 'check', structure, task: { mode: 'write' }, text });
  const parsed = safeJson(response.content);
  if (!parsed) throw new Error('The grammar check returned an unreadable answer.');
  return normalizeCheck(parsed);
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
    const structure = wordGrammar().enabled ? selectedWordGrammar() : null;
    let grammarResult = null, grammarError = '';
    if (structure) {
      try { grammarResult = await runWordGrammarCheck(structure, text); }
      catch (error) { grammarError = error.message; }
    }
    const key = historyKey(wi);
    const entry = { text, result: data, grammarResult, grammarStructureId: structure?.id || null, grammarError, ts: Date.now(), chat: [] };
    (state.history[key] ||= []).push(entry);
    if (state.history[key].length > 30) state.history[key].shift();
    save();
    lastResult = { key, result: data, entry, word: w };
    $('status').hidden = true;
    $('result').innerHTML = renderResult(data);
    $('word-grammar-result').innerHTML = renderWordGrammarResult(entry);
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
  $('current-deck').textContent = `${words().length} words in your vocabulary`;
  $('add-hsk').disabled = !!state.settings.includeHsk;
  $('add-hsk').textContent = state.settings.includeHsk ? 'HSK 1–6 added' : 'Add 5,000 HSK 1–6 words';
  $('per-day').value = state.settings.perDay;
  $('passphrase').value = state.settings.passphrase || '';
  $('api-key').value = state.settings.apiKey || '';
  $('credential-mode').textContent = state.settings.apiKey ? 'Using your API key. Clear it and save to use the passphrase instead.' : state.settings.passphrase ? 'Using the owner passphrase.' : '';
  document.querySelector('.passphrase-box').open = !!state.settings.passphrase;
  fillStartSelect(words(), state.progress.blockStart);
  $('settings-status').textContent = '';
}
$('add-hsk').onclick = async () => {
  try {
    const response = await fetch('data/vocab.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const existing = new Set(words().map(w => String(w.ankiId)));
    const edits = JSON.parse(localStorage.getItem('hskw.vocabEdits') || '{}');
    vocabulary.push(...(await response.json()).map(w => edits[w.ankiId] || w).filter(w => !deletedVocabIds().has(w.ankiId) && !existing.has(String(w.ankiId))));
    state.settings.includeHsk = true;
    save(); renderSettings();
    $('deck-status').textContent = 'HSK vocabulary added.';
  } catch (error) { $('deck-status').textContent = error.message; }
};
function parseDeck(text, name) {
  if (name.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('JSON deck must be an array of words.');
    return data;
  }
  const separator = name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const rows = text.trim().split(/\r?\n/).map(line => line.split(separator).map(value => value.trim().replace(/^"|"$/g, '')));
  const header = rows[0].map(value => value.toLowerCase());
  const wordColumn = header.findIndex(value => ['hanzi', 'word', 'vocab'].includes(value));
  const meaningColumn = header.findIndex(value => ['meaning', 'translation', 'definition'].includes(value));
  if (wordColumn < 0 || meaningColumn < 0) throw new Error('Deck needs word/hanzi and meaning/translation columns.');
  return rows.slice(1).map(row => Object.fromEntries(header.map((key, index) => [key, row[index] || '']))).map(row => ({ ...row, hanzi: row.hanzi || row.word || row.vocab, meaning: row.meaning || row.translation || row.definition }));
}
let pendingAnkiRows = null;
const ankiFields = [['hanzi', 'Word'], ['meaning', 'Translation'], ['traditional', 'Traditional'], ['pinyin', 'Pinyin'], ['partOfSpeech', 'Part of speech'], ['example', 'Example'], ['examplePinyin', 'Example pinyin'], ['exampleTranslation', 'Example translation']];
function showAnkiMapping(rows, names = []) {
  pendingAnkiRows = rows;
  const width = Math.max(...rows.map(row => row.length));
  const options = Array.from({ length: width }, (_, i) => `<option value="${i}">${escapeHtml(names[i] || `Field ${i + 1}`)}: ${escapeHtml(rows.find(row => row[i])?.[i]?.slice(0, 60) || '')}</option>`).join('');
  $('deck-mapping-fields').innerHTML = ankiFields.map(([key, label], index) => `<label>${label}<select data-anki-field="${key}"><option value="">Skip</option>${options}</select></label>`).join('');
  const selects = $('deck-mapping-fields').querySelectorAll('select');
  const suggestedWord = names.findIndex(name => /hanzi|simplified|chinese|word/i.test(name));
  selects[0].value = String(suggestedWord >= 0 ? suggestedWord : 0);
  selects[1].value = String(width > 1 ? (Number(selects[0].value) === 0 ? 1 : 0) : '');
  $('deck-mapping').hidden = false;
  $('deck-mapping').scrollIntoView({ behavior: 'smooth' });
}
$('confirm-deck-import').onclick = () => {
  try {
    const mapping = Object.fromEntries([...$('deck-mapping-fields').querySelectorAll('select')].map(select => [select.dataset.ankiField, select.value]));
    if (mapping.hanzi === '' || mapping.meaning === '') throw new Error('Select word and translation fields.');
    const entries = pendingAnkiRows.map(row => Object.fromEntries(ankiFields.map(([key]) => [key, mapping[key] === '' ? '' : row[Number(mapping[key])] || '']))).filter(word => word.hanzi && word.meaning);
    if (!entries.length) throw new Error('No notes have both selected fields.');
    addDeckEntries(entries, $('deck-origin').value.trim());
    $('deck-mapping').hidden = true;
    pendingAnkiRows = null;
  } catch (error) { $('deck-mapping-status').textContent = error.message; }
};
function addDeckEntries(entries, origin) {
  if (!origin) throw new Error('Enter a category name first.');
  if (!entries.length || entries.some(w => !w || !String(w.hanzi || '').trim() || !String(w.meaning || '').trim())) throw new Error('Every word needs a word and translation.');
  const used = new Set(words().map(w => String(w.ankiId)));
  const base = origin.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
  let slug = base;
  let suffix = 2;
  while (words().some(word => word.origin !== origin && String(word.ankiId).startsWith(`${slug}-`))) slug = `${base}-${suffix++}`;
  const prefix = `${slug}-`;
  let nextPosition = Math.max(0, ...[...used].filter(id => id.startsWith(prefix)).map(id => Number(id.slice(prefix.length))).filter(Number.isInteger)) + 1;
  const added = entries.map((word, index) => {
    let ankiId = `${prefix}${nextPosition++}`;
    while (used.has(ankiId)) ankiId = `${prefix}${nextPosition++}`;
    used.add(ankiId);
    return { ...word, ankiId, hanzi: String(word.hanzi).trim(), meaning: String(word.meaning).trim(), origin, dateAdded: today() };
  });
  storeLocalVocab([...localVocab(), ...added]);
  vocabulary.push(...added);
  renderSettings();
  $('deck-status').textContent = `Added ${added.length} words to ${origin}.`;
}
$('deck-file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const origin = $('deck-origin').value.trim();
    if (!origin) throw new Error('Enter a category name first.');
    let entries;
    if (file.name.toLowerCase().endsWith('.apkg')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const response = await fetch('/api/anki-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: btoa(binary) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not import Anki package.');
      showAnkiMapping(result.rows, result.names);
      return;
    } else entries = parseDeck(await file.text(), file.name);
    addDeckEntries(entries, origin);
  } catch (error) { $('deck-status').textContent = error.message; }
  event.target.value = '';
};
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
  if (localVocab().some(w => w.ankiId === old.ankiId)) {
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
  if (!selection || selection.isCollapsed) { hideSelectionAction(); return; }
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
let selectionDrag = false;
document.addEventListener('mousedown', event => { selectionDrag = event.button === 0; });
document.addEventListener('mouseup', () => { if (selectionDrag) setTimeout(updateSelectionAction, 0); selectionDrag = false; });
document.addEventListener('keyup', event => {
  if (event.key === 'Escape') hideSelectionAction();
  else if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) updateSelectionAction();
});
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
    const entry = { ...data, ankiId: `user-${crypto.randomUUID()}`, noteId: '', origin: 'Personal', dateAdded: today() };
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
    vocabulary = [...(state.settings.includeHsk ? (await response.json()).map(w => edits[w.ankiId] || w) : []), ...localVocab()].filter(w => !deletedVocabIds().has(w.ankiId));
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
