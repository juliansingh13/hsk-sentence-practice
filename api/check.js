// Passphrase mode: checks sentences with the site owner's DeepSeek key.
// body.mode: "vocab" (default; sentences for one deck word), "free" (any Chinese the learner wrote)
// or "explain" (explain a sentence the learner did not write).
// Visitors using their own key never reach this function (the browser calls DeepSeek directly).
//
// Environment variables:
//   DEEPSEEK_API_KEY  the owner's DeepSeek key
//   APP_PASSPHRASE    shared secret that unlocks the owner's key
//   DEEPSEEK_MODEL    optional, defaults to deepseek-chat
//   MOCK=1            optional, canned answers without calling DeepSeek
import {
  checkMessages, normalizeCheck, mockCheck,
  freeCheckMessages, normalizeFreeCheck, mockFreeCheck,
  explainMessages, normalizeExplain, mockExplain,
  cleanRegister, FREE_LIMIT, EXPLAIN_LIMIT, MEANT_LIMIT,
  callDeepSeek, safeJson, str, DEFAULT_MODEL,
} from '../js/prompts.js';

// Per mode: validate the body, then build messages / normalize / mock.
const MODES = {
  vocab: {
    validate: ({ word, text }) => (!word || !str(word.hanzi) || !str(text).trim() ? 'Missing word or text.'
      : text.length > 1500 ? 'Text is too long (max 1500 characters).' : null),
    input: ({ word, text }) => ({ word, text }),
    messages: ({ word, text }) => checkMessages(word, text),
    normalize: (data) => normalizeCheck(data),
    mock: ({ word, text }) => mockCheck(word, text),
  },
  free: {
    validate: ({ text, meant }) => (!str(text).trim() ? 'Missing text.'
      : text.length > FREE_LIMIT ? `Text is too long (max ${FREE_LIMIT} characters).`
      : meant != null && (typeof meant !== 'string' || meant.length > MEANT_LIMIT) ? `"What I meant" is too long (max ${MEANT_LIMIT} characters).` : null),
    input: ({ text, meant, register }) => ({ text, meant: str(meant, MEANT_LIMIT), register: cleanRegister(register) }),
    messages: (input) => freeCheckMessages(input),
    normalize: (data, input) => normalizeFreeCheck(data, { hasMeaning: !!input.meant.trim() }),
    mock: (input) => mockFreeCheck(input),
  },
  explain: {
    validate: ({ text }) => (!str(text).trim() ? 'Missing sentence.'
      : text.length > EXPLAIN_LIMIT ? `The sentence is too long (max ${EXPLAIN_LIMIT} characters).` : null),
    input: ({ text }) => ({ text }),
    messages: (input) => explainMessages(input),
    normalize: (data, input) => normalizeExplain(data, input),
    mock: (input) => mockExplain(input),
    maxTokens: 4000,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(403).json({ error: 'This site has no shared key. Add your own DeepSeek API key in Settings.' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  const { passphrase } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Check it in Settings.' });
  const mode = MODES[body.mode || 'vocab'];
  if (!mode) return res.status(400).json({ error: 'Unknown mode.' });
  const invalid = mode.validate(body);
  if (invalid) return res.status(400).json({ error: invalid });
  const input = mode.input(body);

  if (process.env.MOCK === '1') return res.status(200).json(mode.normalize(mode.mock(input), input));
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });

  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages: mode.messages(input),
      json: true,
      ...(mode.maxTokens ? { maxTokens: mode.maxTokens } : {}),
      timeoutMs: 55000,
    });
    const parsed = safeJson(content);
    if (!parsed) return res.status(502).json({ error: 'The model returned an unreadable answer. Try again.' });
    return res.status(200).json(mode.normalize(parsed, input));
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
