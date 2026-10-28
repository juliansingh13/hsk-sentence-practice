// Follow-up chat about a correction. Same env vars as check.js.

const MAX_TURNS = 20;

function str(v, max = 4000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.APP_PASSPHRASE;
  if (!expected) return res.status(500).json({ error: 'Server is missing APP_PASSPHRASE.' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { passphrase, word, text, result, messages } = body;
  if (passphrase !== expected) return res.status(401).json({ error: 'Wrong passphrase. Set it in Settings.' });

  const turns = (Array.isArray(messages) ? messages : [])
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && str(m.content).trim())
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: str(m.content, 2000) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') return res.status(400).json({ error: 'No question given.' });

  if (process.env.MOCK === '1') {
    return res.status(200).json({ reply: `Mock mode: you asked “${turns[turns.length - 1].content}”. With a real key, DeepSeek would answer here using the corrections as context.` });
  }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY.' });

  const system = `You are a patient, precise Mandarin Chinese tutor. The learner has just written practice sentences with a new vocabulary word and received the corrections below. Answer their follow-up questions about these sentences, the corrections, the target word, or related grammar and usage.

Guidelines:
- Answer in English. Write Chinese in simplified characters and add pinyin for words or examples the learner may not know.
- Be concise: usually a short paragraph, plus 1–3 example sentences (with pinyin and translation) when they help.
- If a correction given earlier was wrong or debatable, say so plainly and explain.
- If the learner proposes a new sentence, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Context:
${contextBlock(word, text, result)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...turns],
        temperature: 0.4,
        max_tokens: 1500,
      }),
    });
    if (!r.ok) {
      const msg = r.status === 401 ? 'DeepSeek rejected the API key.'
        : r.status === 402 ? 'DeepSeek account has insufficient balance.'
        : r.status === 429 ? 'DeepSeek rate limit hit; try again in a moment.'
        : `DeepSeek error ${r.status}: ${(await r.text()).slice(0, 300)}`;
      return res.status(502).json({ error: msg });
    }
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'Empty answer from DeepSeek. Try again.' });
    return res.status(200).json({ reply });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'DeepSeek took too long to answer. Try again.' : `Request failed: ${err?.message || err}`;
    return res.status(502).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
}
