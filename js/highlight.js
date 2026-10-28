// Locate error spans inside a sentence and build highlighted HTML. Pure functions.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Assign each error a non-overlapping position in `original` where possible.
// Returns an array parallel to `errors`: {start, end} or null if not found.
export function locateSpans(original, errors) {
  const owner = new Array(original.length).fill(-1);
  const positions = errors.map(() => null);
  errors.forEach((e, i) => {
    const candidates = [e.span, (e.span || '').trim(), (e.span || '').replace(/\s+/g, '')].filter(Boolean);
    for (const span of candidates) {
      let idx = original.indexOf(span);
      while (idx !== -1) {
        let free = true;
        for (let k = idx; k < idx + span.length; k++) if (owner[k] !== -1) { free = false; break; }
        if (free) break;
        idx = original.indexOf(span, idx + 1);
      }
      if (idx !== -1) {
        for (let k = idx; k < idx + span.length; k++) owner[k] = i;
        positions[i] = { start: idx, end: idx + span.length };
        return;
      }
    }
  });
  return { owner, positions };
}

// Build HTML for a sentence with <mark> runs and superscript numbers.
// `labels[i]` is the number shown for error i.
export function highlightHtml(original, errors, labels) {
  const { owner, positions } = locateSpans(original, errors);
  let html = '';
  let k = 0;
  while (k < original.length) {
    const o = owner[k];
    let j = k;
    while (j < original.length && owner[j] === o) j++;
    const chunk = escapeHtml(original.slice(k, j));
    if (o === -1) {
      html += chunk;
    } else {
      const type = escapeHtml(errors[o].type);
      html += `<mark class="err err-${type}" data-err="${o}">${chunk}<sup>${labels[o]}</sup></mark>`;
    }
    k = j;
  }
  return { html, positions };
}
