import { callDeepSeek, safeJson, str, DEFAULT_MODEL } from '../js/prompts.js';
import { storyMessages } from '../js/story-prompt.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? (safeJson(req.body) || {}) : (req.body || {});
  if (!process.env.APP_PASSPHRASE || body.passphrase !== process.env.APP_PASSPHRASE) return res.status(401).json({ error: 'Wrong passphrase.' });
  const words = (Array.isArray(body.words) ? body.words : []).slice(0, 30).map(w => ({ hanzi: str(w?.hanzi, 40), pinyin: str(w?.pinyin, 80), meaning: str(w?.meaning, 200) })).filter(w => w.hanzi);
  const length = ['short', 'medium', 'long'].includes(body.length) ? body.length : 'medium';
  const level = Math.min(6, Math.max(1, Number(body.level) || 4));
  const previousStory = str(body.previousStory, 3000);
  const grammar = (Array.isArray(body.grammar) ? body.grammar : []).slice(0, 12).map(g => ({ pattern: str(g?.pattern, 100), meaning: str(g?.meaning, 160) })).filter(g => g.pattern);
  const characterMode = body.characterMode === true;
  if (!words.length) return res.status(400).json({ error: 'No daily words supplied.' });
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });
  try {
    const content = await callDeepSeek({
      key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      messages: storyMessages({ words, length, hskLevel: level, previousStory, grammar, characterMode }), json: true, temperature: 0.9, maxTokens: 2400, timeoutMs: 55000,
    });
    return res.status(200).json({ content: str(content, 6000).trim() });
  } catch (error) { return res.status(502).json({ error: error.message }); }
}
