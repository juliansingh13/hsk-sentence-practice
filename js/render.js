// Rendering shared by the vocabulary and grammar sections.
import { escapeHtml, highlightHtml } from './highlight.js';
import { chineseToPinyin } from './pinyin.js';

// Per-mode result config. types: [error type, label, legend class]; the colours for each type are
// in style.css (mark.err-<type>, .num.t-<type>, .legend .l-<class>).
// feedback: the summary line under "overall"; notUsed: the badge for sentences without the target.
export const RESULT_MODES = {
  vocab: {
    types: [['target_word', 'Target word', 'tw'], ['grammar', 'Grammar', 'gr'], ['naturalness', 'Naturalness', 'nat']],
    feedback: { key: 'target_word_feedback', type: 'target_word', cls: '' },
    notUsed: 'Word not used',
  },
  free: {
    types: [['grammar', 'Grammar', 'gr'], ['word_choice', 'Word choice', 'wc'], ['naturalness', 'Naturalness', 'nat'], ['meaning', 'Meaning', 'mean']],
    optional: ['meaning'], // in the legend only when "What I meant" was given
    feedback: { key: 'meaning_feedback', type: 'meaning', cls: ' fb-mean' },
    notUsed: null,
  },
};

// opts: { mode: 'vocab' | 'free' } plus label overrides, e.g. { target_word: 'Structure', notUsed: 'Structure not used' }
export function renderResult(r, opts = {}) {
  if (!r || !Array.isArray(r.sentences)) return '';
  const { mode = 'vocab', ...labels } = opts;
  const cfg = RESULT_MODES[mode] || RESULT_MODES.vocab;
  const L = { ...Object.fromEntries(cfg.types.map(([t, label]) => [t, label])), notUsed: cfg.notUsed, ...labels };
  const fb = cfg.feedback;
  const used = (t) => !!r[fb.key] || r.sentences.some(s => (s.errors || []).some(e => e.type === t));
  const legend = cfg.types.filter(([t]) => !cfg.optional?.includes(t) || used(t));
  let html = '<div class="result">';
  html += `<div class="legend">${legend.map(([t, , c]) => `<span class="l-${c}">${escapeHtml(L[t])}</span>`).join('')}</div>`;
  if (r.overall || r[fb.key]) {
    html += '<div class="summary">';
    if (r.overall) html += `<p>${escapeHtml(r.overall)}</p>`;
    if (r[fb.key]) html += `<p class="tw-feedback${fb.cls}"><strong>${escapeHtml(L[fb.type])}:</strong> ${escapeHtml(r[fb.key])}</p>`;
    html += '</div>';
  }
  r.sentences.forEach((s, si) => {
    const errs = s.errors || [];
    const nums = errs.map((_, i) => i + 1);
    const { html: sentHtml, positions } = highlightHtml(s.original, errs, nums);
    const hasTw = errs.some(e => e.type === 'target_word');
    const onlyNat = errs.length && errs.every(e => e.type === 'naturalness');
    let badge;
    if (!errs.length) badge = '<span class="badge ok">Correct</span>';
    else if (onlyNat) badge = '<span class="badge warn">Unnatural</span>';
    else badge = `<span class="badge bad">${errs.length} issue${errs.length > 1 ? 's' : ''}</span>`;
    if (L.notUsed && !s.target_word_used && !hasTw) badge += ` <span class="badge warn">${escapeHtml(L.notUsed)}</span>`;

    html += `<div class="sentence" data-s="${si}">`;
    html += `<div class="sentence-head"><div class="sentence-text">${sentHtml}</div><div>${badge}</div></div>`;
    const originalPinyin = chineseToPinyin(s.original);
    if (originalPinyin) html += `<div class="sentence-pinyin">${escapeHtml(originalPinyin)}</div>`;
    if (errs.length) {
      html += '<ol class="errors">';
      errs.forEach((e, i) => {
        const fix = e.span || e.suggestion
          ? `<div class="fix">${e.span ? `<span class="from">${escapeHtml(e.span)}</span>` : ''}${e.span ? ' → ' : ''}${e.suggestion ? `<span class="to">${escapeHtml(e.suggestion)}</span>` : '<span class="remove">remove</span>'}</div>`
          : '';
        const unloc = e.span && !positions[i] ? '<div class="unlocated">(could not mark this in the sentence)</div>' : '';
        html += `<li data-err="${i}"><span class="num t-${escapeHtml(e.type)}">${nums[i]}</span><div>`
          + `<div class="err-type">${escapeHtml(L[e.type] || e.type)}</div>${fix}<div class="explain">${escapeHtml(e.explanation)}</div>${unloc}</div></li>`;
      });
      html += '</ol>';
    }
    const showCorr = s.corrected && s.corrected !== s.original;
    const showNat = s.natural && s.natural !== s.corrected && s.natural !== s.original;
    if (showCorr || showNat) {
      html += '<div class="versions">';
      if (showCorr) {
        html += `<div><span class="vlabel">Corrected</span>${escapeHtml(s.corrected)}`;
        const correctedPinyin = chineseToPinyin(s.corrected);
        if (correctedPinyin) html += `<div class="sentence-pinyin">${escapeHtml(correctedPinyin)}</div>`;
        html += '</div>';
      }
      if (showNat) {
        html += `<div><span class="vlabel">Natural</span>${escapeHtml(s.natural)}`;
        const naturalPinyin = chineseToPinyin(s.natural);
        if (naturalPinyin) html += `<div class="sentence-pinyin">${escapeHtml(naturalPinyin)}</div>`;
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// "Explain a sentence" result: pinyin, translation, word table, grammar points, notes.
export function renderExplain(x) {
  if (!x || !x.sentence) return '';
  const e = escapeHtml;
  let html = '<div class="result explain">';
  html += '<div class="sentence ex-head">';
  html += `<div class="sentence-text">${e(x.sentence)}</div>`;
  if (x.pinyin) html += `<div class="sentence-pinyin">${e(x.pinyin)}</div>`;
  if (x.translation) html += `<div class="ex-translation">${e(x.translation)}</div>`;
  html += '</div>';
  if (x.error_note) html += `<div class="ex-error"><strong>Possible mistake:</strong> ${e(x.error_note)}</div>`;
  if (x.words?.length) {
    html += '<div class="sentence ex-section"><div class="label">Word by word</div><table class="ex-words">'
      + '<thead><tr><th>Word</th><th>Pinyin</th><th>Meaning</th><th>Role</th></tr></thead><tbody>'
      + x.words.map(w => `<tr><td class="ex-w">${e(w.word)}</td><td class="ex-py">${e(w.pinyin)}</td><td class="ex-m">${e(w.meaning)}</td><td class="ex-role">${e(w.role)}</td></tr>`).join('')
      + '</tbody></table></div>';
  }
  if (x.grammar?.length) {
    html += '<div class="sentence ex-section"><div class="label">Grammar</div><ol class="ex-points">';
    for (const g of x.grammar) {
      html += `<li><div class="ex-pattern">${e(g.pattern)}</div><div class="explain">${e(g.explanation)}</div>`;
      if (g.example?.zh) {
        html += `<div class="ex-example"><div class="ex-zh">${e(g.example.zh)}</div>`
          + (g.example.pinyin ? `<div class="sentence-pinyin">${e(g.example.pinyin)}</div>` : '')
          + (g.example.en ? `<div class="ex-en">${e(g.example.en)}</div>` : '') + '</div>';
      }
      html += '</li>';
    }
    html += '</ol></div>';
  }
  if (x.notes?.length) {
    html += `<div class="sentence ex-section"><div class="label">Notes</div><ul class="ex-notes">${x.notes.map(n => `<li>${mdLite(n)}</li>`).join('')}</ul></div>`;
  }
  html += '</div>';
  return html;
}

export function mdLite(text) {
  // Escape, then allow **bold** and "- " bullet lists.
  const lines = escapeHtml(text).split('\n');
  let out = '', inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${m[1]}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    out += line + '\n';
  }
  if (inList) out += '</ul>';
  return out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n+$/, '');
}

export function msgHtml(m) {
  return `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${m.role === 'user' ? escapeHtml(m.content) : mdLite(m.content)}</div>`;
}
