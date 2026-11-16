import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFreeCheck, normalizeExplain, freeCheckMessages, explainMessages, chatMessages, mockFreeCheck, mockExplain,
} from '../js/prompts.js';
import { renderResult, renderExplain } from '../js/render.js';

test('normalizeFreeCheck keeps the four types and drops "meaning" without an intended meaning', () => {
  const data = {
    sentences: [{ original: '我很高兴认识他。', errors: [
      { type: 'meaning', span: '认识', suggestion: '见到', explanation: 'x' },
      { type: 'target_word', span: '高兴', suggestion: '开心', explanation: 'y' },
      { type: 'bogus', span: '很', suggestion: '', explanation: 'z' },
      { type: 'word_choice', span: '他', suggestion: '她', explanation: 'w' },
    ] }, { original: '' }],
    meaning_feedback: 'feedback',
  };
  const without = normalizeFreeCheck(data);
  assert.deepEqual(without.sentences[0].errors.map(e => e.type), ['grammar', 'word_choice', 'grammar', 'word_choice']);
  assert.equal(without.meaning_feedback, '');
  assert.equal(without.sentences.length, 1, 'empty sentences dropped');
  const withMeaning = normalizeFreeCheck(data, { hasMeaning: true });
  assert.equal(withMeaning.sentences[0].errors[0].type, 'meaning');
  assert.equal(withMeaning.meaning_feedback, 'feedback');
  assert.ok(!('target_word_used' in withMeaning.sentences[0]));
});

test('normalizeFreeCheck clamps sizes and survives garbage', () => {
  assert.deepEqual(normalizeFreeCheck(null), { sentences: [], meaning_feedback: '', overall: '' });
  const big = normalizeFreeCheck({ sentences: Array.from({ length: 50 }, () => ({ original: '好', errors: Array.from({ length: 40 }, () => ({ type: 'grammar', explanation: 'e'.repeat(5000) })) })) });
  assert.equal(big.sentences.length, 30);
  assert.equal(big.sentences[0].errors.length, 20);
  assert.equal(big.sentences[0].errors[0].explanation.length, 1200);
});

test('normalizeExplain validates the structure', () => {
  const x = normalizeExplain({
    pinyin: 'Nǐ hǎo.', translation: 'Hello.',
    words: [{ word: '你好', pinyin: 'nǐhǎo', meaning: 'hello', role: 'greeting' }, { word: '' }, 'junk'],
    grammar: [{ pattern: 'P', explanation: 'E', example: { zh: '你好吗？' } }, {}],
    notes: ['n', 5, ''],
    error_note: 7,
  }, { text: ' 你好。 ' });
  assert.equal(x.sentence, '你好。', 'falls back to the input text');
  assert.equal(x.words.length, 1);
  assert.equal(x.grammar.length, 1);
  assert.deepEqual(x.grammar[0].example, { zh: '你好吗？', pinyin: '', en: '' });
  assert.deepEqual(x.notes, ['n']);
  assert.equal(x.error_note, '');
});

test('message builders use json-ready prompts and pass meaning and register', () => {
  const m = freeCheckMessages({ text: '我好。', meant: 'I am fine', register: 'weird' });
  assert.match(m[0].content, /"meaning_feedback"/);
  assert.match(m[1].content, /Register: neutral/);
  assert.match(m[1].content, /I am fine/);
  assert.match(freeCheckMessages({ text: '我好。', meant: '' })[1].content, /do not use the "meaning" type/);
  assert.match(explainMessages({ text: '你好。' })[1].content, /你好。/);
});

test('chatMessages builds a context per mode', () => {
  const free = mockFreeCheck({ text: '我昨天去商店买东西很多。', meant: 'I bought a lot yesterday' });
  const f = chatMessages(null, '我昨天去商店买东西很多。', free, [{ role: 'user', content: '为什么？' }], { mode: 'free', meant: 'I bought a lot yesterday', register: 'casual' });
  assert.match(f[0].content, /wrote some Chinese of their own/);
  assert.match(f[0].content, /Register the learner is aiming for: casual/);
  assert.match(f[0].content, /\[word_choice\]/);
  assert.equal(f.at(-1).content, '为什么？');
  const ex = mockExplain({ text: '我们明天见吧。' });
  const e = chatMessages(null, '我们明天见吧。', ex, [{ role: 'user', content: '吧？' }], { mode: 'explain' });
  assert.match(e[0].content, /did not write/);
  assert.match(e[0].content, /Word-by-word breakdown:\n- 我们/);
  const v = chatMessages({ hanzi: '抽烟' }, '我抽烟。', { sentences: [] }, [{ role: 'user', content: 'q' }]);
  assert.match(v[0].content, /Target word: 抽烟/);
});

test('free results render word choice and meaning without the "not used" badge', () => {
  const r = normalizeFreeCheck(mockFreeCheck({ text: '我昨天去了商店买东西很多。', meant: 'x' }), { hasMeaning: true });
  const html = renderResult(r, { mode: 'free' });
  assert.match(html, /class="l-wc">Word choice/);
  assert.match(html, /class="l-mean">Meaning/);
  assert.match(html, /mark class="err err-meaning"/);
  assert.match(html, /tw-feedback fb-mean/);
  assert.doesNotMatch(html, /not used/);
  const noMeaning = renderResult(normalizeFreeCheck(mockFreeCheck({ text: '我昨天去了商店买东西很多。' })), { mode: 'free' });
  assert.doesNotMatch(noMeaning, /l-mean/);
});

test('renderExplain escapes model output', () => {
  const html = renderExplain(normalizeExplain({ sentence: '<b>你</b>', words: [{ word: '<i>', pinyin: '', meaning: '', role: '' }], notes: ['**ok** <img>'] }));
  assert.doesNotMatch(html, /<b>你|<i>|<img>/);
  assert.match(html, /<strong>ok<\/strong> &lt;img&gt;/);
});
