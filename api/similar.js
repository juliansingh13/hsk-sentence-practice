import { callDeepSeek, safeJson, str, DEFAULT_MODEL } from '../js/prompts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  if (!process.env.APP_PASSPHRASE || body.passphrase !== process.env.APP_PASSPHRASE) return res.status(401).json({ error: 'Wrong passphrase.' });
  const pick = word => ({ hanzi: str(word?.hanzi, 40), pinyin: str(word?.pinyin, 80), meaning: str(word?.meaning, 300), example: str(word?.example, 300) });
  const first = pick(body.first), second = pick(body.second);
  if (!first.hanzi || !second.hanzi) return res.status(400).json({ error: 'Two words are required.' });
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });
  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You are a Mandarin teacher. Explain the practical usage distinction between two Chinese words in one concise English sentence. Mention when to use each word. Use the supplied meanings and examples as context. If the distinction is uncertain, say so. Return plain text only.' },
        { role: 'user', content: JSON.stringify({ first, second }) },
      ], maxTokens: 130, timeoutMs: 55000,
    });
    return res.status(200).json({ content: str(content, 500).trim() });
  } catch (error) { return res.status(502).json({ error: error.message }); }
}
