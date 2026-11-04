// Grammar section: drills for connectors and sentence patterns.
import { escapeHtml } from './highlight.js';
import { safeJson, normalizeCheck } from './prompts.js';
import { renderResult, msgHtml } from './render.js';
import { GROUPS, STRUCTURES, SEED_ITEMS, WRITE_CONSTRAINTS } from './grammar-data.js';
import { grammarCheckMessages, grammarChatMessages, generateMessages, normalizeGenerated, splitOption, checkContext } from './grammar-prompts.js';

const $ = (id) => document.getElementById(id);
const BY_ID = Object.fromEntries(STRUCTURES.map(s => [s.id, s]));
const SEED = SEED_ITEMS.map((it, i) => ({ ...it, id: `seed-${i}` }));
const DAY = 86400000;
const INTERVALS = [0, 1, 2, 4, 8, 16]; // days, by box
const LABELS = { target_word: 'Structure', notUsed: 'Structure not used' };
const MODES = [
  ['mix', '混合', 'Mix'],
  ['choice', '选择', 'Fill in'],
  ['judge', '判断', 'Spot it'],
  ['order', '排序', 'Order'],
  ['translate', '翻译', 'Translate'],
  ['write', '造句', 'Write'],
  ['ref', '语法表', 'Structures'],
];
const MODE_TYPES = { mix: ['choice', 'judge', 'order'], choice: ['choice'], judge: ['judge'], order: ['order'] };

const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- pinyin (loaded on first use) ----------
let pinyinFn = null, pinyinLoading = null;
function loadPinyin() {
  if (pinyinFn) return Promise.resolve(pinyinFn);
  pinyinLoading ||= import('./vendor/pinyin-pro.js').then(m => (pinyinFn = m.pinyin)).catch(() => null);
  return pinyinLoading;
}
const PUNCT = { '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',', '“': '“', '”': '”' };
function toPinyin(s) {
  if (!pinyinFn) return '';
  return pinyinFn(s, { toneSandhi: true })
    .replace(/\s*([，。！？；：、“”])\s*/g, (_, p) => (p === '“' ? ' “' : PUNCT[p] + ' '))
    .replace(/\s+/g, ' ').trim();
}
// Fill elements marked data-py="<chinese>" with pinyin once the library is loaded.
function fillPinyin(root) {
  loadPinyin().then(() => {
    root.querySelectorAll('[data-py]').forEach(el => { el.textContent = toPinyin(el.dataset.py); });
  });
}
const pyLine = (zh) => `<div class="g-py" data-py="${escapeHtml(zh)}"></div>`;

// ---------- items ----------
function fillChoice(item, opt) {
  const parts = splitOption(opt);
  let k = 0;
  return item.q.replace(/__/g, () => parts[k++] ?? '');
}
function fillChoiceHtml(item, opt, cls) {
  const parts = splitOption(opt);
  let k = 0;
  return escapeHtml(item.q).replace(/__/g, () => `<span class="${cls}">${escapeHtml(parts[k++] ?? '')}</span>`);
}
const orderSentence = (item) => item.parts.join('，') + '。';
function correctSentence(item) {
  if (item.t === 'choice') return fillChoice(item, item.o[0]);
  if (item.t === 'judge') return item.o[0];
  if (item.t === 'order') return orderSentence(item);
  if (item.t === 'translate') return item.ref;
  return '';
}

export function initGrammar({ getState, save, hasCredentials, callModel, goSettings }) {
  const G = () => {
    const st = getState();
    st.grammar ||= {};
    const g = st.grammar;
    g.active ||= {}; g.stats ||= {}; g.generated ||= []; g.seen ||= {}; g.log ||= []; g.prefs ||= {};
    return g;
  };
  const prefs = () => G().prefs;
  const mode = () => prefs().mode || 'mix';
  const scope = () => prefs().scope || 'all';
  const isActive = (id) => G().active[id] !== false;

  const session = { right: 0, total: 0, seenItems: new Set(), lastStructure: null };
  let current = null; // { item?, structure, mode, answered, correct, chat:[], task?, entry? }

  const allItems = () => [...SEED, ...G().generated];

  // Translation tasks come from dedicated items and from every item with an English translation.
  function translateTasks() {
    const out = [];
    for (const it of allItems()) {
      if (it.t === 'translate') out.push({ id: it.id, s: it.s, en: it.en, ref: it.ref, w: it.w, gen: it.gen });
      else if (it.en) out.push({ id: it.id + '-tr', s: it.s, en: it.en, ref: correctSentence(it), gen: it.gen });
    }
    return out;
  }

  function scopeStructures() {
    const sc = scope();
    if (BY_ID[sc]) return [BY_ID[sc]];
    let list = STRUCTURES.filter(s => isActive(s.id));
    if (sc.startsWith('group:')) list = list.filter(s => s.g === sc.slice(6));
    if (sc === 'due') {
      const now = Date.now();
      const due = list.filter(s => (G().stats[s.id]?.due || 0) <= now && G().stats[s.id]);
      if (due.length) list = due;
    }
    return list;
  }

  function candidatesFor(m) {
    const ids = new Set(scopeStructures().map(s => s.id));
    if (m === 'write') return null;
    const pool = m === 'translate' ? translateTasks() : allItems().filter(it => MODE_TYPES[m].includes(it.t));
    const by = {};
    for (const it of pool) if (ids.has(it.s)) (by[it.s] ||= []).push(it);
    return by;
  }

  function chooseStructure(ids) {
    const now = Date.now();
    const scored = ids.map(id => {
      const st = G().stats[id];
      const unseen = !st;
      const due = st ? st.due <= now : true;
      return { id, k: [due ? 0 : 1, unseen ? 0.5 : st.box, Math.random()] };
    });
    scored.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
    // a little randomness among the top few, and avoid the same structure twice in a row
    const top = scored.slice(0, Math.min(4, scored.length)).filter(x => x.id !== session.lastStructure);
    return (top.length ? pick(top) : scored[0]).id;
  }

  function chooseItem(list) {
    const seen = G().seen;
    const fresh = list.filter(it => !session.seenItems.has(it.id));
    const pool = fresh.length ? fresh : list;
    const minTs = Math.min(...pool.map(it => seen[it.id] || 0));
    return pick(pool.filter(it => (seen[it.id] || 0) <= minTs + 60000));
  }

  function nextQuestion() {
    const m = mode();
    if (m === 'ref') return;
    if (m === 'write') {
      const list = scopeStructures();
      if (!list.length) { current = null; return; }
      const s = BY_ID[chooseStructure(list.map(x => x.id))];
      current = { mode: 'write', structure: s, task: { mode: 'write', meaning: pick(s.m), constraint: pick(WRITE_CONSTRAINTS) }, chat: [] };
    } else {
      const by = candidatesFor(m);
      const ids = Object.keys(by);
      if (!ids.length) { current = null; return; }
      const sid = chooseStructure(ids);
      const item = chooseItem(by[sid]);
      const q = { mode: m === 'mix' ? item.t : m, structure: BY_ID[sid], item, chat: [] };
      if (item.o) q.order = shuffle(item.o.map((_, i) => i));
      if (item.t === 'order') {
        let perm;
        do { perm = shuffle([0, 1, 2]); } while (perm.join() === '0,1,2');
        q.tiles = perm; q.placed = [];
      }
      if (q.mode === 'translate') q.task = { mode: 'translate', en: item.en, ref: item.ref };
      current = q;
    }
    session.lastStructure = current.structure.id;
    if (current.item) session.seenItems.add(current.item.id);
  }

  function record(sid, ok) {
    const g = G();
    const st = g.stats[sid] ||= { box: 0, due: 0, n: 0, ok: 0 };
    st.n++;
    if (ok) { st.ok++; st.box = Math.min(st.box + 1, 5); st.due = Date.now() + INTERVALS[st.box] * DAY; }
    else { st.box = 0; st.due = Date.now() + 10 * 60000; }
    st.last = Date.now();
    if (current?.item) g.seen[current.item.id] = Date.now();
    session.total++; if (ok) session.right++;
    save();
  }

  // ---------- rendering ----------
  function render() {
    renderToolbar();
    const m = mode();
    $('g-ref').hidden = m !== 'ref';
    $('g-practice').hidden = m === 'ref';
    if (m === 'ref') { renderRef(); return; }
    if (!current) nextQuestion();
    renderQuestion();
  }

  function renderToolbar() {
    $('g-modes').innerHTML = MODES.map(([k, zh, en]) =>
      `<button type="button" class="g-mode${mode() === k ? ' active' : ''}" data-mode="${k}"><span class="zh">${zh}</span><span class="en">${en}</span></button>`).join('');
    const sel = $('g-scope');
    const activeCount = STRUCTURES.filter(s => isActive(s.id)).length;
    const now = Date.now();
    const dueCount = STRUCTURES.filter(s => isActive(s.id) && G().stats[s.id] && G().stats[s.id].due <= now).length;
    let html = `<option value="all">All my structures (${activeCount})</option><option value="due">Due for review (${dueCount})</option><optgroup label="By group">`;
    html += Object.entries(GROUPS).map(([k, v]) => `<option value="group:${k}">${escapeHtml(v)}</option>`).join('') + '</optgroup>';
    for (const [k, v] of Object.entries(GROUPS)) {
      html += `<optgroup label="${escapeHtml(v)}">` + STRUCTURES.filter(s => s.g === k).map(s => `<option value="${s.id}">${escapeHtml(s.p)}</option>`).join('') + '</optgroup>';
    }
    sel.innerHTML = html;
    sel.value = scope();
    $('g-score').textContent = session.total ? `This session: ${session.right}/${session.total} correct` : '';
    const genOk = ['mix', 'choice', 'judge', 'order', 'translate'].includes(mode());
    $('g-generate').hidden = !genOk;
    $('g-scope-row').hidden = false;
  }

  function hideStructure() {
    // Don't give away the answer: show the target structure only when the scope already names it.
    return !BY_ID[scope()];
  }

  function structureTag(s) {
    return `<button type="button" class="g-stag" data-ref="${s.id}" title="Open in the structure list">${escapeHtml(s.p)}</button>`;
  }

  function renderQuestion() {
    const box = $('g-stage');
    $('g-feedback').innerHTML = '';
    $('g-chat').hidden = true;
    if (!current) {
      box.innerHTML = `<div class="empty">No questions match this selection. ${mode() === 'write' ? '' : 'Pick another scope, or press “Generate new questions”.'}</div>`;
      return;
    }
    const q = current;
    const head = (label) => `<div class="g-qhead"><span class="g-qtype">${label}</span>${hideStructure() ? '' : structureTag(q.structure)}${q.item?.gen ? '<span class="g-gen" title="Written by DeepSeek">AI</span>' : ''}</div>`;
    let html = '';
    if (q.mode === 'choice') {
      const blanks = (q.item.q.match(/__/g) || []).length;
      let n = 0;
      const sent = escapeHtml(q.item.q).replace(/__/g, () => `<span class="g-blank">${blanks > 1 ? ++n : ''}</span>`);
      html += head(blanks > 1 ? 'Fill both blanks' : 'Fill the blank');
      html += `<div class="g-sentence">${sent}</div><div class="g-opts">`;
      q.order.forEach((oi, k) => {
        const parts = splitOption(q.item.o[oi]);
        html += `<button type="button" class="g-opt" data-k="${k}"><span class="g-key">${'ABCDE'[k]}</span><span class="g-opt-text">${parts.map(escapeHtml).join('<span class="g-sep">……</span>')}</span></button>`;
      });
      html += '</div>';
    } else if (q.mode === 'judge') {
      html += head(escapeHtml(q.item.p || 'Which sentence is correct?'));
      html += '<div class="g-opts g-opts-col">';
      q.order.forEach((oi, k) => {
        html += `<button type="button" class="g-opt g-opt-sent" data-k="${k}"><span class="g-key">${'ABCDE'[k]}</span><span class="g-opt-text">${escapeHtml(q.item.o[oi])}</span></button>`;
      });
      html += '</div>';
    } else if (q.mode === 'order') {
      html += head('Put the clauses in order');
      html += `<div class="g-order-line" id="g-order-line">${q.placed.map((ti, k) => `<button type="button" class="g-tile placed" data-placed="${k}"><span class="g-key">${'ABC'[ti]}</span>${escapeHtml(q.item.parts[q.tiles[ti]])}</button>`).join('') || '<span class="g-order-hint">Tap the clauses below in the right order</span>'}</div>`;
      html += '<div class="g-tiles">';
      q.tiles.forEach((pi, ti) => {
        const used = q.placed.includes(ti);
        html += `<button type="button" class="g-tile${used ? ' used' : ''}" data-tile="${ti}" ${used ? 'disabled' : ''}><span class="g-key">${'ABC'[ti]}</span>${escapeHtml(q.item.parts[pi])}</button>`;
      });
      html += '</div>';
      html += `<div class="composer-actions"><button class="ghost" id="g-order-reset" type="button">Reset</button><button class="primary" id="g-order-check" type="button" ${q.placed.length === 3 ? '' : 'disabled'}>Check</button></div>`;
    } else if (q.mode === 'translate') {
      html += head('Translate into Chinese');
      html += `<div class="g-en">${escapeHtml(q.task.en)}</div>`;
      if (hideStructure()) html += `<button type="button" class="meaning-toggle" id="g-hint">Show which structure to use</button><div id="g-hint-box" hidden>${structureTag(q.structure)}</div>`;
      html += composer('翻译成中文……');
    } else if (q.mode === 'write') {
      const s = q.structure;
      html += `<div class="g-write-card"><div class="g-write-p">${escapeHtml(s.p)}</div><div class="g-write-py">${escapeHtml(s.py)}</div>`;
      html += `<div class="g-write-task"><div><span class="label">Meaning</span>${escapeHtml(q.task.meaning)}</div><div><span class="label">Constraint</span>${escapeHtml(q.task.constraint)}</div>
        <div class="g-swap"><button class="linkbtn" id="g-new-constraint" type="button">Different constraint</button><button class="linkbtn" id="g-skip" type="button">Different structure</button></div></div>`;
      html += `<details class="g-note"><summary>Usage note</summary><p>${escapeHtml(s.note)}</p>${s.m.length > 1 ? `<p class="muted small">All meanings: ${s.m.map(escapeHtml).join(' · ')}</p>` : ''}</details></div>`;
      html += composer(`用「${s.p}」造一两个句子……`);
    }
    box.innerHTML = html;

    if (q.mode === 'translate' || q.mode === 'write') {
      const ta = $('g-input');
      const key = 'hskw.gdraft.' + q.mode + '.' + (q.item?.id || q.structure.id);
      try { ta.value = sessionStorage.getItem(key) || ''; } catch {}
      ta.oninput = () => { try { sessionStorage.setItem(key, ta.value); } catch {} };
      ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); checkWriting(); } };
      $('g-check').onclick = checkWriting;
      if (q.entry) showWritingResult();
    }
    if (q.answered) showAnswer();
  }

  function composer(ph) {
    return `<div class="composer"><textarea id="g-input" rows="3" spellcheck="false" placeholder="${escapeHtml(ph)}"></textarea>
      <div class="composer-actions"><span class="hint">Ctrl/⌘ + Enter to check</span><button class="primary" id="g-check" type="button">Check</button></div>
      <div class="status" id="g-status" hidden></div></div>`;
  }

  // ---------- answering multiple-choice, judge, order ----------
  function answerOption(k) {
    const q = current;
    if (!q || q.answered || !q.order) return;
    q.picked = q.order[k];
    q.answered = true;
    q.correct = q.picked === 0;
    record(q.structure.id, q.correct);
    renderToolbar();
    showAnswer();
  }

  function showAnswer() {
    const q = current;
    const box = $('g-stage');
    if (q.order) {
      box.querySelectorAll('.g-opt').forEach(b => {
        const oi = q.order[+b.dataset.k];
        b.disabled = true;
        if (oi === 0) b.classList.add('right');
        else if (oi === q.picked) b.classList.add('wrong');
        else b.classList.add('dim');
      });
    }
    if (q.mode === 'order') {
      box.querySelectorAll('.g-tile').forEach(b => { b.disabled = true; });
      $('g-order-check')?.remove(); $('g-order-reset')?.remove();
      $('g-order-line')?.classList.add(q.correct ? 'right' : 'wrong');
    }
    const full = correctSentence(q.item);
    let html = `<div class="g-verdict ${q.correct ? 'ok' : 'bad'}">${q.correct ? '正确' : '不对'}<span>${q.correct ? 'Correct' : 'Not quite'}</span></div>`;
    html += '<div class="g-answer">';
    if (q.mode === 'choice') html += `<div class="g-full">${fillChoiceHtml(q.item, q.item.o[0], 'g-fill')}</div>`;
    else html += `<div class="g-full">${escapeHtml(full)}</div>`;
    html += pyLine(full);
    if (q.item.en) html += `<div class="g-tr">${escapeHtml(q.item.en)}</div>`;
    if (q.mode === 'choice' && !q.correct && q.picked != null) {
      html += `<div class="g-yours"><span class="label">Your choice</span>${fillChoiceHtml(q.item, q.item.o[q.picked], 'g-fill-bad')}</div>`;
    }
    if (q.mode === 'order' && !q.correct) {
      html += `<div class="g-yours"><span class="label">Your order</span>${escapeHtml(q.placed.map(ti => q.item.parts[q.tiles[ti]]).join('，') + '。')}</div>`;
    }
    if (q.item.w) html += `<div class="g-why">${escapeHtml(q.item.w)}</div>`;
    html += `<div class="g-meta">${structureTag(q.structure)}<span class="muted small">${escapeHtml(q.structure.m.join(' · '))}</span></div>`;
    html += '</div>';
    html += nextRow(q.item.gen);
    $('g-feedback').innerHTML = html;
    fillPinyin($('g-feedback'));
    bindNext();
    showChat();
  }

  function nextRow(gen) {
    return `<div class="g-next-row">${gen ? '<button class="ghost" id="g-report" type="button" title="Remove this AI-written question from your bank">Bad question? Remove it</button>' : '<span></span>'}<button class="primary" id="g-next" type="button">Next →</button></div>`;
  }
  function bindNext() {
    $('g-next').onclick = goNext;
    const rep = $('g-report');
    if (rep) rep.onclick = () => {
      const id = current.item?.id?.replace(/-tr$/, '');
      const g = G();
      g.generated = g.generated.filter(it => it.id !== id);
      save();
      rep.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'Removed.' }));
    };
  }
  function goNext() {
    nextQuestion();
    renderQuestion();
    $('g-stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- order tiles ----------
  function placeTile(ti) {
    const q = current;
    if (q.answered || q.placed.includes(ti)) return;
    q.placed.push(ti);
    renderQuestion();
  }
  function unplace(k) {
    const q = current;
    if (q.answered) return;
    q.placed.splice(k, 1);
    renderQuestion();
  }
  function checkOrder() {
    const q = current;
    if (q.placed.length !== 3 || q.answered) return;
    q.answered = true;
    q.correct = q.placed.map(ti => q.tiles[ti]).join() === '0,1,2';
    record(q.structure.id, q.correct);
    renderToolbar();
    showAnswer();
  }

  // ---------- writing and translation (checked by DeepSeek) ----------
  async function checkWriting() {
    const q = current;
    const text = $('g-input').value.trim();
    if (!text) return;
    const st = $('g-status');
    if (!hasCredentials()) {
      st.hidden = false; st.className = 'status error';
      st.innerHTML = 'Add your DeepSeek API key in Settings first. <button class="ghost" type="button" id="g-go-settings">Open Settings</button>';
      $('g-go-settings').onclick = goSettings;
      return;
    }
    const btn = $('g-check');
    btn.disabled = true;
    st.hidden = false; st.className = 'status'; st.innerHTML = '<span class="spinner"></span>Checking…';
    try {
      const s = q.structure;
      const structure = { id: s.id, p: s.p, py: s.py, m: s.m, note: s.note };
      const content = await callModel({
        action: 'check', payload: { structure, task: q.task, text },
        messages: grammarCheckMessages(structure, q.task, text), json: true,
      });
      const parsed = safeJson(content);
      if (!parsed) throw new Error('The model returned an unreadable answer. Try again.');
      const result = normalizeCheck(parsed);
      const ok = result.sentences.length > 0
        && result.sentences.some(x => x.target_word_used)
        && result.sentences.every(x => !x.errors.some(e => e.type === 'target_word' || (e.type === 'grammar' && /^meaning:/i.test(e.explanation))));
      const entry = { ts: Date.now(), s: s.id, mode: q.mode, task: q.task, text, result, ok, chat: [] };
      const g = G();
      g.log.push(entry);
      if (g.log.length > 150) g.log.shift();
      if (!q.entry) record(s.id, ok); // only the first attempt counts for scheduling
      q.entry = entry;
      q.chat = entry.chat;
      save();
      renderToolbar();
      st.hidden = true;
      showWritingResult();
    } catch (e) {
      st.hidden = false; st.className = 'status error'; st.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  }

  function showWritingResult() {
    const q = current;
    const e = q.entry;
    let html = `<div class="g-verdict ${e.ok ? 'ok' : 'bad'}">${e.ok ? '用对了' : '再试试'}<span>${e.ok ? 'Structure used correctly' : 'Structure needs work'}</span></div>`;
    html += renderResult(e.result, LABELS);
    if (q.mode === 'translate' && q.task.ref) {
      html += `<div class="g-answer"><span class="label">Reference translation</span><div class="g-full">${escapeHtml(q.task.ref)}</div>${pyLine(q.task.ref)}`;
      html += `<div class="g-meta">${structureTag(q.structure)}<span class="muted small">${escapeHtml(q.structure.m.join(' · '))}</span></div></div>`;
    }
    html += `<p class="muted small">You can edit your sentences and check again; only the first check counts for review scheduling.</p>`;
    html += nextRow(q.item?.gen);
    $('g-feedback').innerHTML = html;
    fillPinyin($('g-feedback'));
    bindNext();
    showChat();
  }

  // ---------- follow-up chat ----------
  function chatContext() {
    const q = current;
    if (q.entry) return checkContext(q.task, q.entry.text, q.entry.result);
    const it = q.item;
    const lines = [];
    if (it.t === 'choice') {
      lines.push(`Fill-in-the-blank: ${it.q}`, `Options: ${q.order.map((oi, k) => `${'ABCDE'[k]}) ${it.o[oi]}`).join('  ')}`,
        `Correct: ${it.o[0]} → ${correctSentence(it)}`, `Learner chose: ${it.o[q.picked]}${q.correct ? ' (correct)' : ` → ${fillChoice(it, it.o[q.picked])}`}`);
    } else if (it.t === 'judge') {
      lines.push(`Question: ${it.p || 'Which sentence is correct?'}`, ...q.order.map((oi, k) => `${'ABCDE'[k]}) ${it.o[oi]}`),
        `Correct: ${it.o[0]}`, `Learner chose: ${it.o[q.picked]}${q.correct ? ' (correct)' : ''}`);
    } else if (it.t === 'order') {
      lines.push(`Ordering task. Correct sentence: ${orderSentence(it)}`, `Learner's order: ${q.placed.map(ti => it.parts[q.tiles[ti]]).join('，')}${q.correct ? ' (correct)' : ''}`);
    }
    if (it.en) lines.push(`Translation: ${it.en}`);
    if (it.w) lines.push(`Explanation shown: ${it.w}`);
    return lines.join('\n');
  }

  function showChat() {
    $('g-chat').hidden = false;
    $('g-chat-log').innerHTML = (current.chat || []).map(msgHtml).join('');
    $('g-chat-status').hidden = true;
  }

  async function sendChat() {
    const q = current;
    if (!q) return;
    const input = $('g-chat-input');
    const text = input.value.trim();
    if (!text) return;
    const st = $('g-chat-status');
    if (!hasCredentials()) { st.hidden = false; st.className = 'status error'; st.textContent = 'Add your DeepSeek API key in Settings first.'; return; }
    q.chat ||= [];
    q.chat.push({ role: 'user', content: text });
    input.value = '';
    showChat();
    const btn = $('g-chat-send');
    btn.disabled = true;
    st.hidden = false; st.className = 'status'; st.innerHTML = '<span class="spinner"></span>Thinking…';
    try {
      const s = q.structure;
      const structure = { id: s.id, p: s.p, py: s.py, m: s.m, note: s.note };
      const context = chatContext();
      const reply = await callModel({
        action: 'chat', payload: { structure, context, messages: q.chat },
        messages: grammarChatMessages(structure, context, q.chat), temperature: 0.4, maxTokens: 1500,
      });
      q.chat.push({ role: 'assistant', content: reply.trim() });
      if (q.entry) save();
      showChat();
    } catch (e) {
      q.chat.pop();
      input.value = text;
      showChat();
      st.hidden = false; st.className = 'status error'; st.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- generating new questions ----------
  async function generate() {
    const st = $('g-gen-status');
    st.hidden = false;
    if (!hasCredentials()) { st.className = 'status error'; st.textContent = 'Add your DeepSeek API key in Settings first.'; return; }
    const m = mode();
    const types = m === 'translate' ? ['translate'] : MODE_TYPES[m] || ['choice', 'judge', 'order'];
    // Target the selected structure, or the weakest few in scope.
    let targets = scopeStructures();
    if (targets.length > 4) {
      const stats = G().stats;
      targets = targets.map(s => ({ s, k: (stats[s.id]?.box ?? 0) + (stats[s.id] ? 0 : 0.5) + Math.random() * 1.5 }))
        .sort((a, b) => a.k - b.k).slice(0, 4).map(x => x.s);
    }
    const confusables = Object.fromEntries(STRUCTURES.map(s => [s.id, s.p]));
    const avoid = allItems().filter(it => targets.some(t => t.id === it.s)).map(correctSentence).filter(Boolean);
    const structures = targets.map(s => ({ id: s.id, p: s.p, py: s.py, m: s.m, note: s.note, cf: s.cf }));
    const count = 8;
    const btn = $('g-generate');
    btn.disabled = true;
    st.className = 'status'; st.innerHTML = `<span class="spinner"></span>Writing ${count} questions on ${targets.map(t => escapeHtml(t.p)).join(', ')}…`;
    try {
      const content = await callModel({
        action: 'generate', payload: { structures, types, count, confusables, avoid },
        messages: generateMessages(structures, types, count, confusables, avoid), json: true, temperature: 0.8, maxTokens: 4000,
      });
      const parsed = safeJson(content);
      if (!parsed) throw new Error('The model returned an unreadable answer. Try again.');
      const items = normalizeGenerated(parsed, STRUCTURES.map(s => s.id));
      if (!items.length) throw new Error('None of the generated questions passed the format checks. Try again.');
      const g = G();
      const ts = Date.now();
      items.forEach((it, i) => { it.id = `g-${ts}-${i}`; it.gen = true; });
      g.generated.push(...items);
      if (g.generated.length > 800) g.generated.splice(0, g.generated.length - 800);
      save();
      st.textContent = `Added ${items.length} new question${items.length > 1 ? 's' : ''} (marked “AI”) to the rotation.`;
      if (!current || current.answered || current.entry) { nextQuestion(); renderQuestion(); }
    } catch (e) {
      st.className = 'status error'; st.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- reference list ----------
  function boxMeter(id) {
    const st = G().stats[id];
    const b = st?.box ?? 0;
    return `<span class="g-meter" title="${st ? `Level ${b}/5 · ${st.ok}/${st.n} correct` : 'Not practised yet'}">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= b ? 'on' : ''}"></i>`).join('')}</span>`;
  }

  function renderRef() {
    const box = $('g-ref');
    const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.dataset.id));
    let html = `<p class="muted">Untick structures you haven’t learned yet; they’ll still appear as wrong options, which is part of the point. ⁵ marks structures that are more typical of HSK 5.</p>
      <div class="row g-ref-actions"><button class="ghost" type="button" id="g-all-on">Select all</button><button class="ghost" type="button" id="g-all-off">Select none</button></div>`;
    for (const [gk, gname] of Object.entries(GROUPS)) {
      html += `<h3 class="g-group">${escapeHtml(gname)}</h3>`;
      for (const s of STRUCTURES.filter(x => x.g === gk)) {
        const items = allItems().filter(it => it.s === s.id && it.t !== 'translate');
        const examples = [...new Set(items.map(correctSentence))].slice(0, 4);
        const writes = G().log.filter(e => e.s === s.id).slice(-4).reverse();
        html += `<details class="g-ref-item" data-id="${s.id}" ${open.has(s.id) ? 'open' : ''}>
          <summary><input type="checkbox" class="g-active" data-id="${s.id}" ${isActive(s.id) ? 'checked' : ''} title="Include in practice">
          <span class="g-ref-p">${escapeHtml(s.p)}${s.lvl >= 5 ? '<sup>⁵</sup>' : ''}</span><span class="g-ref-m">${escapeHtml(s.m[0])}</span>${boxMeter(s.id)}</summary>
          <div class="g-ref-body">
            <div class="g-ref-py">${escapeHtml(s.py)}</div>
            <div>${s.m.map((x, i) => `<div>${s.m.length > 1 ? `(${i + 1}) ` : ''}${escapeHtml(x)}</div>`).join('')}</div>
            <p class="g-ref-note">${escapeHtml(s.note)}</p>
            ${s.cf.length ? `<div class="g-ref-cf"><span class="label">Don’t confuse with</span>${s.cf.map(id => structureTag(BY_ID[id])).join(' ')}</div>` : ''}
            ${examples.length ? `<div class="label">Examples</div>${examples.map(e => `<div class="g-ex"><div class="g-ex-zh">${escapeHtml(e)}</div>${open.has(s.id) ? `<div class="g-py" data-py="${escapeHtml(e)}"></div>` : `<div class="g-py" data-py-lazy="${escapeHtml(e)}"></div>`}</div>`).join('')}` : ''}
            ${writes.length ? `<div class="label">Your recent sentences</div>${writes.map(e => `<div class="g-ex"><span class="badge ${e.ok ? 'ok' : 'bad'}">${e.ok ? '✓' : '✗'}</span> ${escapeHtml(e.text)}</div>`).join('')}` : ''}
            <div class="row g-ref-btns"><button class="primary" type="button" data-practise="${s.id}">Practise</button><button class="ghost" type="button" data-write="${s.id}">Write sentences</button></div>
          </div></details>`;
      }
    }
    box.innerHTML = html;
    fillPinyin(box);
  }

  function openRef(id) {
    prefs().mode = 'ref';
    save();
    render();
    const d = document.querySelector(`.g-ref-item[data-id="${id}"]`);
    if (d) {
      d.open = true;
      d.querySelectorAll('[data-py-lazy]').forEach(el => { el.dataset.py = el.dataset.pyLazy; });
      fillPinyin(d);
      d.scrollIntoView({ behavior: 'smooth', block: 'center' });
      d.classList.add('flash-row'); setTimeout(() => d.classList.remove('flash-row'), 1200);
    }
  }

  // ---------- events ----------
  const view = $('view-grammar');
  view.addEventListener('click', (e) => {
    const t = e.target;
    const modeBtn = t.closest('.g-mode');
    if (modeBtn) {
      prefs().mode = modeBtn.dataset.mode; save();
      current = null;
      render();
      return;
    }
    const opt = t.closest('.g-opt');
    if (opt && !opt.disabled) return answerOption(+opt.dataset.k);
    const tile = t.closest('.g-tile[data-tile]');
    if (tile) return placeTile(+tile.dataset.tile);
    const placed = t.closest('.g-tile[data-placed]');
    if (placed) return unplace(+placed.dataset.placed);
    if (t.closest('#g-order-check')) return checkOrder();
    if (t.closest('#g-order-reset')) { current.placed = []; return renderQuestion(); }
    if (t.closest('#g-hint')) { $('g-hint-box').hidden = false; t.closest('#g-hint').remove(); return; }
    if (t.closest('#g-skip')) return goNext();
    if (t.closest('#g-new-constraint')) {
      current.task.constraint = pick(WRITE_CONSTRAINTS.filter(c => c !== current.task.constraint));
      current.task.meaning = pick(current.structure.m);
      return renderQuestion();
    }
    const stag = t.closest('.g-stag');
    if (stag) { e.preventDefault(); return openRef(stag.dataset.ref); }
    const pr = t.closest('[data-practise]');
    if (pr) { prefs().scope = pr.dataset.practise; prefs().mode = 'mix'; save(); current = null; return render(); }
    const wr = t.closest('[data-write]');
    if (wr) { prefs().scope = wr.dataset.write; prefs().mode = 'write'; save(); current = null; return render(); }
    if (t.closest('#g-all-on') || t.closest('#g-all-off')) {
      const on = !!t.closest('#g-all-on');
      for (const s of STRUCTURES) { if (on) delete G().active[s.id]; else G().active[s.id] = false; }
      save(); renderRef(); renderToolbar();
      return;
    }
    if (t.classList.contains('g-active')) e.stopPropagation();
  });
  view.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('g-active')) {
      if (t.checked) delete G().active[t.dataset.id]; else G().active[t.dataset.id] = false;
      save(); renderToolbar();
    }
    if (t.id === 'g-scope') {
      prefs().scope = t.value; save();
      current = null;
      if (mode() === 'ref') prefs().mode = 'mix';
      render();
    }
  });
  view.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.classList?.contains('g-ref-item') && d.open) {
      d.querySelectorAll('[data-py-lazy]').forEach(el => { el.dataset.py = el.dataset.pyLazy; el.removeAttribute('data-py-lazy'); });
      fillPinyin(d);
    }
  }, true);
  $('g-generate').onclick = generate;
  $('g-chat-send').onclick = sendChat;
  $('g-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  document.addEventListener('keydown', (e) => {
    if (view.hidden || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.target.closest('textarea, input, select')) return;
    if (!current || mode() === 'ref') return;
    const k = e.key.toLowerCase();
    if (!current.answered && current.order) {
      const idx = '1234'.indexOf(k) >= 0 ? '1234'.indexOf(k) : 'abcd'.indexOf(k);
      if (idx >= 0 && idx < current.order.length) { e.preventDefault(); answerOption(idx); }
    } else if (!current.answered && current.mode === 'order') {
      const idx = '123'.indexOf(k) >= 0 ? '123'.indexOf(k) : 'abc'.indexOf(k);
      if (idx >= 0) { e.preventDefault(); placeTile(idx); }
      if (k === 'enter' && current.placed.length === 3) { e.preventDefault(); checkOrder(); }
      if (k === 'backspace' && current.placed.length) { e.preventDefault(); unplace(current.placed.length - 1); }
    } else if ((current.answered || current.entry) && k === 'enter') {
      e.preventDefault(); goNext();
    }
  });

  loadPinyin(); // warm up in the background

  return { render };
}
