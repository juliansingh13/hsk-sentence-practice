import fs from 'node:fs';
import { parseAnkiExport, guessMapping, buildWords } from '../js/anki.js';
import { highlightHtml } from '../js/highlight.js';
const p = parseAnkiExport(fs.readFileSync(new URL('./sample.txt', import.meta.url), 'utf8'));
console.log(p.columns);
const m = guessMapping(p); console.log(m);
console.log(buildWords(p.rows, m));
// plain csv without headers
const p2 = parseAnkiExport('学习,xué xí,to study,我每天学习中文。\n朋友,péng you,friend,他是我的好朋友。\n');
console.log(guessMapping(p2), buildWords(p2.rows, guessMapping(p2))[0]);
console.log(highlightHtml('我安排了明天去北京。', [{type:'target_word',span:'安排了'},{type:'grammar',span:'去北京'},{type:'naturalness',span:'不存在'}], [1,2,3]));
