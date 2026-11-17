import { callDeepSeek, safeJson, str, DEFAULT_MODEL } from '../js/prompts.js';
import { vocabMessages, normalizeVocab } from '../js/vocab.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  if (!process.env.APP_PASSPHRASE || body.passphrase !== process.env.APP_PASSPHRASE) return res.status(401).json({ error: 'Wrong passphrase.' });
  const text = str(body.text, 100).trim();
  if (!text || text.length > 40) return res.status(400).json({ error: 'Select a word or short phrase (up to 40 characters).' });
  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL, json: true,
      messages: vocabMessages(text), maxTokens: 700, timeoutMs: 55000,
    });
    return res.status(200).json(normalizeVocab(safeJson(content), text));
  } catch (error) { return res.status(502).json({ error: error.message }); }
}

