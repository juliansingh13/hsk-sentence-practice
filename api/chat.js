// Passphrase mode: follow-up questions using the site owner's DeepSeek key.
import { chatMessages, callDeepSeek, safeJson, DEFAULT_MODEL } from '../js/prompts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(403).json({ error: 'This site has no shared key. Add your own DeepSeek API key in Settings.' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  const { passphrase, word, text, result, messages } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Check it in Settings.' });

  const msgs = chatMessages(word, text, result, messages);
  if (msgs.length < 2 || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'No question given.' });

  if (process.env.MOCK === '1') {
    return res.status(200).json({ reply: `Mock mode: you asked “${msgs[msgs.length - 1].content}”. With a real key, DeepSeek would answer here using the corrections as context.` });
  }
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });

  try {
    const reply = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages: msgs,
      temperature: 0.4,
      maxTokens: 1500,
      timeoutMs: 55000,
    });
    return res.status(200).json({ reply: reply.trim() });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
