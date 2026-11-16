// "Check" page: check any Chinese the learner wrote, or explain a sentence they didn't write.
// Not tied to a deck word. History lives in state.free, separate from the per-word history.
import { escapeHtml } from './highlight.js';
import { renderResult, renderExplain, msgHtml } from './render.js';
import {
  freeCheckMessages, normalizeFreeCheck, explainMessages, normalizeExplain, chatMessages,
  callDeepSeek, safeJson, cleanRegister, FREE_LIMIT, EXPLAIN_LIMIT, MEANT_LIMIT,
} from './prompts.js';

const HISTORY_CAP = 100;
const $ = (id) => document.getElementById(id);

const MODES = {
  free: {
    label: 'Your Chinese', placeholder: '写几句中文……', limit: FREE_LIMIT,
    submit: 'Check', busy: 'Checking…', tag: 'Check',
    chatPlaceholder: 'e.g. Why is 了 wrong here? Can I say … instead?',
    intro: 'Write anything in Chinese. Mistakes are marked by kind: <span class="tag tag-gr">grammar</span>, <span class="tag tag-wc">word choice</span>, <span class="tag tag-nat">naturalness</span> and, if you say what you meant, <span class="tag tag-mean">meaning</span>. You also get a corrected and a natural version.',
  },
  explain: {
    label: 'Sentence to explain', placeholder: '粘贴一句中文……', limit: EXPLAIN_LIMIT,
    submit: 'Explain', busy: 'Explaining…', tag: 'Explain',
    chatPlaceholder: 'e.g. Why is 把 used here? What does 得 do?',
    intro: 'Paste Chinese you didn’t write (from a textbook, a sign, a chat message) for the full pinyin, a natural translation, a word-by-word breakdown, the grammar it uses with extra examples, and notes on register and idioms.',
  },
};

// deps: { getState, save, hasCredentials, ownKey, server(path, payload), goSettings }
export function initChecker({ getState, save, hasCredentials, ownKey, server, goSettings }) {
  const shown = { free: null, explain: null }; // id of the history entry shown in each mode

  function data() {
    const s = getState();
    if (!s.free || typeof s.free !== 'object') s.free = {};
    const f = s.free;
    if (f.mode !== 'explain') f.mode = 'free';
    f.register = cleanRegister(f.register);
    if (!Array.isArray(f.history)) f.history = [];
    return f;
  }
  const mode = () => data().mode;
  const entryById = (id) => data().history.find(e => e.id === id) || null;
  const currentEntry = () => entryById(shown[mode()]);

  // ---------- drafts (per mode, this tab only) ----------
  const draftKey = (m) => 'hskw.cdraft.' + m;
  const getDraft = (m) => { try { return sessionStorage.getItem(draftKey(m)) || ''; } catch { return ''; } };
  const setDraft = (m, v) => { try { sessionStorage.setItem(draftKey(m), v); } catch {} };

  // ---------- model calls (own key: straight to DeepSeek; otherwise the passphrase server) ----------
  async function runFree(input) {
    const hasMeaning = !!input.meant.trim();
    if (ownKey()) {
      const content = await callDeepSeek({ key: ownKey(), messages: freeCheckMessages(input), json: true });
      const parsed = safeJson(content);
      if (!parsed) throw new Error('The model returned an unreadable answer. Try again.');
      return normalizeFreeCheck(parsed, { hasMeaning });
    }
    return normalizeFreeCheck(await server('/api/check', { mode: 'free', ...input }), { hasMeaning });
  }
  async function runExplain(input) {
    if (ownKey()) {
      const content = await callDeepSeek({ key: ownKey(), messages: explainMessages(input), json: true, maxTokens: 4000 });
      const parsed = safeJson(content);
      if (!parsed) throw new Error('The model returned an unreadable answer. Try again.');
      return normalizeExplain(parsed, input);
    }
    return normalizeExplain(await server('/api/check', { mode: 'explain', ...input }), input);
  }
  async function runChat(entry) {
    const opts = { mode: entry.mode, meant: entry.meant, register: entry.register };
    if (ownKey()) {
      const reply = await callDeepSeek({
        key: ownKey(),
        messages: chatMessages(null, entry.text, entry.result, entry.chat, opts),
        temperature: 0.4,
        maxTokens: 1500,
      });
      return reply.trim();
    }
    const res = await server('/api/chat', { ...opts, text: entry.text, result: entry.result, messages: entry.chat });
    return res.reply;
  }

  // ---------- rendering ----------
  function setStatus(id, html, isError) {
    const s = $(id);
    s.hidden = false;
    s.className = 'status' + (isError ? ' error' : '');
    s.innerHTML = html;
  }

  function updateCount() {
    const cfg = MODES[mode()];
    const n = $('c-text').value.length;
    const near = n >= cfg.limit * 0.8;
    const c = $('c-count');
    c.hidden = !near;
    c.textContent = `${n.toLocaleString()} / ${cfg.limit.toLocaleString()}`;
    c.classList.toggle('over', n > cfg.limit);
    $('c-submit').disabled = n > cfg.limit || !hasCredentials();
  }

  function render() {
    const f = data();
    const m = f.mode;
    const cfg = MODES[m];
    for (const b of $('c-modes').querySelectorAll('.g-mode')) {
      const on = b.dataset.mode === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    $('c-text-label').textContent = cfg.label;
    $('c-text').placeholder = cfg.placeholder;
    $('c-text').value = getDraft(m);
    $('c-free-fields').hidden = m !== 'free';
    $('c-meant').value = getDraft('meant');
    for (const r of document.querySelectorAll('input[name="c-register"]')) r.checked = r.value === f.register;
    $('c-submit').textContent = cfg.submit;
    $('c-nokey').hidden = hasCredentials();
    $('c-status').hidden = true;
    $('c-chat-input').placeholder = cfg.chatPlaceholder;
    updateCount();
    renderCurrent();
    renderHistory();
  }

  function renderCurrent() {
    const e = currentEntry();
    $('c-empty').hidden = !!e;
    $('c-empty').innerHTML = `<p>${MODES[mode()].intro}</p>`;
    $('c-result').innerHTML = !e ? ''
      : e.mode === 'free' ? renderResult(e.result, { mode: 'free' })
      : renderExplain(e.result);
    $('c-chat').hidden = !e;
    $('c-chat-status').hidden = true;
    $('c-chat-log').innerHTML = e ? (e.chat || []).map(msgHtml).join('') : '';
  }

  function renderHistory() {
    const list = data().history;
    $('c-history').hidden = !list.length;
    $('c-history-summary').textContent = `History (${list.length})`;
    const active = shown[mode()];
    $('c-hist-list').innerHTML = list.map(e => {
      const date = new Date(e.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const qs = (e.chat || []).filter(c => c.role === 'user').length;
      return `<li class="c-hist-item${e.id === active ? ' active' : ''}">`
        + `<button type="button" class="c-hist-open" data-id="${escapeHtml(e.id)}">`
        + `<span class="c-hist-tag t-${e.mode === 'free' ? 'free' : 'explain'}">${MODES[e.mode]?.tag || ''}</span>`
        + `<span class="c-hist-text">${escapeHtml(e.text.replace(/\s+/g, ' ').slice(0, 80))}</span>`
        + `<span class="c-hist-meta">${escapeHtml(date)}${qs ? ` · ${qs} question${qs > 1 ? 's' : ''}` : ''}</span>`
        + '</button>'
        + `<button type="button" class="c-hist-del" data-del="${escapeHtml(e.id)}" title="Delete" aria-label="Delete this entry">×</button>`
        + '</li>';
    }).join('');
  }

  // ---------- actions ----------
  async function submit() {
    const m = mode();
    const cfg = MODES[m];
    const text = $('c-text').value.trim();
    if (!text) { $('c-text').focus(); return; }
    if (!hasCredentials()) { setStatus('c-status', 'Add your DeepSeek API key or the passphrase in Settings first.', true); return; }
    if (text.length > cfg.limit) { setStatus('c-status', `Too long: at most ${cfg.limit} characters.`, true); return; }
    const input = m === 'free'
      ? { text, meant: $('c-meant').value.trim().slice(0, MEANT_LIMIT), register: data().register }
      : { text };
    const btn = $('c-submit');
    btn.disabled = true;
    setStatus('c-status', `<span class="spinner"></span>${cfg.busy}`);
    try {
      const result = m === 'free' ? await runFree(input) : await runExplain(input);
      if (m === 'free' ? !result.sentences.length : !result.sentence) throw new Error('The model returned an empty answer. Try again.');
      const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), mode: m, ...input, result, chat: [], ts: Date.now() };
      const f = data();
      f.history.unshift(entry);
      if (f.history.length > HISTORY_CAP) f.history.length = HISTORY_CAP;
      shown[m] = entry.id;
      save();
      $('c-status').hidden = true;
      renderCurrent();
      renderHistory();
      if (mode() === m) $('c-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setStatus('c-status', escapeHtml(e.message || String(e)), true);
    } finally {
      updateCount();
    }
  }

  async function sendChat() {
    const entry = currentEntry();
    if (!entry) return;
    const input = $('c-chat-input');
    const q = input.value.trim();
    if (!q) return;
    entry.chat ||= [];
    entry.chat.push({ role: 'user', content: q });
    input.value = '';
    save();
    $('c-chat-log').innerHTML = entry.chat.map(msgHtml).join('');
    const btn = $('c-chat-send');
    btn.disabled = true;
    setStatus('c-chat-status', '<span class="spinner"></span>Thinking…');
    try {
      const reply = await runChat(entry);
      entry.chat.push({ role: 'assistant', content: reply });
      save();
      $('c-chat-status').hidden = true;
    } catch (e) {
      entry.chat.pop(); // let the user resend
      input.value = q;
      save();
      setStatus('c-chat-status', escapeHtml(e.message || String(e)), true);
    } finally {
      btn.disabled = false;
      if (currentEntry() === entry) $('c-chat-log').innerHTML = entry.chat.map(msgHtml).join('');
      renderHistory();
    }
  }

  function open(id) {
    const e = entryById(id);
    if (!e) return;
    data().mode = e.mode;
    shown[e.mode] = id;
    // Put the entry's input back in the form so it can be edited and re-run.
    setDraft(e.mode, e.text);
    if (e.mode === 'free') { setDraft('meant', e.meant || ''); data().register = cleanRegister(e.register); }
    save();
    render();
    $('c-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function remove(id) {
    const f = data();
    const e = entryById(id);
    if (!e || !confirm('Delete this entry and its questions?')) return;
    f.history = f.history.filter(x => x.id !== id);
    for (const k of Object.keys(shown)) if (shown[k] === id) shown[k] = null;
    save();
    renderCurrent();
    renderHistory();
  }

  // ---------- events ----------
  $('c-modes').addEventListener('click', (e) => {
    const b = e.target.closest('.g-mode');
    if (!b || b.dataset.mode === mode()) return;
    data().mode = b.dataset.mode;
    save();
    render();
  });
  $('c-text').addEventListener('input', () => { setDraft(mode(), $('c-text').value); updateCount(); });
  $('c-meant').addEventListener('input', () => setDraft('meant', $('c-meant').value));
  for (const r of document.querySelectorAll('input[name="c-register"]')) {
    r.addEventListener('change', () => { if (r.checked) { data().register = r.value; save(); } });
  }
  for (const id of ['c-text', 'c-meant']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
  }
  $('c-submit').onclick = submit;
  $('c-chat-send').onclick = sendChat;
  $('c-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  $('c-hist-list').addEventListener('click', (e) => {
    const del = e.target.closest('.c-hist-del');
    if (del) return remove(del.dataset.del);
    const op = e.target.closest('.c-hist-open');
    if (op) open(op.dataset.id);
  });
  $('c-go-settings').addEventListener('click', (e) => { e.preventDefault(); goSettings(); });

  // A backup import replaces the history; forget entries that no longer exist.
  function reset() { shown.free = null; shown.explain = null; }

  return { render, reset };
}
