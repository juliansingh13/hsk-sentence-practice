// Passphrase mode for the grammar section: checks sentences, answers follow-up questions and writes
// new exercises with the site owner's DeepSeek key. The prompts are built here, not taken from the client.
import { callDeepSeek, safeJson, str, DEFAULT_MODEL } from '../js/prompts.js';
import { grammarCheckMessages, grammarChatMessages, generateMessages, mockGrammarCheck } from '../js/grammar-prompts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(403).json({ error: 'This site has no shared key. Add your own DeepSeek API key in Settings.' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  const { passphrase, action, structure } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Check it in Settings.' });

  let messages, opts = {};
  if (action === 'check') {
    if (!structure?.p || !str(body.text).trim()) return res.status(400).json({ error: 'Missing structure or text.' });
    if (body.text.length > 1500) return res.status(400).json({ error: 'Text is too long (max 1500 characters).' });
    messages = grammarCheckMessages(structure, body.task || {}, body.text);
    opts = { json: true };
    if (process.env.MOCK === '1') return res.status(200).json({ content: JSON.stringify(mockGrammarCheck(body.text)) });
  } else if (action === 'chat') {
    messages = grammarChatMessages(structure, str(body.context, 6000), body.messages);
    if (messages.length < 2 || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'No question given.' });
    opts = { temperature: 0.4, maxTokens: 1500 };
    if (process.env.MOCK === '1') return res.status(200).json({ content: 'Mock mode: DeepSeek would answer here.' });
  } else if (action === 'generate') {
    const structures = Array.isArray(body.structures) ? body.structures.slice(0, 8) : [];
    const types = (Array.isArray(body.types) ? body.types : []).filter(t => ['choice', 'judge', 'order', 'translate'].includes(t));
    if (!structures.length || !types.length) return res.status(400).json({ error: 'Nothing to generate.' });
    const count = Math.min(12, Math.max(1, body.count | 0 || 8));
    messages = generateMessages(structures, types, count, body.confusables || {}, Array.isArray(body.avoid) ? body.avoid : []);
    opts = { json: true, temperature: 0.8, maxTokens: 4000 };
    if (process.env.MOCK === '1') return res.status(200).json({ content: JSON.stringify({ items: [] }) });
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }

  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });
  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages, ...opts, timeoutMs: 55000,
    });
    return res.status(200).json({ content });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
