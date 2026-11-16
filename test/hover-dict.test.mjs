import test from 'node:test';
import assert from 'node:assert/strict';
import { segment } from '../js/hover-dict.js';
import { joinPinyin } from '../js/pinyin.js';

const words = new Set(['抽烟', '每天', '天天', '为什么', '什么', '大学', '大学生', '学生']);
const isWord = (w) => words.has(w);

test('finds the longest word containing the hovered character', () => {
  assert.equal(segment('他每天都抽烟', 5, isWord).word, '抽烟');   // 烟
  assert.equal(segment('他每天都抽烟', 4, isWord).word, '抽烟');   // 抽
  assert.equal(segment('为什么不能', 2, isWord).word, '为什么');   // 么: 为什么 beats 什么
  assert.equal(segment('我是大学生', 3, isWord).word, '大学生');
});

test('prefers the earlier start for equal-length matches, falls back to the character', () => {
  assert.equal(segment('每天天', 1, isWord).word, '每天');
  assert.equal(segment('我很好', 1, isWord).word, '很');
});

test('joins pinyin syllables with apostrophes where needed', () => {
  assert.equal(joinPinyin(['Xī', 'ān']), "Xī'ān");
  assert.equal(joinPinyin(['chōu', 'yān']), 'chōuyān');
  assert.equal(joinPinyin(['tiān', 'ān', 'mén']), "tiān'ānmén");
});
