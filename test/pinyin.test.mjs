import test from 'node:test';
import assert from 'node:assert/strict';
import { toneNumbersToMarks } from '../js/pinyin.js';

test('converts numbered pinyin to tone marks', () => {
  assert.equal(toneNumbersToMarks('ni3 hao3'), 'nǐ hǎo');
  assert.equal(toneNumbersToMarks('Zhong1guo2'), 'Zhōngguó');
  assert.equal(toneNumbersToMarks('nv3 lü4'), 'nǚ lǜ');
});

test('leaves marked and neutral-tone pinyin unchanged', () => {
  assert.equal(toneNumbersToMarks('nǐ hǎo'), 'nǐ hǎo');
  assert.equal(toneNumbersToMarks('ma5'), 'ma');
});
