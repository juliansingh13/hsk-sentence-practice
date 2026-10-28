// Passphrase mode: checks sentences with the site owner's DeepSeek key.
// Visitors using their own key never reach this function (the browser calls DeepSeek directly).
//
// Environment variables:
//   DEEPSEEK_API_KEY  the owner's DeepSeek key
//   APP_PASSPHRASE    shared secret that unlocks the owner's key
//   DEEPSEEK_MODEL    optional, defaults to deepseek-chat
//   MOCK=1            optional, canned answers without calling DeepSeek
import { checkMessages, normalizeCheck, mockCheck, callDeepSeek, safeJson, str, DEFAULT_MODEL } from '../js/prompts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(403).json({ error: 'This site has no shared key. Add your own DeepSeek API key in Settings.' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  const { passphrase, word, text } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Check it in Settings.' });
  if (!word || !str(word.hanzi) || !str(text).trim()) return res.status(400).json({ error: 'Missing word or text.' });
  if (text.length > 1500) return res.status(400).json({ error: 'Text is too long (max 1500 characters).' });

  if (process.env.MOCK === '1') return res.status(200).json(normalizeCheck(mockCheck(word, text)));
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });

  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages: checkMessages(word, text),
      json: true,
      timeoutMs: 55000,
    });
    const parsed = safeJson(content);
    if (!parsed) return res.status(502).json({ error: 'The model returned an unreadable answer. Try again.' });
    return res.status(200).json(normalizeCheck(parsed));
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
