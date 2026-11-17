"""Extract the bundled Anki collection to a browser-friendly, ordered JSON list."""
import ctypes
from datetime import datetime, timezone
import html
import json
import re
import sqlite3
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'HSK_1-6_english_chinese.apkg'
TARGET = ROOT / 'data' / 'vocab.json'
lib = ctypes.CDLL(r'C:\Program Files\Git\mingw64\bin\libzstd.dll')
lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
lib.ZSTD_decompress.restype = ctypes.c_size_t

def clean(value):
    value = re.sub(r'\[sound:[^]]*\]|<img[^>]*>', '', value)
    value = re.sub(r'<\s*br\s*/?>|</(?:div|p)>', ' ', value, flags=re.I)
    return html.unescape(re.sub(r'<[^>]*>', '', value)).strip()

with zipfile.ZipFile(SOURCE) as package:
    compressed = package.read('collection.anki21b')
    buffer = ctypes.create_string_buffer(30_000_000)
    size = lib.ZSTD_decompress(buffer, len(buffer), compressed, len(compressed))
    if size > len(buffer):
        raise RuntimeError('Anki collection could not be decompressed')
    with tempfile.TemporaryDirectory() as directory:
        database = Path(directory) / 'collection.sqlite'
        database.write_bytes(buffer.raw[:size])
        connection = sqlite3.connect(database)
        rows = connection.execute('SELECT id, flds FROM notes').fetchall()
        connection.close()

fields = ['ankiId', 'hanzi', 'traditional', 'pinyin', 'numberedPinyin', 'meaning',
          'partOfSpeech', 'audio', 'homophone', 'homograph', 'example',
          'exampleTraditional', 'exampleCloze', 'exampleTraditionalCloze',
          'examplePinyin', 'exampleNumberedPinyin', 'exampleTranslation',
          'exampleAudio', 'exampleImage']
words = []
for note_id, raw in rows:
    values = raw.split('\x1f')
    if len(values) != len(fields):
        raise ValueError(f'Unexpected field count for note {note_id}')
    word = dict(zip(fields, (clean(value) for value in values)))
    word['noteId'] = str(note_id)
    word['origin'] = 'HSK'
    word['dateAdded'] = datetime.fromtimestamp(note_id / 1000, timezone.utc).date().isoformat()
    if not word['ankiId'] or not word['hanzi'] or not word['meaning']:
        raise ValueError(f'Missing required field for note {note_id}')
    words.append(word)
words.sort(key=lambda word: int(word['ankiId']))
TARGET.write_text(json.dumps(words, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'Wrote {len(words)} words to {TARGET}')
