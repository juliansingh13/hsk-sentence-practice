import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fields = ['ankiId', 'hanzi', 'traditional', 'pinyin', 'numberedPinyin', 'meaning', 'partOfSpeech', 'audio', 'homophone', 'homograph', 'example', 'exampleTraditional', 'exampleCloze', 'exampleTraditionalCloze', 'examplePinyin', 'exampleNumberedPinyin', 'exampleTranslation', 'exampleAudio', 'exampleImage'];
function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const file = Buffer.from(content), label = Buffer.from(name), crc = crc32(file);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14); head.writeUInt32LE(file.length, 18); head.writeUInt32LE(file.length, 22); head.writeUInt16LE(label.length, 26);
    local.push(head, label, file);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(file.length, 20); dir.writeUInt32LE(file.length, 24); dir.writeUInt16LE(label.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, label);
    offset += head.length + label.length + file.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const words = req.body?.words;
  if (!Array.isArray(words) || !words.length || words.length > 5001) return res.status(400).json({ error: 'Select 1 to 5001 words.' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsk-anki-'));
  const dbPath = path.join(dir, 'collection.anki21');
  try {
    fs.copyFileSync(path.join(root, 'data', 'anki-template.sqlite'), dbPath);
    const db = new DatabaseSync(dbPath);
    const addNote = db.prepare('INSERT INTO notes (id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const addCard = db.prepare('INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let id = Date.now(), due = 1;
    for (const word of words) {
      if (!word || typeof word.hanzi !== 'string' || typeof word.meaning !== 'string' || !word.hanzi.trim() || !word.meaning.trim()) continue;
      const values = fields.map(key => String(word[key] || '').slice(0, 2000));
      values[0] = values[0].startsWith('user-') ? String(id) : values[0];
      const noteId = id++;
      const flds = values.join('\x1f');
      const csum = parseInt(crypto.createHash('sha1').update(values[0]).digest('hex').slice(0, 8), 16);
      addNote.run(noteId, crypto.randomBytes(8).toString('base64url'), 1393816261464, Math.floor(Date.now()/1000), -1, '', flds, values[0], csum, 0, '');
      addCard.run(id++, noteId, 1794899800734, 0, Math.floor(Date.now()/1000), -1, 0, 0, due++, 0, 0, 0, 0, 0, 0, 0, 0, '');
    }
    db.close();
    const packageData = zip([['collection.anki21', fs.readFileSync(dbPath)], ['media', Buffer.from('{}')]]);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="hsk-vocabulary.apkg"');
    return res.end(packageData);
  } catch (error) { return res.status(500).json({ error: error.message }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
