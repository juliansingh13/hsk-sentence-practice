import { inflateRawSync, zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let dir;
  try {
    const archive = Buffer.from(req.body?.file || '', 'base64');
    if (!archive.length || archive.length > 25_000_000) throw new Error('Package must be smaller than 25 MB.');
    let offset = 0, collection, modern;
    while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
      const method = archive.readUInt16LE(offset + 8);
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
      const start = offset + 30 + nameLength + extraLength;
      if (start + size > archive.length) throw new Error('Damaged Anki package.');
      if (name === 'collection.anki21' || name === 'collection.anki2' || name === 'collection.anki21b') {
        const data = method === 0 ? archive.subarray(start, start + size) : method === 8 ? inflateRawSync(archive.subarray(start, start + size)) : null;
        if (name === 'collection.anki21b') modern = data;
        else if (data?.subarray(0, 16).toString() === 'SQLite format 3\0') collection = data;
      }
      offset = start + size;
    }
    if (modern) collection = zstdDecompressSync(modern);
    if (!collection) throw new Error('Could not read the Anki collection.');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsk-import-'));
    const file = path.join(dir, 'collection.sqlite');
    fs.writeFileSync(file, collection);
    const db = new DatabaseSync(file, { readOnly: true });
    const notes = db.prepare('SELECT mid, flds FROM notes').all();
    let models = {};
    try { models = JSON.parse(db.prepare('SELECT models FROM col').get().models); } catch {}
    db.close();
    const groups = new Map();
    for (const { mid, flds } of notes) {
      if (!groups.has(mid)) groups.set(mid, { names: models[mid]?.flds?.map(field => field.name) || [], rows: [] });
      groups.get(mid).rows.push(flds.split('\x1f').map(value => value.replace(/<[^>]*>/g, '').trim()));
    }
    const largest = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length)[0];
    const rows = largest?.rows || [];
    if (!rows.length) throw new Error('The Anki package contains no notes.');
    return res.json({ rows, names: largest.names });
  } catch (error) { return res.status(400).json({ error: error.message }); }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}
