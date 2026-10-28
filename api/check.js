// Serverless function (Vercel) that sends the learner's sentences to DeepSeek
// and returns structured corrections. The API key never reaches the browser.
//
// Environment variables:
//   DEEPSEEK_API_KEY  (required)  your DeepSeek key
//   APP_PASSPHRASE    (required)  shared secret the page must send
//   DEEPSEEK_MODEL    (optional)  defaults to "deepseek-chat"
//   MOCK=1            (optional)  return a canned answer without calling DeepSeek

const SYSTEM_PROMPT = `You are an expert Mandarin Chinese teacher reviewing sentences written by an intermediate learner who is practising one specific new vocabulary word. Be accurate and thorough, but do not invent problems: if a sentence is correct and natural, report no errors.

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

const TYPES = new Set(['target_word', 'grammar', 'naturalness']);

function str(v, max = 2000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function normalize(data) {
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

function mockResult(word, text) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(500).json({ error: 'Server is missing APP_PASSPHRASE.' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const { passphrase, word, text } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Set it in Settings.' });
  if (!word || !str(word.hanzi) || !str(text).trim()) return res.status(400).json({ error: 'Missing word or text.' });
  if (text.length > 1500) return res.status(400).json({ error: 'Text is too long (max 1500 characters).' });

  if (process.env.MOCK === '1') return res.status(200).json(normalize(mockResult(word, text)));

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });

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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 3000,
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      const msg = r.status === 401 ? 'DeepSeek rejected the API key.'
        : r.status === 402 ? 'DeepSeek account has insufficient balance.'
        : r.status === 429 ? 'DeepSeek rate limit hit; try again in a moment.'
        : `DeepSeek error ${r.status}: ${detail}`;
      return res.status(502).json({ error: msg });
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = safeJson(content);
    if (!parsed) return res.status(502).json({ error: 'The model returned an unreadable answer. Try again.' });
    return res.status(200).json(normalize(parsed));
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'DeepSeek took too long to answer. Try again.' : `Request failed: ${err?.message || err}`;
    return res.status(502).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = typeof s === 'string' && s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
