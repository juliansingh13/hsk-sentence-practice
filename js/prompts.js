// Prompts and response handling shared by the browser (own-key mode)
// and the server functions (passphrase mode).

export const DEFAULT_MODEL = 'deepseek-chat';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export const CHECK_SYSTEM_PROMPT = `You are an expert Mandarin Chinese teacher reviewing sentences written by an intermediate learner who is practising one specific new vocabulary word. Be accurate and thorough, but do not invent problems: if a sentence is correct and natural, report no errors.

You receive the target word (with pinyin, meaning and the example sentence from the learner's flashcard) and the learner's text, which may contain one or several sentences.

Instructions:
1. Split the learner's text into sentences. In "original", copy each sentence exactly as written (same characters and punctuation, nothing fixed).
2. Find every error in each sentence and classify it:
   - "target_word": anything about how the TARGET WORD is used: wrong meaning or sense, wrong part of speech, wrong collocation or object, wrong position, wrong register, a missing particle or complement the word requires, a wrong character in the word, or the target word not being used at all.
   - "grammar": grammatical errors elsewhere in the sentence: word order, aspect particles (了/过/着), measure words, 的/地/得, complements, negation (不/没), missing or extra words, wrong characters.
   - "naturalness": the sentence is grammatical, but a native speaker would not phrase it this way (unidiomatic word choice, awkward or translated-sounding phrasing, register mismatch).
3. "span": the shortest EXACT substring of "original" containing the problem, copied character for character so it can be found by string search. If something is missing, use the characters adjacent to the gap.
4. "suggestion": what should replace the span. "explanation": a concise explanation in English (1–3 sentences) that teaches the underlying rule or usage. Give pinyin for any Chinese word you introduce that is not in the learner's sentence.
5. "corrected": the minimally corrected sentence (fix the errors, keep the learner's meaning and structure). "natural": how a native speaker would most naturally say the same thing (may be identical to "corrected").
6. "target_word_used": true if the sentence uses the target word (in any form), else false.

Respond with a single JSON object only, exactly in this format:
{
  "sentences": [
    {
      "original": "string",
      "target_word_used": true,
      "errors": [
        { "type": "target_word | grammar | naturalness", "span": "string", "suggestion": "string", "explanation": "string" }
      ],
      "corrected": "string",
      "natural": "string"
    }
  ],
  "target_word_feedback": "1–3 sentences in English on how the learner used the target word across all sentences, plus one practical usage tip (common collocations or pitfalls).",
  "overall": "One short, neutral summary sentence in English."
}`;

export function str(v, max = 2000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const TYPES = new Set(['target_word', 'grammar', 'naturalness']);

export function normalizeCheck(data) {
  const sentences = Array.isArray(data?.sentences) ? data.sentences : [];
  return {
    sentences: sentences.slice(0, 30).map(s => ({
      original: str(s?.original),
      target_word_used: s?.target_word_used !== false,
      errors: (Array.isArray(s?.errors) ? s.errors : []).slice(0, 20).map(e => ({
        type: TYPES.has(e?.type) ? e.type : 'grammar',
        span: str(e?.span, 200),
        suggestion: str(e?.suggestion, 300),
        explanation: str(e?.explanation, 1200),
      })),
      corrected: str(s?.corrected),
      natural: str(s?.natural),
    })).filter(s => s.original),
    target_word_feedback: str(data?.target_word_feedback),
    overall: str(data?.overall),
  };
}

export function checkMessages(word, text) {
  const userMsg = [
    `Target word: ${str(word.hanzi, 50)}`,
    `Pinyin: ${str(word.pinyin, 100) || '(not given)'}`,
    `Meaning: ${str(word.meaning, 300) || '(not given)'}`,
    `Flashcard example sentence: ${str(word.example, 500) || '(not given)'}`,
    ...(word.exampleTranslation ? [`Example sentence translation: ${str(word.exampleTranslation, 500)}`] : []),
    '',
    "Learner's text:",
    text.trim(),
  ].join('\n');
  return [
    { role: 'system', content: CHECK_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];
}

export function mockCheck(word, text) {
  const parts = text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  return {
    sentences: parts.map((p, i) => ({
      original: p,
      target_word_used: p.includes(word.hanzi),
      errors: i === 0 && p.length > 2 ? [
        { type: 'target_word', span: p.slice(0, 2), suggestion: '（示例）', explanation: 'Mock mode: this is a sample target-word error so you can see the highlighting.' },
        ...(p.length > 5 ? [{ type: 'grammar', span: p.slice(3, 5), suggestion: '（示例）', explanation: 'Mock mode: sample grammar error.' }] : []),
        ...(p.length > 8 ? [{ type: 'naturalness', span: p.slice(6, 8), suggestion: '（示例）', explanation: 'Mock mode: sample naturalness note.' }] : []),
      ] : [],
      corrected: p,
      natural: p,
    })),
    target_word_feedback: `Mock mode is on (MOCK=1), so no real checking happened for ${word.hanzi}.`,
    overall: 'Mock response.',
  };
}

// The per-sentence corrections, as context for follow-up questions (vocab and free modes).
function correctionLines(result) {
  const lines = [];
  for (const s of (Array.isArray(result?.sentences) ? result.sentences : []).slice(0, 30)) {
    lines.push(`• Sentence: ${str(s.original, 300)}`);
    const errs = Array.isArray(s.errors) ? s.errors : [];
    if (!errs.length) lines.push('  No errors.');
    errs.slice(0, 20).forEach((e, i) => {
      lines.push(`  ${i + 1}. [${str(e.type, 20)}] "${str(e.span, 100)}" → "${str(e.suggestion, 150)}": ${str(e.explanation, 600)}`);
    });
    if (s.corrected && s.corrected !== s.original) lines.push(`  Corrected: ${str(s.corrected, 300)}`);
    if (s.natural && s.natural !== s.corrected) lines.push(`  Natural: ${str(s.natural, 300)}`);
  }
  return lines;
}

function contextBlock(word, text, result) {
  const lines = [
    `Target word: ${str(word?.hanzi, 50)} (${str(word?.pinyin, 100)}) — ${str(word?.meaning, 300)}`,
    `Flashcard example: ${str(word?.example, 500)}${word?.exampleTranslation ? ` — ${str(word.exampleTranslation, 500)}` : ''}`,
    '',
    "Learner's sentences:",
    str(text, 1500),
    '',
    'Corrections already given to the learner:',
    ...correctionLines(result),
  ];
  if (result?.target_word_feedback) lines.push('', `Target-word feedback: ${str(result.target_word_feedback, 800)}`);
  return lines.join('\n');
}

// opts.mode: 'vocab' (default), 'free' or 'explain'. Free mode also takes opts.meant and opts.register.
export function chatMessages(word, text, result, turns, opts = {}) {
  const system = opts.mode === 'free' ? freeChatSystem(text, result, opts)
    : opts.mode === 'explain' ? explainChatSystem(text, result)
    : vocabChatSystem(word, text, result);
  const clean = (Array.isArray(turns) ? turns : [])
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && str(m.content).trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: str(m.content, 2000) }));
  return [{ role: 'system', content: system }, ...clean];
}

function vocabChatSystem(word, text, result) {
  return `You are a patient, precise Mandarin Chinese tutor. The learner has just written practice sentences with a new vocabulary word and received the corrections below. Answer their follow-up questions about these sentences, the corrections, the target word, or related grammar and usage.

Guidelines:
- Answer in English. Write Chinese in simplified characters and add pinyin for words or examples the learner may not know.
- Be concise: usually a short paragraph, plus 1–3 example sentences (with pinyin and translation) when they help.
- If a correction given earlier was wrong or debatable, say so plainly and explain.
- If the learner proposes a new sentence, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Context:
${contextBlock(word, text, result)}`;
}

export function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = typeof s === 'string' && s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// One call to DeepSeek. Works in the browser and in Node 18+.
// Returns the message content string, or throws Error with a readable message.
export async function callDeepSeek({ key, messages, json = false, model = DEFAULT_MODEL, maxTokens = 3000, temperature = 0.2, timeoutMs = 60000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err?.name === 'AbortError' ? 'DeepSeek took too long to answer. Try again.'
      : 'Could not reach DeepSeek. Check your internet connection.');
  }
  clearTimeout(timer);
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error(
      r.status === 401 ? 'DeepSeek rejected the API key. Check it in Settings.'
      : r.status === 402 ? 'Your DeepSeek account has insufficient balance. Top it up at platform.deepseek.com.'
      : r.status === 429 ? 'DeepSeek rate limit hit; try again in a moment.'
      : `DeepSeek error ${r.status}: ${detail}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error('Empty answer from DeepSeek. Try again.');
  return content;
}

// ---------- Free checking ("Check my Chinese") ----------
export const FREE_LIMIT = 1500;
export const EXPLAIN_LIMIT = 500;
export const MEANT_LIMIT = 500;
export const REGISTERS = ['casual', 'neutral', 'formal'];

export const FREE_CHECK_SYSTEM_PROMPT = `You are an expert Mandarin Chinese teacher reviewing text written by a learner. The text is not tied to any particular vocabulary word. Be accurate and thorough, but do not invent problems: if a sentence is correct and natural, report no errors.

You receive the learner's text (one or several sentences), the register they are aiming for (casual, neutral or formal) and, optionally, an English description of what they meant to say.

Instructions:
1. Split the learner's text into sentences. In "original", copy each sentence exactly as written (same characters and punctuation, nothing fixed).
2. Find every error in each sentence and classify it:
   - "grammar": word order, aspect particles (了/过/着), 的/地/得, complements, negation (不/没), sentence patterns, missing or extra words, wrong characters.
   - "word_choice": the wrong word for the context, a wrong collocation (verb–object, adjective–noun), a wrong measure word, or confusing two similar words (e.g. 认识/知道, 帮/帮助).
   - "naturalness": grammatical, but a native speaker would not phrase it this way (unidiomatic or translated-sounding phrasing), including a mismatch with the requested register.
   - "meaning": ONLY if the learner said what they meant: the Chinese is correct-looking but says something different from, or less than, the intended meaning. Never use "meaning" when no intended meaning was given.
3. "span": the shortest EXACT substring of "original" containing the problem, copied character for character so it can be found by string search. If something is missing, use the characters adjacent to the gap.
4. "suggestion": what should replace the span. "explanation": a concise explanation in English (1–3 sentences) that teaches the underlying rule or usage. Give pinyin for any Chinese word you introduce that is not in the learner's sentence.
5. "corrected": the minimally corrected sentence (fix the errors, keep the learner's structure and, if given, their intended meaning). "natural": how a native speaker would most naturally say it in the requested register (may be identical to "corrected").
6. "meaning_feedback": if an intended meaning was given, 1–2 sentences in English on whether the Chinese as a whole expresses it; otherwise an empty string.

Respond with a single JSON object only, exactly in this format:
{
  "sentences": [
    {
      "original": "string",
      "errors": [
        { "type": "grammar | word_choice | naturalness | meaning", "span": "string", "suggestion": "string", "explanation": "string" }
      ],
      "corrected": "string",
      "natural": "string"
    }
  ],
  "meaning_feedback": "string",
  "overall": "One short, neutral summary sentence in English."
}`;

const FREE_TYPES = new Set(['grammar', 'word_choice', 'naturalness', 'meaning']);

export function cleanRegister(r) {
  return REGISTERS.includes(r) ? r : 'neutral';
}

// input: { text, meant, register }
export function freeCheckMessages({ text, meant, register }) {
  const m = str(meant, MEANT_LIMIT).trim();
  const userMsg = [
    `Register: ${cleanRegister(register)}`,
    `What the learner meant (English): ${m || '(not given; do not use the "meaning" type)'}`,
    '',
    "Learner's text:",
    str(text, FREE_LIMIT).trim(),
  ].join('\n');
  return [
    { role: 'system', content: FREE_CHECK_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];
}

// hasMeaning: whether the learner gave "What I meant"; without it, "meaning" errors are not allowed.
export function normalizeFreeCheck(data, { hasMeaning = false } = {}) {
  const sentences = Array.isArray(data?.sentences) ? data.sentences : [];
  const type = (t) => {
    if (t === 'target_word') return 'word_choice';
    if (t === 'meaning' && !hasMeaning) return 'grammar';
    return FREE_TYPES.has(t) ? t : 'grammar';
  };
  return {
    sentences: sentences.slice(0, 30).map(s => ({
      original: str(s?.original),
      errors: (Array.isArray(s?.errors) ? s.errors : []).slice(0, 20).map(e => ({
        type: type(e?.type),
        span: str(e?.span, 200),
        suggestion: str(e?.suggestion, 300),
        explanation: str(e?.explanation, 1200),
      })),
      corrected: str(s?.corrected),
      natural: str(s?.natural),
    })).filter(s => s.original),
    meaning_feedback: hasMeaning ? str(data?.meaning_feedback, 800) : '',
    overall: str(data?.overall, 600),
  };
}

export function mockFreeCheck({ text, meant }) {
  const parts = str(text, FREE_LIMIT).split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  const hasMeaning = !!str(meant).trim();
  return {
    sentences: parts.map((p, i) => ({
      original: p,
      errors: i === 0 && p.length > 2 ? [
        { type: 'word_choice', span: p.slice(0, 2), suggestion: '（示例）', explanation: 'Mock mode: a sample word-choice note.' },
        ...(p.length > 5 ? [{ type: 'grammar', span: p.slice(3, 5), suggestion: '（示例）', explanation: 'Mock mode: sample grammar error.' }] : []),
        ...(p.length > 8 ? [{ type: 'naturalness', span: p.slice(6, 8), suggestion: '（示例）', explanation: 'Mock mode: sample naturalness note.' }] : []),
        ...(hasMeaning && p.length > 10 ? [{ type: 'meaning', span: p.slice(9, 11), suggestion: '（示例）', explanation: 'Mock mode: sample meaning note.' }] : []),
      ] : [],
      corrected: p,
      natural: p,
    })),
    meaning_feedback: hasMeaning ? 'Mock mode: with a real key, this says whether your Chinese expresses what you meant.' : '',
    overall: 'Mock response (MOCK=1): no real checking happened.',
  };
}

function freeChatSystem(text, result, { meant, register } = {}) {
  const lines = [
    `Register the learner is aiming for: ${cleanRegister(register)}`,
    `What the learner meant: ${str(meant, MEANT_LIMIT).trim() || '(not given)'}`,
    '',
    "Learner's text:",
    str(text, FREE_LIMIT),
    '',
    'Corrections already given to the learner:',
    ...correctionLines(result),
  ];
  if (result?.meaning_feedback) lines.push('', `Meaning feedback: ${str(result.meaning_feedback, 800)}`);
  return `You are a patient, precise Mandarin Chinese tutor. The learner wrote some Chinese of their own and received the corrections below. Answer their follow-up questions about these sentences, the corrections, word choice, or related grammar and usage.

Guidelines:
- Answer in English. Write Chinese in simplified characters and add pinyin for words or examples the learner may not know.
- Be concise: usually a short paragraph, plus 1–3 example sentences (with pinyin and translation) when they help.
- If a correction given earlier was wrong or debatable, say so plainly and explain.
- If the learner proposes a new sentence, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Context:
${lines.join('\n')}`;
}

// ---------- Explaining a sentence ----------
export const EXPLAIN_SYSTEM_PROMPT = `You are an expert Mandarin Chinese teacher. A learner (roughly HSK 3–5) has found a Chinese sentence they did not write (in a textbook, on a sign, in a chat message) and wants to understand it fully. Explanations are in English; Chinese is in simplified characters. If the input is in traditional characters, explain it in simplified.

Produce:
1. "sentence": the sentence as given (convert to simplified characters if needed).
2. "pinyin": the full pinyin with tone marks, words written together (e.g. "Wǒ míngtiān qù xuéxiào."), with tone changes of 一 and 不 applied.
3. "translation": a natural English translation (not word-for-word).
4. "words": the sentence split into words in order, every word once, punctuation left out. For each: "word", "pinyin" (tone marks), "meaning" (short, in this context), "role" (its function in this sentence, e.g. "subject", "time expression", "verb", "aspect particle (completed action)", "resultative complement", "measure word for …").
5. "grammar": the grammar points or patterns the sentence uses (0–5, most important first; skip trivial ones). For each: "pattern" (e.g. "把 + object + verb + complement"), "explanation" (1–3 sentences on what it does here and how it is used), and one extra "example" that is a different sentence using the same pattern, with "zh", "pinyin" and "en".
6. "notes": 0–4 short notes on register (spoken/written, formal/casual), idioms or set phrases, cultural context, or anything easy to misread or mistranslate. Use pinyin for any other Chinese word you mention.
7. "error_note": do not check the sentence for errors in general. Only if it clearly contains a mistake (a typo, wrong character, or ungrammatical phrasing), describe it in one or two sentences with the correction; otherwise an empty string.

Respond with a single JSON object only, exactly in this format:
{
  "sentence": "string",
  "pinyin": "string",
  "translation": "string",
  "words": [ { "word": "string", "pinyin": "string", "meaning": "string", "role": "string" } ],
  "grammar": [ { "pattern": "string", "explanation": "string", "example": { "zh": "string", "pinyin": "string", "en": "string" } } ],
  "notes": [ "string" ],
  "error_note": "string"
}`;

export function explainMessages({ text }) {
  return [
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    { role: 'user', content: `Sentence to explain:\n${str(text, EXPLAIN_LIMIT).trim()}` },
  ];
}

export function normalizeExplain(data, { text = '' } = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    sentence: str(data?.sentence, EXPLAIN_LIMIT) || str(text, EXPLAIN_LIMIT).trim(),
    pinyin: str(data?.pinyin, 2000),
    translation: str(data?.translation, 1500),
    words: arr(data?.words).slice(0, 80).map(w => ({
      word: str(w?.word, 40),
      pinyin: str(w?.pinyin, 80),
      meaning: str(w?.meaning, 200),
      role: str(w?.role, 150),
    })).filter(w => w.word),
    grammar: arr(data?.grammar).slice(0, 6).map(g => ({
      pattern: str(g?.pattern, 150),
      explanation: str(g?.explanation, 1000),
      example: {
        zh: str(g?.example?.zh, 300),
        pinyin: str(g?.example?.pinyin, 600),
        en: str(g?.example?.en, 400),
      },
    })).filter(g => g.pattern || g.explanation),
    notes: arr(data?.notes).map(n => str(n, 600)).filter(Boolean).slice(0, 6),
    error_note: str(data?.error_note, 600),
  };
}

export function mockExplain({ text }) {
  const t = str(text, EXPLAIN_LIMIT).trim();
  const han = [...t].filter(c => /[㐀-鿿]/.test(c));
  const words = [];
  for (let i = 0; i < han.length && words.length < 8; i += 2) words.push(han.slice(i, i + 2).join(''));
  return {
    sentence: t,
    pinyin: '(mock pinyin)',
    translation: 'Mock mode (MOCK=1): with a real key, a natural English translation appears here.',
    words: words.map((w, i) => ({ word: w, pinyin: '(mock)', meaning: `mock meaning ${i + 1}`, role: i === 0 ? 'subject' : 'mock role' })),
    grammar: [{ pattern: '是……的', explanation: 'Mock mode: a sample grammar point.', example: { zh: '我是昨天来的。', pinyin: 'Wǒ shì zuótiān lái de.', en: 'I came yesterday.' } }],
    notes: ['Mock mode: a sample note on register.'],
    error_note: '',
  };
}

function explainChatSystem(text, result) {
  const r = result || {};
  const lines = [
    `Sentence: ${str(r.sentence || text, EXPLAIN_LIMIT)}`,
    `Pinyin: ${str(r.pinyin, 2000)}`,
    `Translation: ${str(r.translation, 1500)}`,
    '',
    'Word-by-word breakdown:',
    ...(Array.isArray(r.words) ? r.words : []).slice(0, 80).map(w => `- ${str(w.word, 40)} (${str(w.pinyin, 80)}): ${str(w.meaning, 200)} [${str(w.role, 150)}]`),
    '',
    'Grammar points:',
    ...(Array.isArray(r.grammar) ? r.grammar : []).slice(0, 6).map(g => `- ${str(g.pattern, 150)}: ${str(g.explanation, 1000)} Example: ${str(g.example?.zh, 300)} (${str(g.example?.en, 400)})`),
  ];
  const notes = Array.isArray(r.notes) ? r.notes : [];
  if (notes.length) lines.push('', 'Notes:', ...notes.slice(0, 6).map(n => `- ${str(n, 600)}`));
  if (r.error_note) lines.push('', `Possible error in the sentence: ${str(r.error_note, 600)}`);
  return `You are a patient, precise Mandarin Chinese tutor. The learner asked you to explain a Chinese sentence they did not write, and you gave the explanation below. Answer their follow-up questions about the sentence, its words and grammar, or related usage.

Guidelines:
- Answer in English. Write Chinese in simplified characters and add pinyin for words or examples the learner may not know.
- Be concise: usually a short paragraph, plus 1–3 example sentences (with pinyin and translation) when they help.
- If something in the explanation below was wrong or debatable, say so plainly and correct it.
- If the learner writes a sentence of their own, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Context:
${lines.join('\n')}`;
}
