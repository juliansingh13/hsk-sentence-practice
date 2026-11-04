// Prompts for the grammar section, shared by the browser (own-key mode) and api/grammar.js (passphrase mode).
import { str, normalizeCheck } from './prompts.js';

const structLine = (s) => `${str(s?.p, 60)} (${str(s?.py, 80)}): ${(Array.isArray(s?.m) ? s.m : []).map(x => str(x, 120)).join('; ')}${s?.note ? `. Note: ${str(s.note, 400)}` : ''}`;

export const GRAMMAR_CHECK_SYSTEM_PROMPT = `You are an expert Mandarin Chinese teacher. An intermediate learner (around HSK 4–5) is practising one specific grammar structure and has written one or more sentences. Be accurate and thorough, but do not invent problems: if a sentence is correct and natural, report no errors.

You receive the target structure (with its meanings and usage notes), the task the learner was given, and the learner's text.

Instructions:
1. Split the learner's text into sentences. In "original", copy each sentence exactly as written.
2. Find every error and classify it:
   - "target_word": anything about the TARGET STRUCTURE: wrong pairing of its parts (e.g. 只有……就), wrong position (e.g. 就 before the subject), wrong meaning or logic (e.g. 既然 used as "although"), wrong register, a required part missing, or the structure not used at all.
   - "grammar": grammatical errors elsewhere in the sentence (word order, 了/过/着, measure words, 的/地/得, complements, 不/没, wrong characters, missing or extra words).
   - "naturalness": grammatical, but a native speaker would not say it this way.
   For translation tasks, if the Chinese does not say what the English says, report it as "grammar" and start the explanation with "Meaning:". Using a different but correct structure is not an error, but mention it in target_word_feedback.
   If the task included an extra constraint (e.g. "different subjects in each clause"), say in target_word_feedback whether it was met; do not count it as an error.
3. "span": the shortest EXACT substring of "original" containing the problem. If something is missing, use the characters next to the gap.
4. "suggestion": what should replace the span. "explanation": 1–3 sentences in English that teach the rule. Give pinyin for any Chinese word you introduce.
5. "corrected": the minimally corrected sentence. "natural": how a native speaker would most naturally say it (may equal "corrected").
6. "target_word_used": true if the sentence uses the target structure correctly or incorrectly, false if it does not use it at all.

Respond with a single JSON object only:
{
  "sentences": [
    { "original": "string", "target_word_used": true,
      "errors": [ { "type": "target_word | grammar | naturalness", "span": "string", "suggestion": "string", "explanation": "string" } ],
      "corrected": "string", "natural": "string" }
  ],
  "target_word_feedback": "1–3 sentences on how the learner used the structure, plus one practical tip (a common pitfall or a contrast with a similar structure).",
  "overall": "One short, neutral summary sentence."
}`;

// task: { mode: 'write' | 'translate', constraint?, meaning?, en?, ref? }
export function grammarCheckMessages(structure, task, text) {
  const lines = [`Target structure: ${structLine(structure)}`, ''];
  if (task?.mode === 'translate') {
    lines.push('Task: translate this English sentence into Chinese, ideally using the target structure.');
    lines.push(`English: ${str(task.en, 400)}`);
    if (task.ref) lines.push(`Reference translation (one possible answer, not the only one): ${str(task.ref, 400)}`);
  } else {
    lines.push('Task: write sentences that use the target structure.');
    if (task?.meaning) lines.push(`Meaning to practise: ${str(task.meaning, 200)}`);
    if (task?.constraint) lines.push(`Extra constraint: ${str(task.constraint, 200)}`);
  }
  lines.push('', "Learner's text:", str(text, 1500).trim());
  return [
    { role: 'system', content: GRAMMAR_CHECK_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

export { normalizeCheck };

// ---------- question generation ----------

export const GENERATE_SYSTEM_PROMPT = `You write grammar exercises for an intermediate learner of Mandarin (HSK 4–5). Every exercise must be correct, natural Chinese in simplified characters, with HSK 4–5 vocabulary. The exercises must not be obvious: the learner should have to understand the meaning and the pairing rules, not just spot a keyword.

Exercise types:
- "choice": a sentence with blanks written as "__" (two underscores). Give exactly 4 options. An option fills every blank; for two blanks write it as "A……B" (e.g. "只有……才"). Exactly ONE option may produce an acceptable sentence. Build distractors from: the confusable structures listed, mismatched pairs (只有……就, 即使……但是), and words that look plausible but violate meaning or logic. Check every distractor: if a native speaker could accept it, replace it. Use context (the rest of the sentence) to rule out the near-miss, and sometimes leave one part of the structure visible so the learner must infer the other.
- "judge": 3 or 4 complete sentences, exactly ONE correct. The others contain one realistic learner error each, related to the target structure: wrong position of 就/才/都/却/并, mismatched pair, missing required part, wrong particle. Optionally give "prompt" if the question is about meaning (e.g. "Which sentence means …?"), otherwise omit it.
- "order": a sentence split into exactly 3 clauses (no final punctuation, no commas at the ends) whose order is uniquely determined by connectors and references. Give the clauses in the correct order.
- "translate": an English sentence that is most naturally translated with the target structure, plus a reference Chinese translation.

For every exercise give "structure" (the id of the target structure), "en" (an English translation of the correct sentence; for translate this is the prompt), and "why" (1–2 sentences in English explaining the answer and why the main distractor fails; for translate explain the key choice). Vary topics, subjects and sentence length. Do not repeat the example sentences you were given.

Respond with JSON only:
{ "items": [
  { "type": "choice", "structure": "id", "question": "…__…", "options": ["…","…","…","…"], "answer": 0, "why": "…", "en": "…" },
  { "type": "judge", "structure": "id", "prompt": "optional", "options": ["…","…","…"], "answer": 1, "why": "…", "en": "…" },
  { "type": "order", "structure": "id", "parts": ["…","…","…"], "why": "…", "en": "…" },
  { "type": "translate", "structure": "id", "en": "…", "ref": "…", "why": "…" }
] }`;

// structures: [{id,p,py,m,note,cf}], confusables: map id -> pattern, avoid: array of sentences already in the bank
export function generateMessages(structures, types, count, confusables = {}, avoid = []) {
  const lines = ['Target structures:'];
  for (const s of structures.slice(0, 8)) {
    const cf = (s.cf || []).map(id => confusables[id]).filter(Boolean);
    lines.push(`- id "${str(s.id, 30)}": ${structLine(s)}${cf.length ? ` Confusable with: ${cf.join(', ')}.` : ''}`);
  }
  lines.push('', `Write ${count} exercises in total, spread over these structures, using these types: ${types.join(', ')}.`);
  if (avoid.length) lines.push('', 'Already in the bank (do not reuse these sentences):', ...avoid.slice(0, 20).map(a => `- ${str(a, 120)}`));
  return [
    { role: 'system', content: GENERATE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

const BLANK_RE = /__+|＿+|_{1,}|（\s*）|\(\s*\)/g;

// Turn the model's output into bank items, dropping anything malformed.
export function normalizeGenerated(data, validIds) {
  const ids = new Set(validIds);
  const out = [];
  const raw = Array.isArray(data?.items) ? data.items.slice(0, 40) : [];
  for (const it of raw) {
    const s = str(it?.structure, 40);
    if (!ids.has(s)) continue;
    const why = str(it?.why, 600);
    const en = str(it?.en, 400);
    if (it?.type === 'choice') {
      const q = str(it.question, 300).replace(BLANK_RE, '__');
      const blanks = (q.match(/__/g) || []).length;
      const opts = (Array.isArray(it.options) ? it.options : []).map(o => str(Array.isArray(o) ? o.join('……') : o, 60).trim());
      const a = Number.isInteger(it.answer) ? it.answer : -1;
      if (!blanks || blanks > 3 || opts.length < 3 || opts.length > 5 || a < 0 || a >= opts.length) continue;
      if (new Set(opts).size !== opts.length) continue;
      if (!opts.every(o => splitOption(o).length === blanks)) continue;
      out.push({ s, t: 'choice', q, o: [opts[a], ...opts.filter((_, i) => i !== a)], w: why, en });
    } else if (it?.type === 'judge') {
      const opts = (Array.isArray(it.options) ? it.options : []).map(o => str(o, 200).trim()).filter(Boolean);
      const a = Number.isInteger(it.answer) ? it.answer : -1;
      if (opts.length < 3 || opts.length > 4 || a < 0 || a >= opts.length || new Set(opts).size !== opts.length) continue;
      out.push({ s, t: 'judge', ...(it.prompt ? { p: str(it.prompt, 200) } : {}), o: [opts[a], ...opts.filter((_, i) => i !== a)], w: why, en });
    } else if (it?.type === 'order') {
      const parts = (Array.isArray(it.parts) ? it.parts : []).map(p => str(p, 120).trim().replace(/[，,。.！!？?；;]+$/, '')).filter(Boolean);
      if (parts.length !== 3 || new Set(parts).size !== 3) continue;
      out.push({ s, t: 'order', parts, w: why, en });
    } else if (it?.type === 'translate') {
      const ref = str(it.ref, 300).trim();
      if (!en || !ref) continue;
      out.push({ s, t: 'translate', en, ref, w: why });
    }
  }
  return out;
}

export function splitOption(o) {
  return String(o).split(/……|…|\.\.\.+/).map(x => x.trim());
}

// ---------- follow-up questions ----------

export function grammarChatMessages(structure, context, turns) {
  const system = `You are a patient, precise Mandarin Chinese tutor. The learner (around HSK 4–5) is practising the grammar structure below and has just done an exercise. Answer their follow-up questions about the exercise, the structure, or similar structures.

Guidelines:
- Answer in English. Write Chinese in simplified characters, and give pinyin for any example sentence.
- Be concise: usually a short paragraph, plus 1–3 example sentences (Chinese, pinyin, English) when they help.
- If the exercise or the earlier feedback was wrong or debatable (for example a distractor that is actually acceptable), say so plainly.
- If the learner proposes a new sentence, check it and point out any errors.
- Plain text only; you may use **bold** and simple "- " lists.

Target structure: ${structLine(structure)}

Exercise and feedback so far:
${str(context, 6000)}`;
  const clean = (Array.isArray(turns) ? turns : [])
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && str(m.content).trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: str(m.content, 2000) }));
  return [{ role: 'system', content: system }, ...clean];
}

// Plain-text description of a checked writing attempt, used as chat context.
export function checkContext(task, text, result) {
  const lines = [];
  if (task?.mode === 'translate') lines.push(`Task: translate "${str(task.en, 400)}"${task.ref ? ` (reference: ${str(task.ref, 300)})` : ''}`);
  else lines.push(`Task: write sentences with the structure${task?.meaning ? `, meaning "${str(task.meaning, 200)}"` : ''}${task?.constraint ? `. Constraint: ${str(task.constraint, 200)}` : ''}`);
  lines.push('', "Learner's text:", str(text, 1500), '', 'Corrections given:');
  for (const s of (Array.isArray(result?.sentences) ? result.sentences : []).slice(0, 20)) {
    lines.push(`• ${str(s.original, 300)}`);
    const errs = Array.isArray(s.errors) ? s.errors : [];
    if (!errs.length) lines.push('  No errors.');
    errs.slice(0, 10).forEach((e, i) => lines.push(`  ${i + 1}. [${str(e.type, 20)}] "${str(e.span, 100)}" → "${str(e.suggestion, 150)}": ${str(e.explanation, 500)}`));
    if (s.corrected && s.corrected !== s.original) lines.push(`  Corrected: ${str(s.corrected, 300)}`);
    if (s.natural && s.natural !== s.corrected) lines.push(`  Natural: ${str(s.natural, 300)}`);
  }
  if (result?.target_word_feedback) lines.push('', `Structure feedback: ${str(result.target_word_feedback, 800)}`);
  return lines.join('\n');
}

export function mockGrammarCheck(text) {
  const parts = String(text).split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  return {
    sentences: parts.map((p, i) => ({
      original: p, target_word_used: true,
      errors: i === 0 && p.length > 3 ? [{ type: 'target_word', span: p.slice(0, 2), suggestion: '（示例）', explanation: 'Mock mode: sample structure error.' }] : [],
      corrected: p, natural: p,
    })),
    target_word_feedback: 'Mock mode is on (MOCK=1), so no real checking happened.',
    overall: 'Mock response.',
  };
}
