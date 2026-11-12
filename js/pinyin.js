const TONE_MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

function markSyllable(syllable, tone) {
  if (tone === '5') return syllable;
  const normalized = syllable.replace(/v/gi, (v) => v === 'V' ? 'Ü' : 'ü').replace(/u:/gi, (u) => u[0] === 'U' ? 'Ü' : 'ü');
  const lower = normalized.toLowerCase();
  const vowel = /a|e|o/.test(lower)
    ? lower.search(/[aeo]/)
    : Math.max(lower.lastIndexOf('i'), lower.lastIndexOf('u'), lower.lastIndexOf('ü'));
  if (vowel < 0) return normalized;
  const marked = TONE_MARKS[lower[vowel]]?.[Number(tone) - 1];
  if (!marked) return normalized;
  return normalized.slice(0, vowel) + (normalized[vowel] === normalized[vowel].toUpperCase() ? marked.toUpperCase() : marked) + normalized.slice(vowel + 1);
}

export function toneNumbersToMarks(value) {
  return String(value || '').replace(/([a-züv:]+)([1-5])/gi, (_, syllable, tone) => markSyllable(syllable, tone));
}

export function chineseToPinyin(value) {
  const text = String(value || '');
  if (!text || !/[\u3400-\u9fff]/.test(text)) return '';
  return pinyin(text, { toneSandhi: true })
    .replace(/\s*([，。！？；：、“”])\s*/g, (_, punctuation) => (
      punctuation === '“' ? ' “' : `${{ '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',' }[punctuation] || punctuation} `
    ))
    .replace(/\s+/g, ' ')
    .trim();
}
import { pinyin } from './vendor/pinyin-pro.js';
