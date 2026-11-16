// Rendering shared by the vocabulary and grammar sections.
import { escapeHtml, highlightHtml } from './highlight.js';
import { chineseToPinyin } from './pinyin.js';

const DEFAULT_LABELS = { target_word: 'Target word', grammar: 'Grammar', naturalness: 'Naturalness', notUsed: 'Word not used' };

// labels: override the names, e.g. { target_word: 'Structure', notUsed: 'Structure not used' }
export function renderResult(r, labels = {}) {
  if (!r || !Array.isArray(r.sentences)) return '';
  const L = { ...DEFAULT_LABELS, ...labels };
  let html = '<div class="result">';
  html += `<div class="legend"><span class="l-tw">${escapeHtml(L.target_word)}</span><span class="l-gr">${escapeHtml(L.grammar)}</span><span class="l-nat">${escapeHtml(L.naturalness)}</span></div>`;
  if (r.overall || r.target_word_feedback) {
    html += '<div class="summary">';
    if (r.overall) html += `<p>${escapeHtml(r.overall)}</p>`;
    if (r.target_word_feedback) html += `<p class="tw-feedback"><strong>${escapeHtml(L.target_word)}:</strong> ${escapeHtml(r.target_word_feedback)}</p>`;
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
    if (!s.target_word_used && !hasTw) badge += ` <span class="badge warn">${escapeHtml(L.notUsed)}</span>`;

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
