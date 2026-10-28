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

function contextBlock(word, text, result) {
  const lines = [
    `Target word: ${str(word?.hanzi, 50)} (${str(word?.pinyin, 100)}) — ${str(word?.meaning, 300)}`,
    `Flashcard example: ${str(word?.example, 500)}${word?.exampleTranslation ? ` — ${str(word.exampleTranslation, 500)}` : ''}`,
    '',
    "Learner's sentences:",
    str(text, 1500),
    '',
    'Corrections already given to the learner:',
  ];
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
  if (result?.target_word_feedback) lines.push('', `Target-word feedback: ${str(result.target_word_feedback, 800)}`);
  return lines.join('\n');
}

export function chatMessages(word, text, result, turns) {
  const system = `You are a patient, precise Mandarin Chinese tutor. The learner has just written practice sentences with a new vocabulary word and received the corrections below. Answer their follow-up questions about these sentences, the corrections, the target word, or related grammar and usage.

Guidelines:
- Answer in English. Write Chinese in simplified characters and add pinyin for words or examples the learner may not know.
- Be concise: usually a short paragraph, plus 1–3 example sentences (with pinyin and translation) when they help.
- If a correction given earlier was wrong or debatable, say so plainly and explain.
- If the learner proposes a new sentence, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Context:
${contextBlock(word, text, result)}`;
  const clean = (Array.isArray(turns) ? turns : [])
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && str(m.content).trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: str(m.content, 2000) }));
  return [{ role: 'system', content: system }, ...clean];
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
